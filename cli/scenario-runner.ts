/**
 * JSON-scenario differential runner — executes a user-supplied instruction
 * sequence against both Anchor and Anvil-Pinocchio .so binaries in LiteSVM,
 * then byte-compares specified accounts.
 *
 * Design: this lives in the CLI package so `anvil-sol differential <input>
 * --scenario X.json` is the single command surface. Heavy deps (litesvm,
 * @solana/web3.js, @solana/spl-token, @noble/hashes) are imported lazily
 * via dynamic import so users who only run `anvil compile` aren't paying
 * for them on install. If a dep is missing, the runner prints an
 * actionable `npm install` line instead of a stack trace.
 *
 * Scenario JSON schema (see schemaHelp() for the canonical shape):
 *
 *   {
 *     "programId": "Counter111111111111111111111111111111111111",
 *     "signers":   [{"name": "authority", "airdrop": 1000000000}],
 *     "pdas":      [{"name": "counter_pda", "seeds": ["counter", "$authority.pubkey"]}],
 *     "instructions": [
 *       {
 *         "ix": "initialize",
 *         "args": {"amount": 10},
 *         "accounts": ["counter_pda", "authority", "system_program"]
 *       }
 *     ],
 *     "compare": [
 *       {"name": "counter_pda", "stripDiscriminator": true}
 *     ]
 *   }
 *
 * Args are encoded by inspecting the parsed IR's argument types — the user
 * supplies values, the runner emits Borsh bytes the program expects. Account
 * lists are name lookups against `signers` / `pdas` plus a small set of
 * built-in program IDs (system_program, token_program, etc.).
 *
 * Refuses to run on patterns it can't safely encode (bytes/Vec/custom struct
 * args). The user can hand-write a TS fixture against
 * api/tests/differential-harness.ts for those.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname as nodeDirname } from "node:path";
import type { SolanaIR, Instruction, Arg } from "../api/src/ir/schema.js";

// ─── Lazy peer-dep loader ────────────────────────────────────────────────────

interface RuntimeDeps {
  LiteSVM: any;
  Keypair: any;
  PublicKey: any;
  Transaction: any;
  TransactionInstruction: any;
  SystemProgram: any;
  sha256: (b: Uint8Array) => Uint8Array;
}

async function loadRuntimeDeps(): Promise<RuntimeDeps> {
  // Dynamic import so users who never invoke `differential --scenario`
  // never pull these into their install. If any are missing we synthesize
  // a single "install these" message rather than the cryptic
  // "Cannot find package 'litesvm'" the default Node error gives.
  const required = ["litesvm", "@solana/web3.js", "@noble/hashes"] as const;
  const missing: string[] = [];
  let litesvmMod: any = null;
  let web3Mod: any = null;
  let hashesMod: any = null;
  try {
    litesvmMod = await import("litesvm");
  } catch { missing.push("litesvm"); }
  try {
    web3Mod = await import("@solana/web3.js");
  } catch { missing.push("@solana/web3.js"); }
  try {
    // @ts-ignore — peer dep loaded lazily
    hashesMod = await import("@noble/hashes/sha2.js");
  } catch { missing.push("@noble/hashes"); }

  if (missing.length > 0) {
    const list = missing.join(" ");
    throw new Error(
      `Differential scenario runner needs these peer dependencies:\n\n` +
      `  ${list}\n\n` +
      `Install with:\n\n` +
      `  npm install --save-dev ${list}\n\n` +
      `(or use 'bun add', 'pnpm add', etc.)`
    );
  }

  return {
    LiteSVM: litesvmMod.LiteSVM,
    Keypair: web3Mod.Keypair,
    PublicKey: web3Mod.PublicKey,
    Transaction: web3Mod.Transaction,
    TransactionInstruction: web3Mod.TransactionInstruction,
    SystemProgram: web3Mod.SystemProgram,
    sha256: hashesMod.sha256,
  };
}

// ─── Scenario JSON shape ─────────────────────────────────────────────────────

export interface ScenarioSigner {
  name: string;
  /** Lamports to airdrop in setup. Default 1 SOL. */
  airdrop?: number;
}

export interface ScenarioPda {
  name: string;
  /**
   * Seed list. Each entry is one of:
   *   - a string literal: `"counter"` → `b"counter"` bytes
   *   - a substitution token: `"$authority.pubkey"` → that signer's pubkey bytes
   *   - a substitution token: `"$mint.pubkey"`
   * No raw byte arrays today; common cases only.
   */
  seeds: string[];
}

export interface ScenarioInstruction {
  /** Instruction name as it appears in the parsed IR. */
  ix: string;
  /** Arg-name → value. Only primitive args (uN/iN/bool/Pubkey) supported. */
  args?: Record<string, number | string | boolean>;
  /**
   * Account list, in the order Anchor's #[derive(Accounts)] declares.
   * Each entry is a name lookup: `"authority"` → the signer named authority,
   * `"counter_pda"` → that PDA, or one of the built-in keys
   * (system_program, token_program, associated_token_program,
   * token_2022_program, rent, clock).
   */
  accounts: string[];
  /**
   * P3.2 — Optional per-position AccountMeta flag overrides. Map of
   * account-position index (0-based, matching `accounts`) to flag
   * strips. Only `false` strips are honored; setting a flag to true
   * via this field is silently ignored (granting privilege the IR
   * didn't declare would require a Keypair we don't have). Used by
   * `--fuzz-flags` to catch transpiler bugs where Anvil's emit
   * silently loosens an Anchor-side constraint (e.g. a slot whose
   * `Signer<'info>` check the Anvil emit forgot to replicate).
   */
  accountFlagStrips?: Record<number, { isSigner?: boolean; isWritable?: boolean }>;
}

export interface ScenarioCompareSpec {
  name: string;
  /** Default true. Set false for raw token accounts (no Anchor disc). */
  stripDiscriminator?: boolean;
  /** Default true. Set false when lamports are expected to vary across runs. */
  compareLamports?: boolean;
  /**
   * Default true. Compare the account OWNER (program). #2 — parity with the
   * test harness (differential-harness.ts): data + lamports can byte-equal
   * while Anvil's emit silently (re)assigned the account to a DIFFERENT
   * program — a real authority/fund bug class the harness already catches but
   * the shipped CLI runner did not. Set false only when the account
   * intentionally changes owner mid-scenario.
   */
  compareOwner?: boolean;
}

