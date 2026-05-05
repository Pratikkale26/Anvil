/**
 * Scenario runner — engine that translates a Scenario JSON into LiteSVM
 * transactions and runs them against pre-built .so binaries (Anchor
 * reference + Anvil emit). Returns a verdict comparing post-state.
 *
 * Pure module: no HTTP, no I/O beyond reading the .so buffers passed in.
 * The HTTP layer (routes/differential.ts) builds the .so files via the
 * harness helpers, then calls into here for the actual scenario run.
 *
 * Three components:
 *   - resolveScenarioContext: turn $signer / $pda / $program tags into
 *     concrete Keypairs / PublicKeys.
 *   - buildStepInstruction: turn one ScenarioStep into a TransactionInstruction
 *     (discriminator + borsh args + account list).
 *   - runScenarioOnSo: deploy the .so to a fresh LiteSVM, execute every step,
 *     capture post-state for the accounts the user asked to compare.
 *
 * Then verdict assembly: byte-compare per-account, run assertions against
 * deserialized state, classify "trivial pass on revert" / "scenario lint
 * issue" / "real verification".
 */
import { LiteSVM } from "litesvm";
import {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import type { Scenario, ScenarioStep, ScenarioAssertion } from "../ir/scenario.js";
import type { SolanaIR } from "../ir/schema.js";

// ─── Well-known program IDs ─────────────────────────────────────────────────

const KNOWN_PROGRAMS: Record<string, string> = {
  system: SystemProgram.programId.toBase58(),
  token: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  token_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  associated_token: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  memo: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  rent: "SysvarRent111111111111111111111111111111111",
  clock: "SysvarC1ock11111111111111111111111111111111",
};

// ─── Resolved scenario context ──────────────────────────────────────────────

export interface ResolvedScenarioContext {
  programId: PublicKey;
  signers: Map<string, Keypair>;
  pdas: Map<string, { pubkey: PublicKey; bump: number }>;
  /** Throwaway $keypair:foo references — generated lazily on first ref. */
  ephemeralKeypairs: Map<string, Keypair>;
}

/**
 * Generate keypairs + derive PDAs declared in the scenario. Same
 * resolution result is used by BOTH anchor + anvil scenario runs, so
 * accounts are byte-identical across the two targets.
 */
export function resolveScenarioContext(
  scenario: Scenario,
  programId: PublicKey,
): ResolvedScenarioContext {
  const signers = new Map<string, Keypair>();
  for (const decl of scenario.signers) {
    signers.set(decl.name, Keypair.generate());
  }

  const pdas = new Map<string, { pubkey: PublicKey; bump: number }>();
  for (const decl of scenario.pdas) {
    const seedBytes = decl.seeds.map((seed) =>
      resolveSeedExpression(seed, signers, pdas),
    );
    if (decl.bump !== undefined) {
      // Deterministic bump derivation by createProgramAddress.
      const seedsWithBump = [...seedBytes, Buffer.from([decl.bump])];
      const pubkey = PublicKey.createProgramAddressSync(seedsWithBump, programId);
      pdas.set(decl.name, { pubkey, bump: decl.bump });
    } else {
      const [pubkey, bump] = PublicKey.findProgramAddressSync(seedBytes, programId);
      pdas.set(decl.name, { pubkey, bump });
    }
  }

  return { programId, signers, pdas, ephemeralKeypairs: new Map() };
}

/**
 * Turn one seed-expression string into raw bytes. Supported forms:
 *   - `b"literal"` / `"literal"` → UTF-8 bytes
 *   - `$signer:name.pubkey` → 32-byte signer pubkey
 *   - `$pda:name.pubkey` → 32-byte PDA pubkey (must be earlier in scenario.pdas[])
 *   - `u8:42` / `u16:N` / `u32:N` / `u64:N` / `i8:-N` / `i16:-N` / `i32:-N` / `i64:-N`
 *     → little-endian encoded integer of the right width
 *   - `bytes:0xDEADBEEF` → raw hex bytes
 *
 * Tags `$state:account.field` and `$arg:name` are NOT supported. They were
 * authored speculatively for a future runtime resolver but the resolver
 * never landed; falling through silently meant the literal tag string got
 * encoded as UTF-8 bytes and the resulting PDA was wrong, producing a
 * misleading "DIVERGED at byte 8" verdict that hid the real cause. We now
 * refuse them loudly so auto-scenario callers get a real error and the
 * workbench can surface a clear blocker. When the resolver lands, replace
 * this throw with the actual derivation.
 */
export function resolveSeedExpression(
  seed: string,
  signers: Map<string, Keypair>,
  pdas: Map<string, { pubkey: PublicKey; bump: number }>,
): Buffer {
  // $signer:name.pubkey
  const signerMatch = seed.match(/^\$signer:([a-zA-Z_][a-zA-Z0-9_]*)\.pubkey$/);
  if (signerMatch?.[1]) {
    const kp = signers.get(signerMatch[1]);
    if (!kp) throw new Error(`seed references undeclared signer '${signerMatch[1]}'`);
    return Buffer.from(kp.publicKey.toBytes());
  }

  // $pda:name.pubkey
  const pdaMatch = seed.match(/^\$pda:([a-zA-Z_][a-zA-Z0-9_]*)\.pubkey$/);
  if (pdaMatch?.[1]) {
    const p = pdas.get(pdaMatch[1]);
    if (!p) throw new Error(`seed references PDA '${pdaMatch[1]}' that wasn't declared earlier in scenario.pdas[]`);
    return Buffer.from(p.pubkey.toBytes());
  }

  // typed integer: `u64:1000`, `i32:-5`, etc.
  const intMatch = seed.match(/^([ui])(8|16|32|64|128):(-?\d+)$/);
  if (intMatch) {
    const signed = intMatch[1] === "i";
    const bits = parseInt(intMatch[2]!, 10);
    const value = BigInt(intMatch[3]!);
    const buf = Buffer.alloc(bits / 8);
    if (signed) {
      // Two's complement encoding for negative values.
      const u = value < 0n ? value + (1n << BigInt(bits)) : value;
      writeBigIntLE(buf, u, bits / 8);
    } else {
      if (value < 0n) throw new Error(`seed '${seed}' uses unsigned type but value is negative`);
      writeBigIntLE(buf, value, bits / 8);
    }
    return buf;
  }

  // bytes:0xDEADBEEF
  const bytesMatch = seed.match(/^bytes:0x([0-9a-fA-F]+)$/);
  if (bytesMatch?.[1]) {
    return Buffer.from(bytesMatch[1], "hex");
  }

  // b"literal" — Rust byte string literal style
  const bMatch = seed.match(/^b"(.+)"$/);
  if (bMatch?.[1]) return Buffer.from(bMatch[1], "utf-8");

  // Refuse the speculatively-authored tags. Falling through to UTF-8 here
  // would silently encode the literal `$state:counter.bump` tag-string and
  // produce a wrong PDA in EVERY scenario for state/arg-derived seeds.
  if (seed.startsWith("$state:")) {
    throw new Error(
      `seed '${seed}': state-derived seeds (\`<account>.<field>.as_ref()\` shape) are not yet supported by the runtime resolver. Author the scenario with an explicit \`bytes:0x…\` or typed-int seed for the state value, or use the CLI \`anvil-sol differential\` for full control.`,
    );
  }
  if (seed.startsWith("$arg:")) {
    throw new Error(
      `seed '${seed}': arg-derived seeds (\`<arg>.as_ref()\` shape) are not yet supported by the runtime resolver. Replace with an explicit \`bytes:0x…\` of the arg's pubkey/bytes, or use the CLI for full control.`,
    );
  }
  if (seed.startsWith("$keypair:") || seed.startsWith("$program:")) {
    throw new Error(
      `seed '${seed}': '$keypair' / '$program' tags are valid as account refs but not as PDA seeds. PDAs derive from signer pubkeys, earlier-declared PDAs, byte literals, or typed ints.`,
    );
  }
  // Reserved sigil that didn't match any known form: refuse rather than
  // encode the tag-string as bytes.
  if (seed.startsWith("$")) {
    throw new Error(
      `seed '${seed}': unknown seed reference shape. Supported: b"literal", $signer:<name>.pubkey, $pda:<name>.pubkey, u<N>:<num>, i<N>:<num>, bytes:0x<hex>.`,
    );
  }

  // Plain string literal -- treat as UTF-8 bytes.
  return Buffer.from(seed, "utf-8");
}

function writeBigIntLE(buf: Buffer, value: bigint, byteLen: number): void {
  let v = value;
  for (let i = 0; i < byteLen; i++) {
    buf[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

// ─── Account ref resolution ─────────────────────────────────────────────────

/**
 * Resolve a single account reference string from a step's accounts[] list
 * to a PublicKey. Used while building TransactionInstructions. Mutates
 * `ctx.ephemeralKeypairs` for $keypair:foo refs (lazy generation).
 */
export function resolveAccountRef(ref: string, ctx: ResolvedScenarioContext): PublicKey {
  if (ref.startsWith("$signer:")) {
    const name = ref.slice("$signer:".length).split(".")[0]!;
    const kp = ctx.signers.get(name);
    if (!kp) throw new Error(`account ref '${ref}' references undeclared signer '${name}'`);
    return kp.publicKey;
  }
  if (ref.startsWith("$pda:")) {
    const name = ref.slice("$pda:".length).split(".")[0]!;
    const p = ctx.pdas.get(name);
    if (!p) throw new Error(`account ref '${ref}' references undeclared PDA '${name}'`);
    return p.pubkey;
  }
  if (ref.startsWith("$program:")) {
    const name = ref.slice("$program:".length);
    const id = KNOWN_PROGRAMS[name];
    if (!id) throw new Error(`account ref '${ref}' references unknown program '${name}'`);
    return new PublicKey(id);
  }
  if (ref.startsWith("$keypair:")) {
    const name = ref.slice("$keypair:".length);
    let kp = ctx.ephemeralKeypairs.get(name);
    if (!kp) {
      kp = Keypair.generate();
      ctx.ephemeralKeypairs.set(name, kp);
    }
    return kp.publicKey;
  }
  // Raw base58 pubkey.
  return new PublicKey(ref);
}

// ─── Borsh arg serialization ────────────────────────────────────────────────

/**
 * Serialize a step's args by their IR-recorded types into a Borsh-format
 * byte buffer. Anchor's IDL serialization is borsh-compatible for the
 * primitive types Anvil's IR currently models (u8..u128, i8..i128, bool,
 * Pubkey, String, Vec<u8>). Custom struct args are NOT supported in V1
 * -- the auto-scenario lint blocks those at synthesis time.
 */
export function serializeArgs(
  args: Record<string, unknown>,
  irArgs: Array<{ name: string; type: string }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const arg of irArgs) {
    const raw = args[arg.name];
    if (raw === undefined) {
      throw new Error(`scenario step is missing arg '${arg.name}' (type ${arg.type})`);
    }
    parts.push(serializeOne(raw, arg.type, arg.name));
  }
  return Buffer.concat(parts);
}

function serializeOne(value: unknown, type: string, fieldName: string): Buffer {
  // Numeric primitives.
  const intMatch = type.match(/^([ui])(8|16|32|64|128)$/);
  if (intMatch) {
    const signed = intMatch[1] === "i";
    const bits = parseInt(intMatch[2]!, 10);
    let v: bigint;
    if (typeof value === "number") v = BigInt(value);
    else if (typeof value === "string") v = BigInt(value);
    else if (typeof value === "bigint") v = value;
    else throw new Error(`arg '${fieldName}' is type ${type} but value is ${typeof value}`);
    const buf = Buffer.alloc(bits / 8);
    if (signed) {
      const u = v < 0n ? v + (1n << BigInt(bits)) : v;
      writeBigIntLE(buf, u, bits / 8);
    } else {
      if (v < 0n) throw new Error(`arg '${fieldName}' is unsigned type ${type} but value ${v} is negative`);
      writeBigIntLE(buf, v, bits / 8);
    }
    return buf;
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new Error(`arg '${fieldName}' is bool but value is ${typeof value}`);
    return Buffer.from([value ? 1 : 0]);
  }
  if (type === "Pubkey") {
    if (typeof value !== "string") throw new Error(`arg '${fieldName}' is Pubkey but value isn't a base58 string`);
    return Buffer.from(new PublicKey(value).toBytes());
  }
  if (type === "String") {
    if (typeof value !== "string") throw new Error(`arg '${fieldName}' is String but value isn't a string`);
    const bytes = new TextEncoder().encode(value);
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([lenBuf, Buffer.from(bytes)]);
  }
  if (type === "Vec<u8>") {
    if (!Array.isArray(value) && !(typeof value === "string")) {
      throw new Error(`arg '${fieldName}' is Vec<u8> but value isn't an array or hex string`);
    }
    const bytes = Array.isArray(value)
      ? Buffer.from(value as number[])
      : Buffer.from((value as string).replace(/^0x/, ""), "hex");
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(bytes.length, 0);
    return Buffer.concat([lenBuf, bytes]);
  }
  throw new Error(
    `arg '${fieldName}' has unsupported type '${type}' -- V1 supports u8..u128, i8..i128, bool, Pubkey, String, Vec<u8>. Custom structs deferred.`,
  );
}

// ─── Step → TransactionInstruction ──────────────────────────────────────────

export function anchorDiscriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

export function buildStepInstruction(
  step: ScenarioStep,
  ir: SolanaIR,
  ctx: ResolvedScenarioContext,
): TransactionInstruction {
  const irIx = ir.instructions.find((i) => i.name === step.ix);
  if (!irIx) {
    throw new Error(`scenario step '${step.ix}' is not in the program's IR (instructions: ${ir.instructions.map((i) => i.name).join(", ")})`);
  }

  const data = Buffer.concat([
    anchorDiscriminator(step.ix),
    serializeArgs(step.args, irIx.args),
  ]);

  const keys = step.accounts.map((ref) => {
    const pubkey = resolveAccountRef(ref, ctx);
    // Mark signers as such; mark non-program accounts as writable when
    // the IR's AccountRef says so.
    const isProgram = ref.startsWith("$program:");
    const isSigner = ref.startsWith("$signer:");
    // Default writability: writable for $signer (often payer) and $pda;
    // read-only for $program. Caller can override by appending `.ro` /
    // `.rw` to the ref (future).
    const isWritable = !isProgram;
    return { pubkey, isSigner, isWritable };
  });

  return new TransactionInstruction({ programId: ctx.programId, keys, data });
}

// ─── LiteSVM scenario execution ─────────────────────────────────────────────

export interface AccountSnapshot {
  data: Buffer;
  lamports: bigint;
  owner: string;
}

export interface StepOutcome {
  index: number;
  ix: string;
  label?: string;
  ok: boolean;
  error?: string;
  logs: string[];
  expectedFail: boolean;
}

export interface ScenarioRunResult {
  steps: StepOutcome[];
  /** Snapshots of every account in scenario.compare.accounts after the run. */
  snapshots: Map<string, AccountSnapshot>;
  /** Concatenated log lines across all steps. */
  allLogs: string[];
}

// ─── LiteSVM contract probe (A5) ────────────────────────────────────────────
//
// Before A5, scenario-runner duck-typed `svm.warpToTimestamp` per-call with
// a silent no-op fallback. If LiteSVM ever renamed the method (or dropped
// it on a major bump), every clock-pinning scenario would silently see the
// SVM's default time on both runs — same on both sides, so byte-equal STILL
// passes for time-independent programs, but any vesting / staking scenario
// would get wrong-timestamp behavior with no error surfaced.
//
// Probe at module load: spin up a throwaway LiteSVM, confirm the method
// exists, confirm calling it doesn't throw on a benign value. If the probe
// fails, runScenarioOnSo refuses to run any scenario that pins the clock
// and surfaces a loud error so the operator knows to pin a LiteSVM version
// that exposes the contract.

interface LiteSvmContract {
  hasWarpToTimestamp: boolean;
  hasWarpToSlot: boolean;
  hasAddProgram: boolean;
  hasAirdrop: boolean;
  hasGetAccount: boolean;
  hasSendTransaction: boolean;
  hasLatestBlockhash: boolean;
}

const LITESVM_CONTRACT: LiteSvmContract = (() => {
  const probe = new LiteSVM();
  // Required surfaces. Their absence makes scenario execution impossible
  // regardless of whether clock pinning is requested.
  const hasAddProgram = typeof (probe as unknown as { addProgram?: unknown }).addProgram === "function";
  const hasAirdrop = typeof (probe as unknown as { airdrop?: unknown }).airdrop === "function";
  const hasGetAccount = typeof (probe as unknown as { getAccount?: unknown }).getAccount === "function";
  const hasSendTransaction = typeof (probe as unknown as { sendTransaction?: unknown }).sendTransaction === "function";
  const hasLatestBlockhash = typeof (probe as unknown as { latestBlockhash?: unknown }).latestBlockhash === "function";
  if (!hasAddProgram || !hasAirdrop || !hasGetAccount || !hasSendTransaction || !hasLatestBlockhash) {
    throw new Error(
      `[litesvm-contract] LiteSVM core contract broken — addProgram/airdrop/getAccount/sendTransaction/latestBlockhash must all be present. Pin a compatible litesvm version. Detected: addProgram=${hasAddProgram}, airdrop=${hasAirdrop}, getAccount=${hasGetAccount}, sendTransaction=${hasSendTransaction}, latestBlockhash=${hasLatestBlockhash}`,
    );
  }
  // Optional clock-pinning surfaces. We probe both the "method exists" and
  // "method accepts the bigint we'll pass" steps so a silent rename to
  // e.g. `warpTo({timestamp})` is caught here, not at request time.
  let hasWarpToTimestamp = false;
  try {
    const fn = (probe as unknown as { warpToTimestamp?: (ts: bigint) => unknown }).warpToTimestamp;
    if (typeof fn === "function") {
      fn.call(probe, BigInt(1_700_000_000));
      hasWarpToTimestamp = true;
    }
  } catch (err) {
    console.warn(`[litesvm-contract] warpToTimestamp present but rejected probe call: ${err instanceof Error ? err.message : String(err)}`);
  }
  let hasWarpToSlot = false;
  try {
    const fn = (probe as unknown as { warpToSlot?: (slot: bigint) => unknown }).warpToSlot;
    if (typeof fn === "function") {
      fn.call(probe, BigInt(1));
      hasWarpToSlot = true;
    }
  } catch (err) {
    console.warn(`[litesvm-contract] warpToSlot present but rejected probe call: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(
    `[litesvm-contract] core=ok warpToTimestamp=${hasWarpToTimestamp} warpToSlot=${hasWarpToSlot}`,
  );
  return { hasWarpToTimestamp, hasWarpToSlot, hasAddProgram, hasAirdrop, hasGetAccount, hasSendTransaction, hasLatestBlockhash };
})();

/** Probe result, exported for /health surfacing + tests. */
export function liteSvmContract(): LiteSvmContract {
  return LITESVM_CONTRACT;
}

/**
 * Run one scenario against a freshly-spun-up LiteSVM with the given .so
 * deployed at programId. Generates fresh keypair material via the resolved
 * ctx (which is shared across both target runs so the same scenario is
 * deterministically reproducible).
 */
export function runScenarioOnSo(
  scenario: Scenario,
  ir: SolanaIR,
  programSo: Buffer,
  ctx: ResolvedScenarioContext,
): ScenarioRunResult {
  const svm = new LiteSVM();

  // Pin clock if scenario requested it. The LiteSVM contract probe ran at
  // module load; if a scenario asks for clock pinning AND LiteSVM doesn't
  // expose the surface, refuse loudly rather than silently using the SVM
  // default — clock-dependent programs would diverge from the live chain
  // in a way that's invisible in the byte-equal verdict.
  if (scenario.clock.timestamp !== undefined) {
    if (!LITESVM_CONTRACT.hasWarpToTimestamp) {
      throw new Error(
        `scenario.clock.timestamp = ${scenario.clock.timestamp} but LiteSVM doesn't expose warpToTimestamp on this version. Either upgrade litesvm OR drop clock pinning from the scenario.`,
      );
    }
    (svm as unknown as { warpToTimestamp: (ts: bigint) => unknown })
      .warpToTimestamp(BigInt(scenario.clock.timestamp));
  }
  if (scenario.clock.slot !== undefined) {
    if (!LITESVM_CONTRACT.hasWarpToSlot) {
      throw new Error(
        `scenario.clock.slot = ${scenario.clock.slot} but LiteSVM doesn't expose warpToSlot on this version. Either upgrade litesvm OR drop slot pinning from the scenario.`,
      );
    }
    (svm as unknown as { warpToSlot: (s: bigint) => unknown })
      .warpToSlot(BigInt(scenario.clock.slot));
  }

  // Deploy the program at scenario's programId (or IR's declared id).
  svm.addProgram(ctx.programId, programSo);

  // Airdrop signers.
  for (const decl of scenario.signers) {
    const kp = ctx.signers.get(decl.name)!;
    svm.airdrop(kp.publicKey, BigInt(decl.airdrop ?? 1_000_000_000));
  }

  const stepOutcomes: StepOutcome[] = [];
  const allLogs: string[] = [];
  let executionAborted = false;

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    if (executionAborted) {
      stepOutcomes.push({
        index: i,
        ix: step.ix,
        label: step.label,
        ok: false,
        error: "skipped (earlier step failed unexpectedly)",
        logs: [],
        expectedFail: step.expectFail,
      });
      continue;
    }

    let ix: TransactionInstruction;
    try {
      ix = buildStepInstruction(step, ir, ctx);
    } catch (err) {
      stepOutcomes.push({
        index: i,
        ix: step.ix,
        label: step.label,
        ok: false,
        error: `build-instruction failed: ${err instanceof Error ? err.message : String(err)}`,
        logs: [],
        expectedFail: step.expectFail,
      });
      executionAborted = true;
      continue;
    }

    // Pick a fee payer: the FIRST signer in the step's account list, or
    // the first declared signer if none of the step's accounts is a signer.
    const firstSignerRef = step.accounts.find((a) => a.startsWith("$signer:"));
    const feePayerName = firstSignerRef
      ? firstSignerRef.slice("$signer:".length).split(".")[0]!
      : scenario.signers[0]?.name;
    if (!feePayerName) {
      stepOutcomes.push({
        index: i,
        ix: step.ix,
        label: step.label,
        ok: false,
        error: "no signer available to pay fees -- declare at least one in scenario.signers",
        logs: [],
        expectedFail: step.expectFail,
      });
      executionAborted = true;
      continue;
    }
    const feePayer = ctx.signers.get(feePayerName)!;
    // All signer refs in the step's accounts list need to sign.
    const signerKps = step.accounts
      .filter((a) => a.startsWith("$signer:"))
      .map((a) => ctx.signers.get(a.slice("$signer:".length).split(".")[0]!)!)
      .filter((kp, idx, arr) => arr.findIndex((k) => k.publicKey.equals(kp.publicKey)) === idx);

    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = feePayer.publicKey;
    tx.sign(...signerKps);

    const r = svm.sendTransaction(tx);
    const failed = r?.constructor?.name === "FailedTransactionMetadata";
    if (failed) {
      const f = r as unknown as {
        err: () => { toString(): string };
        meta: () => { logs: () => string[] };
      };
      const errStr = f.err().toString();
      const logs = f.meta().logs();
      allLogs.push(...logs);
      stepOutcomes.push({
        index: i,
        ix: step.ix,
        label: step.label,
        ok: false,
        error: errStr,
        logs,
        expectedFail: step.expectFail,
      });
      // expectFail: don't abort the rest; otherwise abort.
      if (!step.expectFail) executionAborted = true;
    } else {
      const logs = (r as unknown as { logs?: () => string[] }).logs?.() ?? [];
      allLogs.push(...logs);
      stepOutcomes.push({
        index: i,
        ix: step.ix,
        label: step.label,
        ok: true,
        logs,
        expectedFail: step.expectFail,
      });
    }
  }

  // Snapshot the compare accounts.
  const snapshots = new Map<string, AccountSnapshot>();
  for (const accName of scenario.compare.accounts) {
    let pubkey: PublicKey;
    if (ctx.signers.has(accName)) pubkey = ctx.signers.get(accName)!.publicKey;
    else if (ctx.pdas.has(accName)) pubkey = ctx.pdas.get(accName)!.pubkey;
    else continue; // lint should have caught this
    const acct = svm.getAccount(pubkey);
    if (acct) {
      snapshots.set(accName, {
        data: Buffer.from(acct.data),
        lamports: BigInt(acct.lamports),
        owner: new PublicKey(acct.owner).toBase58(),
      });
    }
  }

  return { steps: stepOutcomes, snapshots, allLogs };
}

// ─── Verdict assembly ───────────────────────────────────────────────────────

export interface AccountDiff {
  name: string;
  status: "equal" | "diverged" | "missing";
  /** First diverging byte offset (after discriminator strip). undefined when equal. */
  firstDiffByte?: number;
  /** Lamport divergence -- present when lamports differ even if data matches. */
  lamportsDiff?: { anchor: string; anvil: string };
  /** Owner divergence. */
  ownerDiff?: { anchor: string; anvil: string };
  /** Per-field deserialized diff when AccountDef is known. */
  fieldDiffs?: Array<{
    field: string;
    anchor: unknown;
    anvil: unknown;
    equal: boolean;
    /** Source-link to the IR statement that emitted the diverging code,
     *  populated via M1's bodyLocs lookup. Lets the workbench's diff card
     *  jump-to-source on click. Empty when no matching state_field_assign
     *  was found in the IR. */
    sourceLink?: { instruction: string; line: number; column: number };
  }>;
  /** Hex preview of the diverging slice (for diff visualization). */
  anchorHex?: string;
  anvilHex?: string;
}

export interface AssertionResult {
  assertion: ScenarioAssertion;
  passed: boolean;
  /** Actual value seen in the Anvil run. undefined when the field couldn't
   *  be deserialized (not in IR, etc.). */
  actualAnvil?: unknown;
  actualAnchor?: unknown;
  message?: string;
}

export interface SanityWarning {
  kind: "all_steps_reverted" | "zero_mutation" | "no_compare_targets";
  message: string;
}

export interface ScenarioVerdict {
  verdict: "BYTE_EQUAL" | "DIVERGED" | "SCENARIO_FAILED";
  durationMs: number;
  steps: {
    anchor: StepOutcome[];
    anvil: StepOutcome[];
  };
  accountDiffs: AccountDiff[];
  assertions: AssertionResult[];
  /** Sanity warnings the verdict UI surfaces in yellow ahead of the green/red. */
  sanityWarnings: SanityWarning[];
  eventLogDiff?: { anchor: string[]; anvil: string[]; diverged: boolean };
  msgLogDiff?: { anchor: string[]; anvil: string[]; diverged: boolean };
}

export function compareScenarioRuns(
  scenario: Scenario,
  ir: SolanaIR,
  anchorRun: ScenarioRunResult,
  anvilRun: ScenarioRunResult,
  durationMs: number,
): ScenarioVerdict {
  const accountDiffs: AccountDiff[] = [];

  for (const accName of scenario.compare.accounts) {
    const a = anchorRun.snapshots.get(accName);
    const v = anvilRun.snapshots.get(accName);
    // Both absent post-scenario is byte-equal: e.g. `close = receiver`
    // legitimately produces an empty/non-existent account on both sides.
    // Only flag "missing" when ONE side has the account and the other
    // doesn't -- that's a real divergence in lifecycle behavior.
    if (!a && !v) {
      accountDiffs.push({ name: accName, status: "equal" });
      continue;
    }
    if (!a || !v) {
      accountDiffs.push({
        name: accName,
        status: "missing",
      });
      continue;
    }
    // Anchor stamps an 8-byte sha256("account:<Name>")[..8] discriminator at
    // offset 0 of every #[account]-derived state struct's data. The compare
    // wants to ignore those bytes since they're a constant prefix and a
    // "first diff at byte 0" message would be misleading. But blindly
    // stripping 8 bytes from EVERY account is wrong for raw-lamport vault
    // PDAs, system-owned signer accounts, and SPL token accounts (Token's
    // own header has no Anchor discriminator). Decide per-account: strip
    // ONLY when (a) the IR maps this account name to a state struct, AND
    // (b) the data is at least 8 bytes long, AND (c) BOTH sides start with
    // bytes matching the expected sha256("account:<Name>")[..8]. Otherwise
    // the bytes aren't an Anchor discriminator and stripping would just
    // shift the diff offset.
    const accDef = findAccountDefForName(accName, ir);
    const expectedDisc = accDef ? anchorAccountDiscriminator(accDef.name) : null;
    const shouldStrip =
      expectedDisc !== null
      && a.data.length >= 8
      && v.data.length >= 8
      && bufStartsWith(a.data, expectedDisc)
      && bufStartsWith(v.data, expectedDisc);
    const aData = shouldStrip ? a.data.subarray(8) : a.data;
    const vData = shouldStrip ? v.data.subarray(8) : v.data;

    const dataEq = aData.equals(vData);
    const lamportsEq = !scenario.compare.lamports || a.lamports === v.lamports;
    const ownerEq = !scenario.compare.owner || a.owner === v.owner;

    if (dataEq && lamportsEq && ownerEq) {
      accountDiffs.push({ name: accName, status: "equal" });
      continue;
    }

    let firstDiff = -1;
    if (!dataEq) {
      const minLen = Math.min(aData.length, vData.length);
      for (let i = 0; i < minLen; i++) {
        if (aData[i] !== vData[i]) { firstDiff = i; break; }
      }
      if (firstDiff < 0) firstDiff = minLen;
    }

    // Per-field diff via IR AccountDef when we can find a matching type.
    // The AccountRef in the IR's instructions tells us the AccountDef name;
    // we look up the AccountDef's fields and try to deserialize each side.
    // Only attempt when we stripped a real Anchor discriminator -- without
    // that, the bytes don't start at the borsh-encoded fields.
    const fieldDiffs = shouldStrip ? tryFieldDiff(accName, aData, vData, ir) : undefined;

    accountDiffs.push({
      name: accName,
      status: "diverged",
      firstDiffByte: firstDiff >= 0 ? firstDiff : undefined,
      lamportsDiff: !lamportsEq ? { anchor: a.lamports.toString(), anvil: v.lamports.toString() } : undefined,
      ownerDiff: !ownerEq ? { anchor: a.owner, anvil: v.owner } : undefined,
      fieldDiffs,
      anchorHex: hexPreview(aData, firstDiff),
      anvilHex: hexPreview(vData, firstDiff),
    });
  }

  // Assertions.
  const assertions: AssertionResult[] = scenario.assertions.map((a) => {
    const snap = anvilRun.snapshots.get(a.account);
    const anchorSnap = anchorRun.snapshots.get(a.account);
    if (!snap || !anchorSnap) {
      return { assertion: a, passed: false, message: `account '${a.account}' not in compare set` };
    }
    const accDef = findAccountDefForName(a.account, ir);
    if (!accDef) {
      return { assertion: a, passed: false, message: `no IR AccountDef found for account '${a.account}' -- can't deserialize` };
    }
    // Same per-account discriminator gate as the data compare above.
    const expectedDisc = anchorAccountDiscriminator(accDef.name);
    const stripA = anchorSnap.data.length >= 8 && bufStartsWith(anchorSnap.data, expectedDisc);
    const stripV = snap.data.length >= 8 && bufStartsWith(snap.data, expectedDisc);
    const dataAnvil = stripV ? snap.data.subarray(8) : snap.data;
    const dataAnchor = stripA ? anchorSnap.data.subarray(8) : anchorSnap.data;
    const anvilFields = tryDeserializeFields(dataAnvil, accDef);
    const anchorFields = tryDeserializeFields(dataAnchor, accDef);
    const actualAnvil = anvilFields?.[a.field];
    const actualAnchor = anchorFields?.[a.field];
    const passed = jsonEqual(actualAnvil, a.expectedValue) && jsonEqual(actualAnchor, a.expectedValue);
    return {
      assertion: a,
      passed,
      actualAnvil,
      actualAnchor,
      message: passed
        ? undefined
        : `expected '${a.account}.${a.field} = ${JSON.stringify(a.expectedValue)}' after step ${a.afterStep}; got anchor=${JSON.stringify(actualAnchor)} anvil=${JSON.stringify(actualAnvil)}`,
    };
  });

  // Sanity warnings (silent-pass defuse, per advisor).
  const sanityWarnings: SanityWarning[] = [];
  const allAnvilReverted = anvilRun.steps.every((s) => !s.ok && !s.expectedFail);
  if (allAnvilReverted && scenario.steps.length > 0) {
    sanityWarnings.push({
      kind: "all_steps_reverted",
      message: `Every step reverted in both targets. Byte-equal trivially holds because no state changed. This does NOT verify the program logic -- adjust step args / order so transactions actually mutate state.`,
    });
  }
  if (scenario.compare.accounts.length === 0 && scenario.assertions.length === 0
    && !scenario.compare.eventLogs && !scenario.compare.msgLogs) {
    sanityWarnings.push({
      kind: "no_compare_targets",
      message: "No accounts to compare, no assertions, no event/msg/return-data comparison. Verdict is trivially 'equal' but proves nothing.",
    });
  }
  // zero-mutation: snapshots all empty means accounts never got created.
  // Suppress when every step succeeded -- if the program ran clean and
  // accounts still end up empty, that's an intentional close/burn shape
  // (e.g. `close = receiver`), not a missed initialisation.
  const allStepsSucceeded =
    anchorRun.steps.every((s) => s.ok || s.expectedFail) &&
    anvilRun.steps.every((s) => s.ok || s.expectedFail);
  if (!allStepsSucceeded
    && scenario.compare.accounts.length > 0
    && scenario.compare.accounts.every((n) => {
      const a = anchorRun.snapshots.get(n);
      const v = anvilRun.snapshots.get(n);
      return (!a || a.data.length === 0) && (!v || v.data.length === 0);
    })) {
    sanityWarnings.push({
      kind: "zero_mutation",
      message: "Compared accounts are all empty / non-existent in both targets. Either the scenario didn't initialise them or initialisation reverted. Check step outcomes.",
    });
  }

  // Event-log + msg-log compare.
  let eventLogDiff: ScenarioVerdict["eventLogDiff"];
  if (scenario.compare.eventLogs) {
    const a = anchorRun.allLogs.filter((l) => l.startsWith("Program data:"));
    const v = anvilRun.allLogs.filter((l) => l.startsWith("Program data:"));
    eventLogDiff = { anchor: a, anvil: v, diverged: !arrayEqual(a, v) };
  }
  let msgLogDiff: ScenarioVerdict["msgLogDiff"];
  if (scenario.compare.msgLogs) {
    const a = anchorRun.allLogs.filter((l) => l.startsWith("Program log:") && !l.startsWith("Program log: Instruction:"));
    const v = anvilRun.allLogs.filter((l) => l.startsWith("Program log:") && !l.startsWith("Program log: Instruction:"));
    msgLogDiff = { anchor: a, anvil: v, diverged: !arrayEqual(a, v) };
  }

  // Verdict logic: any divergence (account / event / msg / failed assertion) → DIVERGED.
  // All clean → BYTE_EQUAL. Setup error (e.g. step build failed) → SCENARIO_FAILED.
  const anyAccountDiverged = accountDiffs.some((d) => d.status !== "equal");
  const anyEventDiverged = eventLogDiff?.diverged ?? false;
  const anyMsgDiverged = msgLogDiff?.diverged ?? false;
  const anyAssertionFailed = assertions.some((a) => !a.passed);
  const anyScenarioFailure = anvilRun.steps.some((s) => !s.ok && !s.expectedFail && s.error?.includes("build-instruction failed"));

  let verdict: ScenarioVerdict["verdict"];
  if (anyScenarioFailure) verdict = "SCENARIO_FAILED";
  else if (anyAccountDiverged || anyEventDiverged || anyMsgDiverged || anyAssertionFailed) verdict = "DIVERGED";
  else verdict = "BYTE_EQUAL";

  return {
    verdict,
    durationMs,
    steps: { anchor: anchorRun.steps, anvil: anvilRun.steps },
    accountDiffs,
    assertions,
    sanityWarnings,
    eventLogDiff,
    msgLogDiff,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function hexPreview(buf: Buffer, around: number, span = 32): string {
  const start = Math.max(0, around - span);
  const end = Math.min(buf.length, around + span);
  const slice = buf.subarray(start, end);
  return Array.from(slice).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

function arrayEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compute the 8-byte Anchor account discriminator: first 8 bytes of
 * sha256("account:<StructName>"). Anchor stamps this at offset 0 of every
 * #[account]-derived state struct's data so it can identify the type
 * before deserializing fields. The Anvil emit reproduces the same
 * convention via `borsh` derives + a discriminator constant.
 */
function anchorAccountDiscriminator(structName: string): Buffer {
  return createHash("sha256").update(`account:${structName}`).digest().subarray(0, 8);
}

/** True when `buf` starts with every byte in `prefix`. */
function bufStartsWith(buf: Buffer, prefix: Buffer): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

function findAccountDefForName(accName: string, ir: SolanaIR): { name: string; fields: { name: string; type: string }[] } | null {
  // Find an instruction's AccountRef whose name matches; use its accountType
  // to look up the AccountDef.
  for (const ix of ir.instructions) {
    const ref = ix.accounts.find((a) => a.name === accName);
    if (ref) {
      const def = ir.accounts.find((a) => a.name === ref.accountType);
      if (def) return def;
    }
  }
  // Fallback: try direct match on AccountDef name.
  return ir.accounts.find((a) => a.name === accName) ?? null;
}

function tryFieldDiff(
  accName: string,
  aData: Buffer,
  vData: Buffer,
  ir: SolanaIR,
): AccountDiff["fieldDiffs"] {
  const accDef = findAccountDefForName(accName, ir);
  if (!accDef) return undefined;
  const aFields = tryDeserializeFields(aData, accDef);
  const vFields = tryDeserializeFields(vData, accDef);
  if (!aFields || !vFields) return undefined;
  return accDef.fields.map((f) => ({
    field: f.name,
    anchor: aFields[f.name],
    anvil: vFields[f.name],
    equal: jsonEqual(aFields[f.name], vFields[f.name]),
    sourceLink: findSourceLinkForField(accName, f.name, ir),
  }));
}

/**
 * Look up the IR statement that mutates `accName.fieldName`. Returns the
 * source position of the FIRST matching state_field_assign, or undefined
 * when no handler writes that field. Used by the diff card to jump-to-
 * source when the user clicks a diverging field.
 *
 * The lookup is best-effort: if a handler mutates `<account>.<field>`
 * indirectly (via a helper, via pass_through code), this won't catch it.
 * For the dominant case (typed state_field_assign emit) it works.
 */
function findSourceLinkForField(
  accName: string,
  fieldName: string,
  ir: SolanaIR,
): { instruction: string; line: number; column: number } | undefined {
  for (const ix of ir.instructions) {
    for (let i = 0; i < ix.body.length; i++) {
      const stmt = ix.body[i];
      if (!stmt) continue;
      if (stmt.kind !== "state_field_assign") continue;
      if (stmt.account === accName && stmt.field === fieldName) {
        const loc = ix.bodyLocs?.[i];
        if (loc) {
          return { instruction: ix.name, line: loc.line, column: loc.column };
        }
      }
    }
  }
  return undefined;
}

/**
 * Best-effort deserialise an account's data into a {field: value} map using
 * the IR's AccountDef field types. Returns null when the data shape doesn't
 * match (variable-length fields out of range, etc.). Same primitive subset
 * as serializeArgs.
 */
function tryDeserializeFields(
  data: Buffer,
  accDef: { fields: { name: string; type: string }[] },
): Record<string, unknown> | null {
  let offset = 0;
  const result: Record<string, unknown> = {};
  try {
    for (const f of accDef.fields) {
      const intMatch = f.type.match(/^([ui])(8|16|32|64|128)$/);
      if (intMatch) {
        const signed = intMatch[1] === "i";
        const bits = parseInt(intMatch[2]!, 10);
        const byteLen = bits / 8;
        if (offset + byteLen > data.length) return null;
        let v = 0n;
        for (let i = 0; i < byteLen; i++) v |= BigInt(data[offset + i]!) << BigInt(8 * i);
        if (signed && v >= 1n << BigInt(bits - 1)) v -= 1n << BigInt(bits);
        result[f.name] = bits <= 32 ? Number(v) : v.toString();
        offset += byteLen;
      } else if (f.type === "bool") {
        if (offset + 1 > data.length) return null;
        result[f.name] = data[offset] === 1;
        offset += 1;
      } else if (f.type === "Pubkey") {
        if (offset + 32 > data.length) return null;
        result[f.name] = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
        offset += 32;
      } else if (f.type === "String" || f.type === "Vec<u8>") {
        if (offset + 4 > data.length) return null;
        const len = data.readUInt32LE(offset);
        offset += 4;
        if (offset + len > data.length) return null;
        const slice = data.subarray(offset, offset + len);
        result[f.name] = f.type === "String"
          ? new TextDecoder().decode(slice)
          : Array.from(slice);
        offset += len;
      } else {
        // Unknown type -- bail; caller falls back to hex diff.
        return null;
      }
    }
    return result;
  } catch {
    return null;
  }
}
