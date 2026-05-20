/**
 * Live API end-to-end sweep — runs against the local API server on :8080.
 *
 * Picks a diverse subset of demo programs, POSTs to /parse → /emit → /build
 * for both targets, records pass/fail + timing per fixture per target.
 * Writes a JSON report.
 *
 * Run: `bun run tests/live-api-sweep.ts`
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API = process.env.ANVIL_API ?? "http://localhost:8080";
const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");

// Diverse subset spanning 11 feature categories.
const SUBSET: { name: string; category: string }[] = [
  // Basic PDA / state
  { name: "counter", category: "basic-pda" },
  { name: "has-one", category: "basic-pda" },
  { name: "bumps-access", category: "basic-pda" },
  // Lifecycle
  { name: "close-account", category: "lifecycle" },
  { name: "init-if-needed", category: "lifecycle" },
  { name: "realloc", category: "lifecycle" },
  // SPL Token
  { name: "spl-transfer", category: "spl" },
  { name: "vault", category: "spl" },
  { name: "ata-mint", category: "spl" },
  // Token-2022 extensions
  { name: "t22-transfer-fee-init", category: "t22-ext" },
  { name: "t22-default-account-state", category: "t22-ext" },
  { name: "t22-metadata-pointer", category: "t22-ext" },
  { name: "t22-transfer-hook", category: "t22-ext" },
  // Metaplex Token Metadata
  { name: "mpl-create-metadata", category: "mpl-tm" },
  { name: "mpl-freeze-thaw", category: "mpl-tm" },
  { name: "mpl-sign-metadata", category: "mpl-tm" },
  // Metaplex Core
  { name: "mpl-core-create-v2", category: "mpl-core" },
  { name: "mpl-core-transfer-v1", category: "mpl-core" },
  { name: "mpl-core-add-plugin-v1", category: "mpl-core" },
  // Oracles
  { name: "pyth-read-modern", category: "oracle" },
  { name: "switchboard-read", category: "oracle" },
  // DeFi
  { name: "amm", category: "defi" },
  { name: "marketplace", category: "defi" },
  { name: "escrow", category: "defi" },
  { name: "multisig", category: "defi" },
  // Events / logs / errors
  { name: "event-emit", category: "events" },
  { name: "msg-emit", category: "events" },
  { name: "return-err", category: "events" },
  // CPI
  { name: "cpi-custom", category: "cpi" },
  { name: "cpi-memo", category: "cpi" },
  // Sysvar / zero-copy
  { name: "sysvar-rent", category: "sysvar" },
  { name: "zero-copy-foo", category: "zero-copy" },
];

type StepResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

type FixtureResult = {
  name: string;
  category: string;
  parse: StepResult;
  emitPin: StepResult;
  emitNative: StepResult;
  buildPin: StepResult;
  buildNative: StepResult;
};

async function post(path: string, body: unknown, attempt = 0): Promise<{ ok: boolean; status: number; json: any; latencyMs: number; errorText?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - start;
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status === 429 && attempt < 3) {
      await new Promise(r => setTimeout(r, 10_000 * (attempt + 1)));
      return post(path, body, attempt + 1);
    }
    return { ok: res.ok, status: res.status, json, latencyMs, errorText: res.ok ? undefined : text };
  } catch (e) {
    return { ok: false, status: 0, json: null, latencyMs: Date.now() - start, errorText: String(e) };
  }
}

async function runFixture(f: { name: string; category: string }): Promise<FixtureResult> {
  const source = readFileSync(join(DEMO_DIR, `${f.name}.rs`), "utf8");

  // /parse
  const parsed = await post("/parse", { source });
  if (!parsed.ok || !parsed.json?.ir) {
    const failed: StepResult = { ok: false, latencyMs: 0 };
    return {
      name: f.name,
      category: f.category,
      parse: { ok: false, latencyMs: parsed.latencyMs, error: parsed.errorText?.slice(0, 300) ?? "parse failed" },
      emitPin: failed, emitNative: failed, buildPin: failed, buildNative: failed,
    };
  }
  const ir = parsed.json.ir;
  const parseResult: StepResult = { ok: true, latencyMs: parsed.latencyMs };

  // /emit pinocchio
  const emitPin = await post("/emit", { ir, target: "pinocchio", multiFile: true });
  const emitPinResult: StepResult = emitPin.ok && emitPin.json?.files
    ? { ok: true, latencyMs: emitPin.latencyMs }
    : { ok: false, latencyMs: emitPin.latencyMs, error: emitPin.errorText?.slice(0, 300) };

  // /emit native
  const emitNat = await post("/emit", { ir, target: "native", multiFile: true });
  const emitNatResult: StepResult = emitNat.ok && emitNat.json?.files
    ? { ok: true, latencyMs: emitNat.latencyMs }
    : { ok: false, latencyMs: emitNat.latencyMs, error: emitNat.errorText?.slice(0, 300) };

  // /build pinocchio
  let buildPinResult: StepResult = { ok: false, latencyMs: 0, error: "skipped — emit failed" };
  if (emitPin.ok && emitPin.json?.files) {
    const buildBody = { target: "pinocchio", files: emitPin.json.files, programName: f.name.replace(/-/g, "_") };
    const bld = await post("/build", buildBody);
    buildPinResult = bld.ok && bld.json?.ok
      ? { ok: true, latencyMs: bld.latencyMs }
      : { ok: false, latencyMs: bld.latencyMs, error: bld.json?.errors?.[0]?.message?.slice(0, 200) ?? bld.json?.stderrTail?.slice(0, 200) ?? bld.errorText?.slice(0, 200) };
  }

  // /build native
  let buildNatResult: StepResult = { ok: false, latencyMs: 0, error: "skipped — emit failed" };
  if (emitNat.ok && emitNat.json?.files) {
    const buildBody = { target: "native", files: emitNat.json.files, programName: f.name.replace(/-/g, "_") };
    const bld = await post("/build", buildBody);
    buildNatResult = bld.ok && bld.json?.ok
      ? { ok: true, latencyMs: bld.latencyMs }
      : { ok: false, latencyMs: bld.latencyMs, error: bld.json?.errors?.[0]?.message?.slice(0, 200) ?? bld.json?.stderrTail?.slice(0, 200) ?? bld.errorText?.slice(0, 200) };
  }

  return {
    name: f.name, category: f.category,
    parse: parseResult, emitPin: emitPinResult, emitNative: emitNatResult,
    buildPin: buildPinResult, buildNative: buildNatResult,
  };
}

const results: FixtureResult[] = [];
for (let i = 0; i < SUBSET.length; i++) {
  const f = SUBSET[i];
  process.stderr.write(`[live-api ${i+1}/${SUBSET.length}] ${f.category}/${f.name} ... `);
  const r = await runFixture(f);
  results.push(r);
  const symbol = (s: StepResult) => s.ok ? "Y" : "N";
  process.stderr.write(`parse=${symbol(r.parse)} emitPin=${symbol(r.emitPin)} emitNat=${symbol(r.emitNative)} buildPin=${symbol(r.buildPin)} buildNat=${symbol(r.buildNative)}\n`);
  // pace requests under default RATE_LIMIT=60/min
  if (i < SUBSET.length - 1) await new Promise(r => setTimeout(r, 2500));
}

const outPath = join(import.meta.dir, "..", "..", "reports", "live-api-sweep.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
process.stderr.write(`[live-api] report → ${outPath}\n`);