export interface DifferentialScenario {
  programId: string;
  signers: ScenarioSigner[];
  pdas?: ScenarioPda[];
  instructions: ScenarioInstruction[];
  compare: ScenarioCompareSpec[];
  /** Default 1_700_000_000 (2023-11-14) — pinned across both runs. */
  pinClockTimestamp?: number;
  /** Default 1. Pinned across both runs. */
  pinClockSlot?: number;
}

// ─── Built-in account map ────────────────────────────────────────────────────

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const RENT_SYSVAR_ID = "SysvarRent111111111111111111111111111111111";
const CLOCK_SYSVAR_ID = "SysvarC1ock11111111111111111111111111111111";

const BUILTIN_PUBKEYS: Record<string, string> = {
  system_program: SYSTEM_PROGRAM_ID,
  token_program: TOKEN_PROGRAM_ID,
  token_2022_program: TOKEN_2022_PROGRAM_ID,
  associated_token_program: ATA_PROGRAM_ID,
  rent: RENT_SYSVAR_ID,
  clock: CLOCK_SYSVAR_ID,
};

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface ScenarioRunResult {
  ok: boolean;
  /** Per-account compare result, in the same order as scenario.compare. */
  results: Array<
    | { name: string; ok: true }
    | { name: string; ok: false; kind: "data" | "lamports" | "owner" | "missing" | "events" | "returnData" | "msgLogs"; details: string }
  >;
  durationMs: number;
  /** Per-instruction compute units consumed by each program, when captureCu was set. */
  cu?: { anchor: number[]; anvil: number[] };
}

