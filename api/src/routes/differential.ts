/**
 * POST /build/differential — workbench byte-equal verification endpoint.
 *
 * Body:
 *   {
 *     anchorSource: string,            // raw Anchor source
 *     anvilEmittedFiles: EmitterFile[], // output of /emit
 *     anvilScaffoldFiles: EmitterFile[],
 *     ir: SolanaIR,                    // for arg/account type info
 *     scenario: Scenario,              // ScenarioSchema
 *     programName: string,
 *     anchorExtraDeps?: string,
 *     anchorLangFeatures?: string[],
 *     programIdBase58?: string,
 *   }
 *
 * Response: SSE stream when ?stream=1, otherwise JSON.
 *   event: build-start    { phase, programName }
 *   event: build-log      { line }
 *   event: build-done     { cacheState, durationMs }
 *   event: scenario-start { target }
 *   event: scenario-done  { target, stepCount }
 *   event: comparing      {}
 *   event: done           { verdict, ... }   // ScenarioVerdict shape
 *   event: error          { message }
 */
import { Router } from "express";
import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { AnvilError, ErrorCode } from "../errors.js";
import { ScenarioSchema, lintScenario } from "../ir/scenario.js";
import { SolanaIRSchema } from "../ir/schema.js";
import { buildBothSos, differentialAvailable } from "../build/differential-build.js";
import { buildProjectScaffold } from "../emitter/project-scaffold.js";

type ScaffoldTarget = "pinocchio" | "native";
import {
  resolveScenarioContext,
  runScenarioOnSo,
  compareScenarioRuns,
} from "../build/scenario-runner.js";
import { consumeQuota, quotaSnapshotAsync } from "../build/differential-quota.js";

export const differentialRoute = Router();

const FileSchema = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(2_000_000),
});

const RequestSchema = z.object({
  anchorSource: z.string().min(1).max(5_000_000),
  anvilEmittedFiles: z.array(FileSchema).min(1).max(64),
  // Optional: workbench /emit doesn't return scaffold (Cargo.toml etc.) by
  // default. When omitted or empty, the server synthesises scaffold from IR
  // using `target` (defaults to pinocchio).
  anvilScaffoldFiles: z.array(FileSchema).max(64).optional(),
  target: z.enum(["pinocchio", "native"]).optional(),
  ir: z.unknown(),
  scenario: z.unknown(),
  programName: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/),
  anchorExtraDeps: z.string().max(50_000).optional(),
  anchorLangFeatures: z.array(z.string().max(64)).max(16).optional(),
  programIdBase58: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
});

/** GET /build/differential/quota — caller's remaining quota. */
differentialRoute.get("/quota", async (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  // Async snapshot for accurate cross-instance counts via Redis.
  const snap = await quotaSnapshotAsync(ip);
  res.json({
    available: differentialAvailable(),
    ...snap,
  });
});

/**
 * POST /build/differential/auto-scenario
 *   body: { ir: SolanaIR }
 *   returns: { ok: true, scenario, notes[] } | { ok: false, blockers[] }
 *
 * Pure synthesis -- no toolchain, no quota consumption. Workbench
 * pre-fetches this when the user clicks "Generate scenario" so they
 * see the synthesised form before paying compute on a real verify run.
 */
import { synthesizeAutoScenario } from "../cli/auto-scenario.js";

const AutoScenarioRequest = z.object({ ir: z.unknown() });

differentialRoute.post("/auto-scenario", (req, res) => {
  const parsed = AutoScenarioRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(new AnvilError(ErrorCode.VALIDATION_FAILED, "Invalid auto-scenario request", parsed.error.message, 400).toJSON());
    return;
  }
  const irParsed = SolanaIRSchema.safeParse(parsed.data.ir);
  if (!irParsed.success) {
    res.status(422).json(new AnvilError(ErrorCode.INVALID_IR, "Invalid IR", irParsed.error.message, 422).toJSON());
    return;
  }
  const result = synthesizeAutoScenario(irParsed.data);
  res.json(result);
});

