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
}

export interface ScenarioCompareSpec {
  name: string;
  /** Default true. Set false for raw token accounts (no Anchor disc). */
  stripDiscriminator?: boolean;
  /** Default true. Set false when lamports are expected to vary across runs. */
  compareLamports?: boolean;
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
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEbW";
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
    | { name: string; ok: false; kind: "data" | "lamports" | "missing"; details: string }
  >;
  durationMs: number;
}

export async function runScenarioDifferential(args: {
  scenario: DifferentialScenario;
  anchorSo: Buffer;
  anvilSo: Buffer;
  ir: SolanaIR;
}): Promise<ScenarioRunResult> {
  const t0 = Date.now();
  const deps = await loadRuntimeDeps();
  const programId = new deps.PublicKey(args.scenario.programId);

  // Build the resolved-key table: signer keypairs (deterministic from name +
  // scenario program id so re-runs use the same keys), PDA derivations, and
  // the built-in pubkeys. Identical across both Anchor and Anvil scenarios
  // — this is what makes byte-equal compare meaningful.
  const ctx = buildScenarioContext(args.scenario, programId, deps);

  const anchorState = await runOneScenario(args.scenario, args.anchorSo, programId, ctx, args.ir, deps);
  const anvilState = await runOneScenario(args.scenario, args.anvilSo, programId, ctx, args.ir, deps);

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
    results.push({ name: spec.name, ok: true });
  }

  return {
    ok: results.every((r) => r.ok),
    results,
    durationMs: Date.now() - t0,
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
}

async function runOneScenario(
  scenario: DifferentialScenario,
  programSo: Buffer,
  programId: any,
  ctx: ScenarioContext,
  ir: SolanaIR,
  deps: RuntimeDeps,
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
      const isSigner = isBuiltin ? false : (ctx.signers.has(accName) || irAcct.isSigner);
      const isWritable = isBuiltin ? false : (irAcct.isMut || irAcct.isInit);
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
export function buildAnchorReferenceSo(args: {
  anchorSource: string;
  packageName: string;
  scratchDir: string;
  extraDeps?: string;
}): Buffer {
  const { anchorSource, packageName, scratchDir, extraDeps } = args;
  rmSync(scratchDir, { recursive: true, force: true });
  mkdirSync(join(scratchDir, "src"), { recursive: true });
  const cargoToml = `[package]
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
anchor-lang = "0.31"
${extraDeps ?? ""}
`;
  writeFileSync(join(scratchDir, "Cargo.toml"), cargoToml);
  writeFileSync(join(scratchDir, "src/lib.rs"), anchorSource);
  const r = spawnSync(
    "cargo-build-sbf",
    ["--manifest-path", join(scratchDir, "Cargo.toml")],
    { stdio: "inherit", timeout: 600_000, env: { ...process.env, RUSTFLAGS: "" } },
  );
  if (r.status !== 0) {
    throw new Error(`cargo-build-sbf (Anchor reference) failed with exit ${r.status}`);
  }
  const builtSo = join(scratchDir, "target/deploy", `${packageName}.so`);
  if (!existsSync(builtSo)) {
    throw new Error(`expected Anchor reference .so not produced at ${builtSo}`);
  }
  return readFileSync(builtSo);
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