export async function runScenarioDifferential(args: {
  scenario: DifferentialScenario;
  anchorSo: Buffer;
  anvilSo: Buffer;
  ir: SolanaIR;
  /** When true, capture + byte-compare `Program data:` lines (sol_log_data). */
  compareEventLogs?: boolean;
  /** When true, capture + byte-compare set_return_data() bytes per tx. */
  compareReturnData?: boolean;
  /** When true, capture + byte-compare user msg!() lines (Anchor framing stripped). */
  compareMsgLogs?: boolean;
  /**
   * P3.2 — when true, transaction-level errors are absorbed and the
   * byte-compare proceeds against the unchanged state. Set by
   * `--fuzz-flags` iterations where intentional flag-strips are
   * expected to trigger program-side rejections.
   */
  softFailOnTxError?: boolean;
  /** When true, capture computeUnitsConsumed() per tx for both programs (bench --against). */
  captureCu?: boolean;
}): Promise<ScenarioRunResult> {
  const t0 = Date.now();
  const deps = await loadRuntimeDeps();
  const programId = new deps.PublicKey(args.scenario.programId);

  // Build the resolved-key table: signer keypairs (deterministic from name +
  // scenario program id so re-runs use the same keys), PDA derivations, and
  // the built-in pubkeys. Identical across both Anchor and Anvil scenarios
  // — this is what makes byte-equal compare meaningful.
  const ctx = buildScenarioContext(args.scenario, programId, deps);

  const captureEvents = args.compareEventLogs ?? false;
  const captureReturn = args.compareReturnData ?? false;
  const captureMsg = args.compareMsgLogs ?? false;
  const anchorEvents: string[] = [];
  const anvilEvents: string[] = [];
  const anchorReturn: Array<string | null> = [];
  const anvilReturn: Array<string | null> = [];
  const anchorMsg: string[] = [];
  const anvilMsg: string[] = [];
  const captureCu = args.captureCu ?? false;
  const anchorCu: number[] = [];
  const anvilCu: number[] = [];
  const softFail = args.softFailOnTxError ?? false;
  const anchorState = await runOneScenario(
    args.scenario, args.anchorSo, programId, ctx, args.ir, deps,
    captureEvents ? anchorEvents : undefined,
    captureReturn ? anchorReturn : undefined,
    captureMsg ? anchorMsg : undefined,
    softFail,
    captureCu ? anchorCu : undefined,
  );
  const anvilState = await runOneScenario(
    args.scenario, args.anvilSo, programId, ctx, args.ir, deps,
    captureEvents ? anvilEvents : undefined,
    captureReturn ? anvilReturn : undefined,
    captureMsg ? anvilMsg : undefined,
    softFail,
    captureCu ? anvilCu : undefined,
  );

  const results: ScenarioRunResult["results"] = [];
  for (const spec of args.scenario.compare) {
    const stripDisc = spec.stripDiscriminator ?? true;
    const compareLamports = spec.compareLamports ?? true;
    const pubkey = ctx.resolveKey(spec.name);
    const a = anchorState.get(pubkey.toBase58());
    const v = anvilState.get(pubkey.toBase58());
    // Both missing = byte-equal (both runs closed/garbage-collected the
    // account — happens for `close = X` constraints where the account
    // is fully reaped). Mirrors the harness behavior.
    if (!a && !v) {
      results.push({ name: spec.name, ok: true });
      continue;
    }
    // Asymmetric — one side reaped, the other live. Real divergence.
    if (!a || !v) {
      results.push({
        name: spec.name,
        ok: false,
        kind: "missing",
        details: `presence diverges: anchor=${!!a} anvil=${!!v}`,
      });
      continue;
    }
    let aData = a.data;
    let vData = v.data;
    if (stripDisc) {
      aData = aData.length >= 8 ? aData.subarray(8) : aData;
      vData = vData.length >= 8 ? vData.subarray(8) : vData;
    }
    if (!aData.equals(vData)) {
      const minLen = Math.min(aData.length, vData.length);
      let diffByte = minLen;
      for (let i = 0; i < minLen; i++) {
        if (aData[i] !== vData[i]) { diffByte = i; break; }
      }
      results.push({
        name: spec.name,
        ok: false,
        kind: "data",
        details: `data diverges at byte ${diffByte}/${minLen}; anchor=${aData.length}B anvil=${vData.length}B`,
      });
      continue;
    }
    if (compareLamports && a.lamports !== v.lamports) {
      results.push({
        name: spec.name,
        ok: false,
        kind: "lamports",
        details: `lamports diverge: anchor=${a.lamports} anvil=${v.lamports} (delta ${v.lamports - a.lamports})`,
      });
      continue;
    }
    // #2 — owner (program) parity with the test harness. data + lamports equal
    // but owner diverged ⇒ Anvil silently reassigned the account to a different
    // program (an authority/fund bug class). The shipped CLI verdict must catch
    // this too, not just the in-repo differential suite.
    const compareOwner = spec.compareOwner ?? true;
    if (compareOwner && a.owner !== v.owner) {
      results.push({
        name: spec.name,
        ok: false,
        kind: "owner",
        details: `owner diverges: anchor=${a.owner} anvil=${v.owner}`,
      });
      continue;
    }
    results.push({ name: spec.name, ok: true });
  }

  // Per-tx surface compares. Each surface lives outside per-account state
  // — events, return data, msg!() lines all flow through tx metadata.
  // Surface a single result entry per surface so the report stays terse.
  if (captureEvents) {
    if (anchorEvents.length !== anvilEvents.length ||
        anchorEvents.some((l, i) => l !== anvilEvents[i])) {
      results.push({
        name: "<event-logs>", ok: false, kind: "events",
        details: `event log lines diverge — anchor=${anchorEvents.length}, anvil=${anvilEvents.length}; first diff at idx ${anchorEvents.findIndex((l, i) => l !== anvilEvents[i])}`,
      });
    } else {
      results.push({ name: `<event-logs> (${anchorEvents.length})`, ok: true });
    }
  }
  if (captureReturn) {
    if (anchorReturn.length !== anvilReturn.length ||
        anchorReturn.some((d, i) => d !== anvilReturn[i])) {
      results.push({
        name: "<return-data>", ok: false, kind: "returnData",
        details: `set_return_data diverges across ${anchorReturn.length}/${anvilReturn.length} txs`,
      });
    } else {
      results.push({ name: `<return-data> (${anchorReturn.length} txs)`, ok: true });
    }
  }
  if (captureMsg) {
    if (anchorMsg.length !== anvilMsg.length ||
        anchorMsg.some((l, i) => l !== anvilMsg[i])) {
      results.push({
        name: "<msg-logs>", ok: false, kind: "msgLogs",
        details: `user msg!() lines diverge — anchor=${anchorMsg.length}, anvil=${anvilMsg.length}; first diff at idx ${anchorMsg.findIndex((l, i) => l !== anvilMsg[i])}`,
      });
    } else {
      results.push({ name: `<msg-logs> (${anchorMsg.length} lines)`, ok: true });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    results,
    durationMs: Date.now() - t0,
    ...(captureCu ? { cu: { anchor: anchorCu, anvil: anvilCu } } : {}),
  };
}

interface ScenarioContext {
  signers: Map<string, any>; // Keypair
  pdas: Map<string, any>; // PublicKey
  resolveKey: (name: string) => any; // PublicKey
}

function buildScenarioContext(
  scenario: DifferentialScenario,
  programId: any,
  deps: RuntimeDeps,
): ScenarioContext {
  // Deterministic seed-from-name keypair generation. Critical: the same name
  // on both sides MUST produce the same Keypair, so byte-equal compare on
  // the resulting account state is meaningful. Use sha256(programId || name)
  // as the secret key seed; @solana/web3.js exposes Keypair.fromSeed for
  // exactly this.
  const signers = new Map<string, any>();
  for (const sig of scenario.signers) {
    const seedSrc = `signer:${scenario.programId}:${sig.name}`;
    const seedBytes = deps.sha256(new TextEncoder().encode(seedSrc));
    const kp = deps.Keypair.fromSeed(seedBytes.slice(0, 32));
    signers.set(sig.name, kp);
  }

  const pdas = new Map<string, any>();
  const pdaSpecs = scenario.pdas ?? [];
  for (const pda of pdaSpecs) {
    const seedBuffers: Buffer[] = [];
    for (const seed of pda.seeds) {
      if (seed.startsWith("$") && seed.endsWith(".pubkey")) {
        const refName = seed.slice(1, -".pubkey".length);
        const sig = signers.get(refName);
        if (!sig) throw new Error(`PDA seed references unknown signer: ${seed}`);
        seedBuffers.push(sig.publicKey.toBuffer());
      } else if (seed.startsWith("$")) {
        // PDA-references-PDA case, less common but useful for nested derivations
        const refName = seed.slice(1).replace(/\.pubkey$/, "");
        const otherPda = pdas.get(refName);
        if (!otherPda) throw new Error(`PDA seed references unknown PDA/signer: ${seed}`);
        seedBuffers.push(otherPda.toBuffer());
      } else {
        seedBuffers.push(Buffer.from(seed, "utf-8"));
      }
    }
    const [pubkey] = deps.PublicKey.findProgramAddressSync(seedBuffers, programId);
    pdas.set(pda.name, pubkey);
  }

  const resolveKey = (name: string): any => {
    if (signers.has(name)) return signers.get(name)!.publicKey;
    if (pdas.has(name)) return pdas.get(name)!;
    if (BUILTIN_PUBKEYS[name]) return new deps.PublicKey(BUILTIN_PUBKEYS[name]);
    throw new Error(`Unknown account name in scenario: '${name}' (not in signers/pdas/builtins)`);
  };

  return { signers, pdas, resolveKey };
}

interface AccountSnapshot {
  data: Buffer;
  lamports: bigint;
  /** Owner program, base58. Compared as a string across the two runs. */
  owner: string;
}

async function runOneScenario(
  scenario: DifferentialScenario,
  programSo: Buffer,
  programId: any,
  ctx: ScenarioContext,
  ir: SolanaIR,
  deps: RuntimeDeps,
  collectedEventLogs?: string[],
  collectedReturnData?: Array<string | null>,
  collectedMsgLogs?: string[],
  /**
   * P3.2 — when true, transaction-level errors are absorbed and the
   * subsequent byte-compare runs against the unchanged state. Used by
   * `--fuzz-flags`: stripping a flag is EXPECTED to cause a program-side
   * rejection on a correctly-translated emit; the byte-compare then
   * decides whether both sides rejected (state unchanged on both → pass)
   * or only one rejected (state diverges → real transpiler bug).
   *
   * Default false preserves the throwing behavior for plain --scenario
   * and plain --fuzz: callers there want a loud failure on tx error.
   */
  softFailOnTxError?: boolean,
  /** When set, push computeUnitsConsumed() per successful tx (for `bench --against`). */
  collectedCu?: number[],
): Promise<Map<string, AccountSnapshot>> {
  const svm = new deps.LiteSVM();
  svm.addProgram(programId, programSo);
  // Pin the clock + slot identically across runs so any program reading
  // Clock::get() sees the same timestamp/slot in both scenarios.
  if (typeof svm.warpToTimestamp === "function") {
    try { svm.warpToTimestamp(BigInt(scenario.pinClockTimestamp ?? 1_700_000_000)); } catch {}
  }
  if (typeof svm.warpToSlot === "function") {
    try { svm.warpToSlot(BigInt(scenario.pinClockSlot ?? 1)); } catch {}
  }

  // Airdrop signers up-front so every instruction has fee-payable balances.
  for (const sig of scenario.signers) {
    const kp = ctx.signers.get(sig.name);
    if (!kp) continue;
    svm.airdrop(kp.publicKey, BigInt(sig.airdrop ?? 1_000_000_000));
  }

  // Run each instruction. Pick the first signer as fee payer.
  const firstSigner = scenario.signers[0];
  if (!firstSigner) throw new Error("scenario.signers must contain at least one entry");
  const feePayer = ctx.signers.get(firstSigner.name)!;

  for (const ix of scenario.instructions) {
    const irInstr = ir.instructions.find((i) => i.name === ix.ix);
    if (!irInstr) throw new Error(`scenario references unknown instruction: '${ix.ix}'`);

    const data = encodeInstructionData(irInstr, ix.args ?? {}, deps);
    // Account flags come from the IR's positional entry, not from the name —
    // the user-facing name (e.g. "counter_pda") doesn't have to match the
    // Anchor source field name (e.g. "counter"). Position is the contract.
    if (ix.accounts.length !== irInstr.accounts.length) {
      throw new Error(
        `instruction '${ix.ix}' expects ${irInstr.accounts.length} accounts ` +
        `(per IR), got ${ix.accounts.length} in scenario`,
      );
    }
    const keys = ix.accounts.map((accName, idx) => {
      const pubkey = ctx.resolveKey(accName);
      const irAcct = irInstr.accounts[idx]!;
      const isBuiltin = BUILTIN_PUBKEYS[accName] != null;
      let isSigner = isBuiltin ? false : (ctx.signers.has(accName) || irAcct.isSigner);
      let isWritable = isBuiltin ? false : (irAcct.isMut || irAcct.isInit);
      // P3.2 — apply per-position flag strips when present. Only false
      // overrides are honored (see ScenarioInstruction.accountFlagStrips).
      const strip = ix.accountFlagStrips?.[idx];
      if (strip) {
        if (strip.isSigner === false) isSigner = false;
        if (strip.isWritable === false) isWritable = false;
      }
      return { pubkey, isSigner, isWritable };
    });

    const tx = new deps.Transaction().add(
      new deps.TransactionInstruction({ programId, keys, data: Buffer.from(data) }),
    );
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = feePayer.publicKey;
    // Sign with every signer referenced in this instruction, plus the fee
    // payer (which is the first signer; included if not already in the keys).
    const signersInIx = ix.accounts
      .filter((a) => ctx.signers.has(a))
      .map((a) => ctx.signers.get(a)!);
    const signerSet = new Set([feePayer, ...signersInIx]);
    tx.sign(...Array.from(signerSet));
    const r = svm.sendTransaction(tx);
    if ("err" in r) {
      // litesvm's FailedTransactionMetadata exposes `err` as a method (not
      // a property) and `logs()` similarly. Call them where present.
      if (softFailOnTxError) {
        // Continue to subsequent ixs (and snapshot) — byte-compare decides
        // whether the rejection is symmetric (state unchanged on both
        // sides → pass) or asymmetric (state diverges → real bug).
        continue;
      }
      let errStr: string;
      try {
        const errVal = typeof r.err === "function" ? r.err() : r.err;
        errStr = errVal && typeof errVal === "object"
          ? (errVal.toString?.() === "[object Object]" ? JSON.stringify(errVal) : String(errVal))
          : String(errVal);
      } catch {
        errStr = String(r.err);
      }
      let logsStr = "";
      if ("logs" in r) {
        try {
          const logs = typeof r.logs === "function" ? r.logs() : r.logs;
          if (Array.isArray(logs) && logs.length > 0) {
            logsStr = `\n  logs:\n    ${logs.join("\n    ")}`;
          }
        } catch { /* ignore */ }
      }
      throw new Error(`scenario instruction '${ix.ix}' failed: ${errStr}${logsStr}`);
    }
    // Success — capture surfaces from tx metadata when collectors set.
    if (collectedEventLogs || collectedReturnData || collectedMsgLogs || collectedCu) {
      try {
        const ctorName = (r as any)?.constructor?.name ?? "";
        let logs: string[] = [];
        let returnData: { data: () => Uint8Array } | null = null;
        if (ctorName === "TransactionMetadata") {
          const md = r as any;
          logs = typeof md.logs === "function" ? md.logs() : [];
          returnData = typeof md.returnData === "function" ? md.returnData() ?? null : null;
          if (collectedCu && typeof md.computeUnitsConsumed === "function") {
            collectedCu.push(Number(md.computeUnitsConsumed()));
          }
        }
        for (const l of logs) {
          if (collectedEventLogs && l.startsWith("Program data: ")) {
            collectedEventLogs.push(l);
          }
          if (collectedMsgLogs && l.startsWith("Program log: ")) {
            const body = l.slice("Program log: ".length);
            // Strip Anchor framing — see api/tests/differential-harness.ts.
            if (body.startsWith("Instruction: ")) continue;
            if (body.startsWith("AnchorError occurred")) continue;
            if (body === "Left:" || body === "Right:") continue;
            collectedMsgLogs.push(l);
          }
        }
        if (collectedReturnData) {
          collectedReturnData.push(returnData ? Buffer.from(returnData.data()).toString("base64") : null);
        }
      } catch { /* best-effort */ }
    }
  }

  // Snapshot every account named in compare.
  const snap = new Map<string, AccountSnapshot>();
  for (const spec of scenario.compare) {
    const pubkey = ctx.resolveKey(spec.name);
    const acct = svm.getAccount(pubkey);
    if (acct) {
      snap.set(pubkey.toBase58(), {
        data: Buffer.from(acct.data),
        lamports: BigInt(acct.lamports),
        // LiteSVM returns owner as a PublicKey here (not raw bytes); normalize
        // to base58 so both anchor/anvil snapshots compare as strings.
        owner: typeof acct.owner?.toBase58 === "function"
          ? acct.owner.toBase58()
          : new deps.PublicKey(acct.owner).toBase58(),
      });
    }
  }
  return snap;
}

/**
 * Compute the 8-byte Anchor instruction discriminator (sha256("global:<name>")[..8]).
 * Anvil-Pinocchio emits the same convention so the discriminator routing is
 * drop-in compatible.
 */
function anchorIxDiscriminator(ixName: string, sha256: (b: Uint8Array) => Uint8Array): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${ixName}`)).slice(0, 8);
}

function encodeInstructionData(
  instr: Instruction,
  values: Record<string, number | string | boolean>,
  deps: RuntimeDeps,
): Uint8Array {
  // Anchor convention: 8-byte disc + Borsh-packed args in the order they
  // appear on the handler signature.
  const parts: Uint8Array[] = [anchorIxDiscriminator(instr.name, deps.sha256)];
  for (const arg of instr.args) {
    if (!(arg.name in values)) {
      throw new Error(
        `scenario for '${instr.name}' missing arg '${arg.name}' (type ${arg.type}). ` +
        `Add it under instructions[].args.${arg.name}.`,
      );
    }
    parts.push(encodeArg(arg, values[arg.name]!, deps));
  }
  return concatBytes(parts);
}

function encodeArg(
  arg: Arg,
  value: number | string | boolean,
  deps: RuntimeDeps,
): Uint8Array {
  switch (arg.type) {
    case "u8":   return encU(BigInt(value as number), 1);
    case "u16":  return encU(BigInt(value as number), 2);
    case "u32":  return encU(BigInt(value as number), 4);
    case "u64":  return encU(BigInt(value as number), 8);
    case "u128": return encU(BigInt(value as number), 16);
    case "i8":   return encI(BigInt(value as number), 1);
    case "i16":  return encI(BigInt(value as number), 2);
    case "i32":  return encI(BigInt(value as number), 4);
    case "i64":  return encI(BigInt(value as number), 8);
    case "i128": return encI(BigInt(value as number), 16);
    case "bool": return new Uint8Array([value ? 1 : 0]);
    case "Pubkey": {
      const pk = new deps.PublicKey(value as string);
      return new Uint8Array(pk.toBuffer());
    }
    default:
      throw new Error(
        `Arg '${arg.name}' has type '${arg.type}' which the JSON scenario runner can't encode safely. ` +
        `Hand-write a TS fixture using api/tests/differential-harness.ts for this case.`,
      );
  }
}

