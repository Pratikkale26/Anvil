/**
 * POST /evidence — map an IR's program shape to the corpus of fixtures
 * with byte-equal proof for that shape.
 *
 * Workbench surface: a "tested-against" badge that says "your program
 * uses Token-Interface + init constraints — Anvil has byte-equal proof
 * for this shape via anchor-escrow-2025." Honest about what's verified
 * vs what's just cargo-green vs what's untested.
 *
 * Detection signals (per IR):
 *   - tokenInterface: any Account/Interface<Token{Account,Interface}>
 *     usage in instruction accounts
 *   - splCpiKinds: which cpi_spl_* kinds appear in body statements
 *   - initConstraints: how many accounts have init / zero / init_if_needed
 *   - emit / emit_cpi: events used
 *   - msg / set_return_data: log surfaces used
 *   - rich state: Vec<T> / Option<T> / nested-struct fields in
 *     ir.accounts[*].fields
 *
 * Match a signal set against the known-fixture-shapes catalog. Return
 * the matching fixtures + a confidence score per signal.
 *
 * Pure synthesis — no toolchain, no cost.
 */
import { Router } from "express";
import { SolanaIRSchema } from "../ir/schema.js";
import { AnvilError, ErrorCode } from "../errors.js";

export const evidenceRoute = Router();

// ─── Fixture corpus catalog ─────────────────────────────────────────────────
//
// Each entry is one byte-equal-verified fixture in the test corpus.
// `shape` is the program-shape signal set this fixture exercises;
// the request's IR gets matched against these.

interface FixtureEvidence {
  /** Display name (workbench badge label). */
  name: string;
  /** Source URL or "demo" for hand-written corpus programs. */
  source: string;
  /** Compare surfaces this fixture verifies byte-equal on. */
  surfaces: Array<"data" | "lamports" | "owner" | "eventLogs" | "msgLogs" | "returnData">;
  /** Shape signals this fixture covers. */
  shape: ProgramShape;
  /** Brief one-line description shown in the badge tooltip. */
  description: string;
}

interface ProgramShape {
  initConstraints?: boolean;
  zeroConstraint?: boolean;
  splCpiKinds?: string[];
  tokenInterface?: boolean;
  associatedTokenInit?: boolean;
  events?: boolean;
  msgLogs?: boolean;
  returnData?: boolean;
  richState?: boolean; // Vec<T> / Option<T> / nested
  setInner?: boolean;
  helperCpi?: boolean;
}

const CORPUS: FixtureEvidence[] = [
  {
    name: "counter",
    source: "demo",
    surfaces: ["data", "lamports", "owner"],
    shape: { initConstraints: true },
    description: "Simplest init flow: PDA init + u64 state mutation. No SPL, no signer seeds, no CPI.",
  },
  {
    name: "anchor-escrow-2025/make_offer",
    source: "https://github.com/mikemaccana/anchor-escrow-2025",
    surfaces: ["data", "lamports", "owner"],
    shape: {
      initConstraints: true,
      tokenInterface: true,
      associatedTokenInit: true,
      splCpiKinds: ["cpi_spl_transfer"],
      setInner: true,
      helperCpi: true,
    },
    description:
      "Real Anchor 0.31. init+associated_token, Token-Interface (runtime program-ID dispatch), set_inner state init, transfer_tokens helper-fn inlined.",
  },
  {
    name: "coral-events/initialize+test_event",
    source: "https://github.com/coral-xyz/anchor (tests/events)",
    surfaces: ["eventLogs"],
    shape: { events: true },
    description: "emit!() event-log payload byte-equal on a real public Anchor program.",
  },
  {
    name: "msg-emit",
    source: "demo",
    surfaces: ["msgLogs"],
    shape: { msgLogs: true },
    description: "msg!() user-emitted log line byte-equal (pure-literal subset).",
  },
  {
    name: "return-data",
    source: "demo",
    surfaces: ["returnData"],
    shape: { returnData: true },
    description: "set_return_data() byte-equal.",
  },
  {
    name: "vault",
    source: "demo",
    surfaces: ["data", "lamports", "owner"],
    shape: { initConstraints: true, splCpiKinds: ["cpi_system_transfer"] },
    description: "PDA-as-vault with system_program::transfer signed by program-derived seeds.",
  },
  {
    name: "spl-transfer / spl-burn / ata-mint / set-authority / t22-transfer",
    source: "demo",
    surfaces: ["data", "lamports", "owner"],
    shape: {
      splCpiKinds: ["cpi_spl_transfer", "cpi_spl_burn", "cpi_spl_mint_to", "cpi_spl_set_authority", "cpi_ata_create"],
    },
    description: "Demo coverage for every cpi_spl_* IR kind.",
  },
  {
    name: "multisig",
    source: "demo",
    surfaces: ["data", "lamports", "owner"],
    shape: { initConstraints: true, richState: true },
    description: "n-of-m multisig with Vec<Pubkey> + Vec<bool> rich state.",
  },
  {
    name: "event-emit",
    source: "demo",
    surfaces: ["data", "eventLogs"],
    shape: { events: true },
    description: "emit!() with multi-field events — discriminator + borsh payload byte-equal.",
  },
];

// ─── Shape detection from IR ────────────────────────────────────────────────