differentialRoute.post("/", async (req, res) => {
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

  // (1) Toolchain probe — fail fast if cargo-build-sbf / anchor missing.
  if (!differentialAvailable()) {
    res.status(422).json(
      new AnvilError(
        ErrorCode.VALIDATION_FAILED,
        "Differential testing unavailable on this deploy: cargo-build-sbf or anchor CLI not on PATH. Install the Solana platform tools + Anchor CLI.",
        undefined,
        422,
      ).toJSON(),
    );
    return;
  }

  // (2) Body validation.
  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(
      new AnvilError(ErrorCode.VALIDATION_FAILED, "Invalid /build/differential body", parsed.error.message, 400).toJSON(),
    );
    return;
  }

  const irParsed = SolanaIRSchema.safeParse(parsed.data.ir);
  if (!irParsed.success) {
    res.status(422).json(
      new AnvilError(ErrorCode.INVALID_IR, "Invalid IR", irParsed.error.message, 422).toJSON(),
    );
    return;
  }
  const ir = irParsed.data;

  const scenarioParsed = ScenarioSchema.safeParse(parsed.data.scenario);
  if (!scenarioParsed.success) {
    res.status(422).json(
      new AnvilError(ErrorCode.VALIDATION_FAILED, "Invalid scenario", scenarioParsed.error.message, 422).toJSON(),
    );
    return;
  }
  const scenario = scenarioParsed.data;

  // (3) Pre-flight scenario lint — catches authoring errors before paying compute.
  const lintIssues = lintScenario(scenario);
  const lintErrors = lintIssues.filter((i) => i.severity === "error");
  if (lintErrors.length > 0) {
    res.status(422).json({
      error: "Scenario lint failed",
      code: ErrorCode.VALIDATION_FAILED,
      lintIssues,
    });
    return;
  }

  // (4) Quota check + consume. Async for Redis path -- multi-instance
  // deploys converge on the same per-IP counter via Redis INCR.
  const quota = await consumeQuota(ip);
  if (!quota.allowed) {
    res.status(429).setHeader("Retry-After", String(quota.resetInSec)).json({
      error: quota.reason ?? "Differential quota exhausted.",
      code: ErrorCode.RATE_LIMITED,
      quota,
    });
    return;
  }

  // (5) Resolve programId. Default to scenario.programId; fall back to IR's
  //     declared id; fall back to a derived placeholder.
  let programId: PublicKey;
  try {
    programId = new PublicKey(
      parsed.data.programIdBase58
        ?? scenario.programId
        ?? ir.programId
        ?? "11111111111111111111111111111111",
    );
  } catch (err) {
    res.status(400).json(
      new AnvilError(ErrorCode.VALIDATION_FAILED, "Invalid programId base58", String(err), 400).toJSON(),
    );
    return;
  }

  // (6) SSE setup if requested.
  const wantsStream = req.query.stream === "1" || req.query.stream === "true";
  const cancelHandle: { current: { cancel: () => void } | null } = { current: null };

  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === "function") {
      (res as { flushHeaders: () => void }).flushHeaders();
    }
    res.on("close", () => {
      if (!res.writableEnded) cancelHandle.current?.cancel();
    });
  }

  const emit = (event: string, payload: unknown) => {
    if (!wantsStream) return;
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // (6.5) Resolve scaffold. Workbench /emit only returns .rs source files,
  // so the client can either omit `anvilScaffoldFiles` or send `[]`. In that
  // case synthesise a Cargo.toml + project scaffold from the IR using the
  // requested `target` (defaults to pinocchio, matching the workbench's
  // default emit target).
  const sentScaffold = parsed.data.anvilScaffoldFiles ?? [];
  const scaffoldTarget: ScaffoldTarget = parsed.data.target ?? "pinocchio";
  const anvilScaffoldFiles =
    sentScaffold.length > 0
      ? sentScaffold
      : buildProjectScaffold(ir, scaffoldTarget);

  const t0 = Date.now();
  try {
    // (7) Build both .so files.
    emit("build-start", { phase: "building both .so files", programName: parsed.data.programName });
    const artifacts = await buildBothSos({
      anchorSource: parsed.data.anchorSource,
      anvilEmittedFiles: parsed.data.anvilEmittedFiles,
      anvilScaffoldFiles,
      anchorExtraDeps: parsed.data.anchorExtraDeps,
      anchorLangFeatures: parsed.data.anchorLangFeatures,
      programName: parsed.data.programName,
      ir,
      onLog: (line) => emit("build-log", { line }),
      cancelHandle,
    });
    emit("build-done", { cacheState: artifacts.cacheState, durationMs: Date.now() - t0 });

    // (8) Resolve scenario context (signers + PDAs) -- shared across both runs.
    const ctx = resolveScenarioContext(scenario, programId);

    // (9) Run scenario on Anchor reference .so.
    emit("scenario-start", { target: "anchor" });
    const anchorSo = readFileSync(artifacts.anchorSoPath);
    const anchorRun = runScenarioOnSo(scenario, ir, anchorSo, ctx);
    emit("scenario-done", { target: "anchor", stepCount: anchorRun.steps.length });

    // (10) Run scenario on Anvil emitted .so.
    emit("scenario-start", { target: "anvil" });
    const anvilSo = readFileSync(artifacts.anvilSoPath);
    const anvilRun = runScenarioOnSo(scenario, ir, anvilSo, ctx);
    emit("scenario-done", { target: "anvil", stepCount: anvilRun.steps.length });

    // (11) Compare + assemble verdict.
    emit("comparing", {});
    const verdict = compareScenarioRuns(scenario, ir, anchorRun, anvilRun, Date.now() - t0);

    const response = {
      ...verdict,
      cacheState: artifacts.cacheState,
      lintWarnings: lintIssues.filter((i) => i.severity === "warning"),
      quota,
    };

    if (wantsStream) {
      emit("done", response);
      if (!res.writableEnded) res.end();
    } else {
      res.json(response);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (wantsStream) {
      emit("error", { message });
      if (!res.writableEnded) res.end();
    } else {
      res.status(500).json(
        new AnvilError(ErrorCode.INTERNAL_ERROR, "differential failed", message, 500).toJSON(),
      );
    }
  }
});