function encU(n: bigint, bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn);
  return out;
}

function encI(n: bigint, bytes: number): Uint8Array {
  const u = n < 0n ? (1n << BigInt(bytes * 8)) + n : n;
  return encU(u, bytes);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}


// ─── Anchor .so build helpers ────────────────────────────────────────────────

/**
 * Build the original Anchor source into a standalone `.so`. Used when the
 * caller hasn't supplied --anchor-so: we wrap the source in a minimal
 * Cargo.toml and run cargo-build-sbf in a scratch dir.
 */
/**
 * Multi-version reference ladder (kept in sync with api/src/build/
 * differential-build.ts `anchorVersionLadder`; duplicated to keep the CLI
 * reference build free of the served-sandbox module graph). Try the sniffed/
 * default version first, then adjacent 0.x versions — older-first, since
 * real-world drift is usually an older program built against the newer default.
 * Anchor 1.0 is a separate ecosystem and never falls back into the 0.x line.
 */
function anchorVersionLadder(primary: string): string[] {
  if (primary === "1.0") return ["1.0"];
  const order: Record<string, string[]> = {
    "0.32": ["0.32", "0.31", "0.30"],
    "0.31": ["0.31", "0.30", "0.29"],
    "0.30": ["0.30", "0.31", "0.29"],
    "0.29": ["0.29", "0.30", "0.31"],
  };
  return order[primary] ?? ["0.31", "0.30", "0.29"];
}