function detectShape(ir: unknown): ProgramShape {
  const parsed = SolanaIRSchema.safeParse(ir);
  if (!parsed.success) return {};
  const irData = parsed.data;

  const splCpiKinds = new Set<string>();
  let initConstraints = false;
  let zeroConstraint = false;
  let tokenInterface = false;
  let associatedTokenInit = false;
  let events = irData.events.length > 0;
  let msgLogs = false;
  let returnData = false;
  let setInner = false;

  for (const ix of irData.instructions) {
    for (const acc of ix.accounts) {
      for (const c of acc.constraints) {
        if (c.kind === "init") initConstraints = true;
        if (c.kind === "init_if_needed") initConstraints = true;
        if (c.kind === "zero") zeroConstraint = true;
        if (c.kind === "associated_token::mint" || c.kind === "associated_token::authority") {
          associatedTokenInit = true;
        }
      }
      if (/InterfaceAccount|TokenInterface|Interface\s*<.*Token/.test(acc.accountType)) {
        tokenInterface = true;
      }
    }
    for (const stmt of ix.body) {
      if (stmt.kind.startsWith("cpi_spl_")) splCpiKinds.add(stmt.kind);
      if (stmt.kind === "msg") msgLogs = true;
      if (stmt.kind === "emit") events = true;
      if (stmt.kind === "pass_through" && /\bset_return_data\s*\(/.test(stmt.code)) returnData = true;
      if (stmt.kind === "pass_through" && /\.set_inner\s*\(/.test(stmt.code)) setInner = true;
    }
  }

  // Rich state: any Vec<T>/Option<T>/<CustomType> field in any AccountDef.
  const richState = irData.accounts.some((a) =>
    a.fields.some((f) => /^Vec<|^Option<|^\[/.test(f.type)
      || (!/^([ui])(8|16|32|64|128)$|^bool$|^Pubkey$|^String$/.test(f.type))),
  );

  // Helper-CPI shape: any pass_through that calls a function ending in "_tokens"/_transfer.
  const helperCpi = irData.instructions.some((ix) =>
    ix.body.some((s) => s.kind === "pass_through"
      && /\b(transfer_tokens|move_tokens|do_transfer|send_tokens)\s*\(/.test(s.code)),
  );

  return {
    initConstraints,
    zeroConstraint,
    splCpiKinds: splCpiKinds.size > 0 ? [...splCpiKinds] : undefined,
    tokenInterface,
    associatedTokenInit,
    events,
    msgLogs,
    returnData,
    setInner,
    richState,
    helperCpi,
  };
}

// ─── Fixture matching ───────────────────────────────────────────────────────

function matchScore(target: ProgramShape, fixture: ProgramShape): { ratio: number; matchedSignals: number } {
  let matched = 0;
  let total = 0;
  const keys: Array<keyof ProgramShape> = [
    "initConstraints", "zeroConstraint", "tokenInterface",
    "associatedTokenInit", "events", "msgLogs", "returnData",
    "setInner", "richState", "helperCpi",
  ];
  for (const k of keys) {
    if (fixture[k]) {
      total++;
      if (target[k]) matched++;
    }
  }
  if (fixture.splCpiKinds && fixture.splCpiKinds.length > 0) {
    total++;
    const overlap = (target.splCpiKinds ?? []).filter((k) => fixture.splCpiKinds!.includes(k));
    if (overlap.length > 0) matched++;
  }
  return { ratio: total === 0 ? 0 : matched / total, matchedSignals: matched };
}

evidenceRoute.post("/", (req, res) => {
  const ir = (req.body as { ir?: unknown })?.ir;
  if (!ir) {
    res.status(400).json(
      new AnvilError(ErrorCode.VALIDATION_FAILED, "Missing required field: ir", undefined, 400).toJSON(),
    );
    return;
  }
  const shape = detectShape(ir);

  const ranked = CORPUS
    .map((f) => {
      const m = matchScore(shape, f.shape);
      return { fixture: f, ratio: m.ratio, matched: m.matchedSignals };
    })
    .filter((r) => r.ratio > 0)
    // Sort by raw matched-signal count first (more overlap = better),
    // then ratio as a tiebreak (a 5-of-5 match is stronger than a
    // 5-of-7). Counter (1 signal) scores ratio=1 trivially; the right
    // pick for an SPL/init/event-rich target is the fixture that
    // matches the most signals AT high ratio.
    .sort((a, b) => b.matched - a.matched || b.ratio - a.ratio);

  const top = ranked.slice(0, 3);
  const allSurfaces = new Set<string>();
  for (const r of top) for (const s of r.fixture.surfaces) allSurfaces.add(s);

  res.json({
    detectedShape: shape,
    matchedFixtures: top.map((r) => ({
      name: r.fixture.name,
      source: r.fixture.source,
      surfaces: r.fixture.surfaces,
      description: r.fixture.description,
      matchScore: Math.round(r.ratio * 100),
      matchedSignals: r.matched,
    })),
    coveredSurfaces: [...allSurfaces],
    /** Honest summary line for the workbench badge tooltip. */
    summary:
      top.length === 0
        ? "Your program shape doesn't match any fixture in Anvil's byte-equal corpus. Cargo-build correctness is verified; runtime byte-equality is unproven."
        : `Anvil has byte-equal proof for ${top.length} fixture${top.length === 1 ? "" : "s"} matching your program shape: ${top.map((r) => r.fixture.name).join("; ")}. Surfaces verified: ${[...allSurfaces].join(", ")}.`,
  });
});