/** Best-effort anchor-lang version sniff from an explicit version string in
 *  source; defaults to 0.31 (the ladder handles the fallback when wrong). */
function sniffAnchorVersion(source: string): string {
  const m = source.match(/anchor[-_]lang\s*[=:]?\s*['"`]?(0\.(?:29|30|31|32)(?:\.\d+)?)/);
  if (m?.[1]) return m[1].split(".").slice(0, 2).join(".");
  return "0.31";
}

/** Anchor cargo features the reference build must enable, sniffed from source.
 *  `init_if_needed` is the big one — without the feature, #[derive(Accounts)]
 *  silently skips the Bumps impl and the reference fails with a cryptic
 *  "trait Bumps not satisfied". Mirrors sniffAnchorLangFeatures in
 *  api/src/build/differential-build.ts. */
function sniffAnchorFeatures(source: string): string[] {
  const features: string[] = [];
  if (/\binit_if_needed\b/.test(source)) features.push("init-if-needed");
  if (/#\[event_cpi\]|\bemit_cpi!/.test(source)) features.push("event-cpi");
  if (/\bidl_build\b/.test(source)) features.push("idl-build");
  return features;
}

export function buildAnchorReferenceSo(args: {
  anchorSource: string;
  packageName: string;
  scratchDir: string;
  extraDeps?: string;
}): Buffer {
  const { anchorSource, packageName, scratchDir, extraDeps } = args;
  const features = sniffAnchorFeatures(anchorSource);
  const anchorLangDep = features.length > 0
    ? `anchor-lang = { version = "VERSION", features = ["${features.join('", "')}"] }`
    : `anchor-lang = "VERSION"`;
  const makeCargoToml = (version: string): string => `[package]
name = "${packageName}"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "${packageName}"
[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
[dependencies]
${anchorLangDep.replace("VERSION", version)}
${(extraDeps ?? "").replace(/version = "0\.31"/g, `version = "${version}"`).replace(/anchor-spl = "0\.31"/g, `anchor-spl = "${version}"`)}
`;
  // Multi-version reference build. Fetched real-world programs span anchor
  // versions and rarely declare one in a single lib.rs, so a hard pin fails the
  // REFERENCE build (deprecated APIs, Bumps trait drift, dep resolution) even
  // though the source is valid Anchor for ITS version. Try the sniffed version
  // first, then walk a small ladder, using the first that COMPILES as the
  // reference. Output is piped and only surfaced on total failure so a
  // recovered fallback stays quiet.
  const ladder = anchorVersionLadder(sniffAnchorVersion(anchorSource));
  let lastStatus: number | null = null;
  let lastOutput = "";
  for (let i = 0; i < ladder.length; i++) {
    const version = ladder[i]!;
    rmSync(scratchDir, { recursive: true, force: true });
    mkdirSync(join(scratchDir, "src"), { recursive: true });
    writeFileSync(join(scratchDir, "Cargo.toml"), makeCargoToml(version));
    writeFileSync(join(scratchDir, "src/lib.rs"), anchorSource);
    const r = spawnSync(
      "cargo-build-sbf",
      ["--manifest-path", join(scratchDir, "Cargo.toml")],
      { encoding: "utf-8", timeout: 600_000, env: { ...process.env, RUSTFLAGS: "" } },
    );
    const builtSo = join(scratchDir, "target/deploy", `${packageName}.so`);
    if (r.status === 0 && existsSync(builtSo)) {
      if (i > 0) {
        console.error(`  ↳ Anchor reference compiled against anchor-lang ${version} (fallback from ${ladder[0]})`);
      }
      return readFileSync(builtSo);
    }
    lastStatus = r.status;
    lastOutput = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (i < ladder.length - 1) {
      console.error(`  ↳ Anchor reference build failed on anchor-lang ${version}; retrying against ${ladder[i + 1]}…`);
    }
  }
  // Every ladder version failed — surface the last build's diagnostics.
  process.stderr.write(lastOutput.split("\n").slice(-40).join("\n") + "\n");
  throw new Error(
    `cargo-build-sbf (Anchor reference) failed with exit ${lastStatus} (tried anchor-lang ${ladder.join(", ")})`,
  );
}

/**
 * Find the .so that cargo-build-sbf produced inside an Anvil scratch build —
 * the file name is derived from the IR's program name (which gets normalized
 * by project-scaffold), so we just read whatever .so exists in target/deploy.
 */
export function findBuiltSo(targetDeployDir: string): Buffer {
  const entries = readdirSync(targetDeployDir).filter((f) => f.endsWith(".so"));
  if (entries.length === 0) throw new Error(`no .so found in ${targetDeployDir}`);
  return readFileSync(join(targetDeployDir, entries[0]!));
}

// ─── Fuzz support — Path B in docs/audit-trust-model.md ─────────────────────

/**
 * Deterministic LCG — same seed → same sequence. Not cryptographic; we
 * only need reproducibility (`--fuzz-seed <hex>` re-runs the exact
 * mutation sequence) and uniform-ish distribution. Constants from
 * Numerical Recipes' linear congruential.
 */
class FuzzRng {
  private state: bigint;
  constructor(seed: bigint) {
    // Mix the seed so seed=0 doesn't degenerate to all-zero state.
    this.state = (seed ^ 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  }
  /** Next u64. */
  nextU64(): bigint {
    // xorshift64 — fast, simple, decorrelates seed bits.
    let x = this.state;
    x ^= x << 13n; x &= 0xffffffffffffffffn;
    x ^= x >> 7n;
    x ^= x << 17n; x &= 0xffffffffffffffffn;
    this.state = x;
    return x;
  }
  /** Random integer in [0, max). max must fit in u53 (JS safe int). */
  nextRange(max: number): number {
    return Number(this.nextU64() % BigInt(max));
  }
  /** True with probability 1/n. */
  oneIn(n: number): boolean {
    return this.nextRange(n) === 0;
  }
}

/**
 * Mutate one scalar arg value. Biases ~30% toward boundary values
 * (0, 1, MAX, MIN) and ~70% uniformly random — boundaries catch
 * off-by-one and integer-overflow bugs that uniform random misses.
 * Pubkey args are not mutated (they reference scenario-named keys);
 * unsupported types throw.
 */
function fuzzArgValue(
  arg: Arg,
  rng: FuzzRng,
): number | string | boolean {
  // Bias toward boundaries 30% of the time. Each integer type gets
  // 0, 1, MAX, MIN; bool flips uniformly.
  const useBoundary = rng.oneIn(3);

  switch (arg.type) {
    case "u8":   return useBoundary ? pickBoundary(rng, [0, 1, 255]) : rng.nextRange(256);
    case "u16":  return useBoundary ? pickBoundary(rng, [0, 1, 65535]) : rng.nextRange(65536);
    case "u32":  return useBoundary ? pickBoundary(rng, [0, 1, 4294967295]) : rng.nextRange(4294967296);
    // #14 — u64/u128/i64/i128 fuzz the FULL range as a decimal string. The old
    // path masked to 2^53 ("JS-safe") so overflow bugs between 2^53 and the true
    // max — exactly where a u64 lamports / token amount overflows — were never
    // exercised. Strings round-trip losslessly through the encoder's BigInt().
    case "u64":  return fuzzBigUnsigned(rng, useBoundary, 64);
    case "u128": return fuzzBigUnsigned(rng, useBoundary, 128);
    case "i8":   return useBoundary ? pickBoundary(rng, [-128, -1, 0, 1, 127]) : rng.nextRange(256) - 128;
    case "i16":  return useBoundary ? pickBoundary(rng, [-32768, 0, 32767]) : rng.nextRange(65536) - 32768;
    case "i32":  return useBoundary ? pickBoundary(rng, [-2147483648, 0, 2147483647]) : rng.nextRange(4294967296) - 2147483648;
    case "i64":  return fuzzBigSigned(rng, useBoundary, 64);
    case "i128": return fuzzBigSigned(rng, useBoundary, 128);
    case "bool": return rng.oneIn(2);
    // P3.1 — String + Vec<u8> mutation. Both biased toward boundary
    // lengths (empty, 1-byte, ~max) and otherwise uniformly random.
    // ASCII-only on String so the Borsh-encoded bytes are deterministic
    // across the two .so runs (UTF-8 multi-byte chars complicate the
    // hash comparison without adding meaningful coverage).
    case "String": {
      if (useBoundary) {
        // Empty + 1-char + a small random — covers off-by-one bounds.
        const choice = rng.nextRange(3);
        if (choice === 0) return "";
        if (choice === 1) return String.fromCharCode(0x41 + rng.nextRange(26));
        return ["a", "z", "0", "9"][rng.nextRange(4)] as string;
      }
      // Uniform: 0-20 chars, ASCII letters + digits.
      const len = rng.nextRange(21);
      let out = "";
      for (let i = 0; i < len; i++) {
        const ch = rng.nextRange(62);
        out += ch < 26
          ? String.fromCharCode(0x41 + ch)
          : ch < 52
            ? String.fromCharCode(0x61 + ch - 26)
            : String.fromCharCode(0x30 + ch - 52);
      }
      return out;
    }
    case "Vec<u8>": {
      // Returned as a hex string — the scenario encoder upstream decodes
      // it via Buffer.from(value, "hex") when arg.type matches Vec<u8>.
      // Boundary: empty + 1-byte. Uniform: 0-32 bytes.
      const len = useBoundary
        ? (rng.nextRange(2) === 0 ? 0 : 1)
        : rng.nextRange(33);
      let hex = "";
      for (let i = 0; i < len; i++) {
        const b = rng.nextRange(256);
        hex += b.toString(16).padStart(2, "0");
      }
      return hex;
    }
    case "Pubkey":
      throw new Error(
        `--fuzz can't randomize Pubkey args ('${arg.name}' on this ix). ` +
        `Pubkeys must reference scenario-named keys to remain meaningful — fix the scenario ` +
        `to bind '${arg.name}' to a signer or PDA, or remove this ix from the fuzzed scenario.`,
      );
    default:
      throw new Error(
        `--fuzz can't randomize arg '${arg.name}' (type '${arg.type}'). ` +
        `Hand-write a TS fixture using api/tests/differential-harness.ts for this case.`,
      );
  }
}

function pickBoundary(rng: FuzzRng, choices: number[]): number {
  return choices[rng.nextRange(choices.length)] ?? 0;
}

/** A random `bits`-wide (64 or 128) unsigned BigInt, from one or two u64 draws. */
function randUnsigned(rng: FuzzRng, bits: number): bigint {
  let v = rng.nextU64();
  if (bits > 64) v = (v << 64n) | rng.nextU64();
  return v & ((1n << BigInt(bits)) - 1n);
}

/**
 * #14 — fuzz a u64/u128 across its FULL range, returned as a decimal string so
 * it survives JSON + the borsh encoder's BigInt(value) without the 2^53
 * precision loss a JS number would incur. Boundaries include the 2^53 seam and
 * the true max (max-1, max) where wrap-around / off-by-one live.
 */
function fuzzBigUnsigned(rng: FuzzRng, useBoundary: boolean, bits: number): string {
  if (useBoundary) {
    const max = (1n << BigInt(bits)) - 1n;
    const choices = [0n, 1n, 1n << 53n, max - 1n, max];
    return (choices[rng.nextRange(choices.length)] ?? 0n).toString();
  }
  return randUnsigned(rng, bits).toString();
}

/**
 * #14 — fuzz an i64/i128 across its full signed range as a decimal string.
 * Boundaries include MIN, MIN+1, -1, 0, 1, MAX-1, MAX; the uniform draw
 * reinterprets a full-width unsigned value as two's-complement.
 */
function fuzzBigSigned(rng: FuzzRng, useBoundary: boolean, bits: number): string {
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (useBoundary) {
    const choices = [min, min + 1n, -1n, 0n, 1n, max - 1n, max];
    return (choices[rng.nextRange(choices.length)] ?? 0n).toString();
  }
  const u = randUnsigned(rng, bits);
  const signed = u >= 1n << BigInt(bits - 1) ? u - (1n << BigInt(bits)) : u;
  return signed.toString();
}

/**
 * Produce a fuzzed copy of a scenario: mutate every scalar arg in every
 * instruction. PDAs, signers, accounts, compare lists are preserved
 * exactly — only ix args change. The byte-equal post-state assertion
 * is meaningful because identical args produce identical state on both
 * sides.
 */
export function fuzzScenarioArgs(
  base: DifferentialScenario,
  ir: SolanaIR,
  rng: FuzzRng,
): DifferentialScenario {
  const newInstructions = base.instructions.map((scenIx) => {
    const irIx = ir.instructions.find((i) => i.name === scenIx.ix);
    if (!irIx) {
      throw new Error(
        `--fuzz: instruction '${scenIx.ix}' from scenario not found in parsed IR. ` +
        `IR has: ${ir.instructions.map((i) => i.name).join(", ")}.`,
      );
    }
    const newArgs: Record<string, number | string | boolean> = { ...(scenIx.args ?? {}) };
    for (const arg of irIx.args) {
      // Only mutate scalar args. Pubkey args throw inside fuzzArgValue
      // (intentional — fuzzing a Pubkey doesn't lead anywhere useful;
      // user must bind it to a scenario name).
      if (arg.type === "Pubkey") continue;
      newArgs[arg.name] = fuzzArgValue(arg, rng);
    }
    return { ...scenIx, args: newArgs };
  });
  return { ...base, instructions: newInstructions };
}

/**
 * P3.2 — Mutate ONE account flag in ONE instruction of the scenario.
 *
 * Picks a (instruction, account-position, flag) triple uniformly from
 * all candidates and adds a single `false` strip via the scenario's
 * `accountFlagStrips` map. Returns the base scenario unchanged when no
 * candidate exists (rare — e.g. an all-built-ins ix).
 *
 * Candidate filter:
 *   - Skips built-in pubkeys (system_program etc.) — their flags are
 *     already false at the IR-derivation step; stripping is a no-op.
 *   - Includes any slot the IR marks `isSigner` (signer-strip candidate).
 *   - Includes any slot the IR marks `isMut` or `isInit` (writable-strip).
 *
 * No guard against stripping the fee-payer-as-signer or stripping
 * writable from an `isInit` slot: those are EXACTLY the bug classes
 * `--fuzz-flags` is designed to catch. The byte-compare with
 * soft-fail-on-tx-error handles the expected-rejection case (state
 * unchanged on both sides → byte-equal pass) and surfaces the
 * asymmetric case (only one side rejected → divergence).
 */
export function fuzzScenarioFlags(
  base: DifferentialScenario,
  ir: SolanaIR,
  rng: FuzzRng,
): DifferentialScenario {
  type Candidate = {
    ixIdx: number;
    accIdx: number;
    flag: "isSigner" | "isWritable";
  };
  const candidates: Candidate[] = [];
  for (let ixIdx = 0; ixIdx < base.instructions.length; ixIdx++) {
    const scenIx = base.instructions[ixIdx]!;
    const irIx = ir.instructions.find((i) => i.name === scenIx.ix);
    if (!irIx) continue;
    for (let accIdx = 0; accIdx < scenIx.accounts.length; accIdx++) {
      const accName = scenIx.accounts[accIdx]!;
      const irAcc = irIx.accounts[accIdx];
      if (!irAcc) continue;
      if (BUILTIN_PUBKEYS[accName] != null) continue;
      const isSigner = base.signers.some((s) => s.name === accName) || irAcc.isSigner;
      const isWritable = irAcc.isMut || irAcc.isInit;
      if (isSigner) candidates.push({ ixIdx, accIdx, flag: "isSigner" });
      if (isWritable) candidates.push({ ixIdx, accIdx, flag: "isWritable" });
    }
  }
  if (candidates.length === 0) return base;
  const pick = candidates[rng.nextRange(candidates.length)]!;
  const newInstructions = base.instructions.map((scenIx, idx) => {
    if (idx !== pick.ixIdx) return scenIx;
    const existing = scenIx.accountFlagStrips ?? {};
    const slotExisting = existing[pick.accIdx] ?? {};
    return {
      ...scenIx,
      accountFlagStrips: {
        ...existing,
        [pick.accIdx]: { ...slotExisting, [pick.flag]: false },
      },
    };
  });
  return { ...base, instructions: newInstructions };
}

export interface FuzzRunResult {
  totalIterations: number;
  passed: number;
  divergentIteration?: {
    iteration: number;
    seed: string;
    scenario: DifferentialScenario;
    failure: ScenarioRunResult["results"];
  };
  durationMs: number;
}

/**
 * Run --fuzz N iterations. Stops on first divergence (the user wants the
 * minimal repro). Each iteration uses a deterministic sub-seed derived
 * from the master seed + iteration index, so a divergence at iteration K
 * can be reproduced by re-running with the printed seed and inspecting
 * the K-th sub-seed offline.
 *
 * Compatible with both --anchor-so + Anvil .so and built-from-source
 * .so — caller passes already-built buffers.
 */
export async function runFuzzDifferential(args: {
  baseScenario: DifferentialScenario;
  anchorSo: Buffer;
  anvilSo: Buffer;
  ir: SolanaIR;
  iterations: number;
  /** Hex string. If undefined, generated from Math.random. */
  seed?: string;
  /** Called once per iteration with (i, total) for progress reporting. */
  onProgress?: (iteration: number, total: number) => void;
  /** Forwarded to each iteration's runScenarioDifferential call. */
  compareEventLogs?: boolean;
  compareReturnData?: boolean;
  compareMsgLogs?: boolean;
  /**
   * P3.2 — when true, each iteration coin-flips between arg fuzz and
   * flag fuzz. Flag-fuzz iters enable softFailOnTxError so the byte
   * compare can detect asymmetric rejections (one side accepted what
   * the other rejected → real transpiler bug). Default false preserves
   * the original arg-only behavior.
   */
  flagFuzz?: boolean;
}): Promise<FuzzRunResult> {
  const t0 = Date.now();
  const masterSeed = args.seed ?? Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const masterSeedBig = BigInt("0x" + masterSeed);
  let passed = 0;
  for (let i = 0; i < args.iterations; i++) {
    args.onProgress?.(i, args.iterations);
    // Derive a per-iteration seed: master ^ i (rotated). Stable across
    // runs given the same master seed.
    const iterSeed = (masterSeedBig ^ (BigInt(i) * 0xdeadbeefn)) & 0xffffffffffffffffn;
    const rng = new FuzzRng(iterSeed);
    // P3.2 — when flagFuzz is on, coin-flip per iter between arg fuzz
    // (deterministic byte-equal) and flag fuzz (asymmetric-rejection
    // detection). The coin flip uses a dedicated rng pull at the head
    // of the iter so the args-mutator's downstream RNG sequence stays
    // identical to the no-flag-fuzz baseline when args was picked.
    const useFlagFuzz = args.flagFuzz === true && rng.oneIn(2);
    const fuzzed = useFlagFuzz
      ? fuzzScenarioFlags(args.baseScenario, args.ir, rng)
      : fuzzScenarioArgs(args.baseScenario, args.ir, rng);
    const result = await runScenarioDifferential({
      scenario: fuzzed,
      anchorSo: args.anchorSo,
      anvilSo: args.anvilSo,
      ir: args.ir,
      compareEventLogs: args.compareEventLogs,
      compareReturnData: args.compareReturnData,
      compareMsgLogs: args.compareMsgLogs,
      softFailOnTxError: useFlagFuzz,
    });
    if (!result.ok) {
      return {
        totalIterations: args.iterations,
        passed,
        divergentIteration: {
          iteration: i,
          seed: masterSeed,
          scenario: fuzzed,
          failure: result.results,
        },
        durationMs: Date.now() - t0,
      };
    }
    passed++;
  }
  return {
    totalIterations: args.iterations,
    passed,
    durationMs: Date.now() - t0,
  };
}

// ─── JSON schema documentation ───────────────────────────────────────────────

export function schemaHelp(): string {
  return `
  ${"".padEnd(0)}Scenario JSON shape:

    {
      "programId": "<base58 program id>",
      "signers": [
        { "name": "authority", "airdrop": 2000000000 }
      ],
      "pdas": [
        { "name": "counter_pda", "seeds": ["counter", "$authority.pubkey"] }
      ],
      "instructions": [
        {
          "ix": "initialize",
          "args": { "amount": 10 },
          "accounts": ["counter_pda", "authority", "system_program"]
        }
      ],
      "compare": [
        { "name": "counter_pda", "stripDiscriminator": true }
      ],
      "pinClockTimestamp": 1700000000,
      "pinClockSlot": 1
    }

  Built-in account names (no need to declare):
    system_program, token_program, token_2022_program,
    associated_token_program, rent, clock

  Seed substitution tokens:
    "$<signer>.pubkey"  → that signer's public key bytes
    "literal-string"    → that string's UTF-8 bytes

  Supported arg types: u8/u16/u32/u64/u128, i8/i16/i32/i64/i128, bool, Pubkey.
  For Vec<u8>, custom structs, or other shapes, hand-write a TS fixture
  using api/tests/differential-harness.ts.
`;
}

