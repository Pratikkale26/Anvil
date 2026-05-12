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
import { MintLayout, AccountLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
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
  /** Pre-generated SPL Mint keypairs — one per scenario.mints[] entry. */
  mints: Map<string, { keypair: Keypair; programOwner: PublicKey; decimals: number; mintAuthority: PublicKey; freezeAuthority?: PublicKey; supply: bigint }>;
  /** Pre-generated SPL Token Account keypairs — one per scenario.tokenAccounts[] entry.
   *  When `derived` is true, `keypair` is unused for address purposes (`pubkey`
   *  carries the deterministic ATA derivation) but kept for typing parity. */
  tokenAccounts: Map<string, { keypair: Keypair; pubkey: PublicKey; mint: PublicKey; owner: PublicKey; balance: bigint; programOwner: PublicKey; derived: boolean; programInits: boolean }>;
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

  // Mints come BEFORE PDAs because PDA seeds may reference $mint:foo.pubkey.
  const mints: ResolvedScenarioContext["mints"] = new Map();
  for (const decl of scenario.mints) {
    const authorityName = decl.mintAuthority ?? scenario.signers[0]?.name;
    if (!authorityName || !signers.has(authorityName)) {
      throw new Error(`mint '${decl.name}' has no resolvable mint authority — declare a signer or set mint.mintAuthority`);
    }
    const programOwner = decl.program === "token_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    mints.set(decl.name, {
      keypair: Keypair.generate(),
      programOwner,
      decimals: decl.decimals,
      mintAuthority: signers.get(authorityName)!.publicKey,
      freezeAuthority: decl.freezeAuthority ? signers.get(decl.freezeAuthority)?.publicKey : undefined,
      supply: typeof decl.supply === "string" ? BigInt(decl.supply) : BigInt(decl.supply),
    });
  }

  const pdas = new Map<string, { pubkey: PublicKey; bump: number }>();
  for (const decl of scenario.pdas) {
    const seedBytes = decl.seeds.map((seed) =>
      resolveSeedExpression(seed, signers, pdas, mints),
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

  // Pre-materialize ephemeral keypairs for any $keypair:X seen anywhere in the
  // scenario (steps' accounts[] / tokenAccounts[].mint / .owner). Without this,
  // tokenAccount resolution would fail for cases like AMM's user_lp_token whose
  // mint references a Mint that the program init's at step 0 (the runner emits
  // `$keypair:lp_mint` rather than `$mint:lp_mint`).
  const ephemeralKeypairs = new Map<string, Keypair>();
  const ensureEphemeral = (name: string): Keypair => {
    let kp = ephemeralKeypairs.get(name);
    if (!kp) { kp = Keypair.generate(); ephemeralKeypairs.set(name, kp); }
    return kp;
  };
  const collectKeypairRefs = (ref: string): void => {
    if (ref.startsWith("$keypair:")) ensureEphemeral(ref.slice("$keypair:".length).split(".")[0]!);
  };
  for (const step of scenario.steps) for (const ref of step.accounts) collectKeypairRefs(ref);
  for (const ta of scenario.tokenAccounts) {
    collectKeypairRefs(ta.mint);
    collectKeypairRefs(ta.owner);
  }

  // Token accounts depend on mints/pdas/signers/ephemeralKeypairs being resolved already.
  const tokenAccounts: ResolvedScenarioContext["tokenAccounts"] = new Map();
  for (const decl of scenario.tokenAccounts) {
    const programOwner = decl.program === "token_2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const mintPk = resolvePubkeyTag(decl.mint, signers, pdas, mints, ephemeralKeypairs, decl.name, "mint");
    const ownerPk = resolvePubkeyTag(decl.owner, signers, pdas, mints, ephemeralKeypairs, decl.name, "owner");
    const keypair = Keypair.generate();
    // Derived ATAs use the deterministic associated_token derivation. The
    // `keypair` field stays generated (unused, but typed) so callers don't
    // crash on `keypair.publicKey` access.
    const pubkey = decl.derived
      ? getAssociatedTokenAddressSync(mintPk, ownerPk, true, programOwner, ASSOCIATED_TOKEN_PROGRAM_ID)
      : keypair.publicKey;
    tokenAccounts.set(decl.name, {
      keypair,
      pubkey,
      mint: mintPk,
      owner: ownerPk,
      balance: typeof decl.balance === "string" ? BigInt(decl.balance) : BigInt(decl.balance),
      programOwner,
      derived: decl.derived,
      programInits: decl.programInits,
    });
  }

  return { programId, signers, pdas, mints, tokenAccounts, ephemeralKeypairs };
}

/** Resolve a `$signer:name` / `$pda:name` / `$mint:name` / `$keypair:name` tag
 *  to its pubkey for use in tokenAccounts[].mint / .owner declarations. */
function resolvePubkeyTag(
  tag: string,
  signers: Map<string, Keypair>,
  pdas: Map<string, { pubkey: PublicKey; bump: number }>,
  mints: ResolvedScenarioContext["mints"],
  ephemeralKeypairs: Map<string, Keypair>,
  taName: string,
  field: "mint" | "owner",
): PublicKey {
  if (tag.startsWith("$signer:")) {
    const n = tag.slice("$signer:".length);
    const kp = signers.get(n);
    if (!kp) throw new Error(`tokenAccount '${taName}' ${field}='${tag}' references undeclared signer '${n}'`);
    return kp.publicKey;
  }
  if (tag.startsWith("$pda:")) {
    const n = tag.slice("$pda:".length);
    const p = pdas.get(n);
    if (!p) throw new Error(`tokenAccount '${taName}' ${field}='${tag}' references PDA '${n}' that wasn't declared earlier`);
    return p.pubkey;
  }
  if (tag.startsWith("$mint:")) {
    const n = tag.slice("$mint:".length);
    const m = mints.get(n);
    if (!m) throw new Error(`tokenAccount '${taName}' ${field}='${tag}' references mint '${n}' that wasn't declared`);
    return m.keypair.publicKey;
  }
  if (tag.startsWith("$keypair:")) {
    const n = tag.slice("$keypair:".length);
    const kp = ephemeralKeypairs.get(n);
    if (!kp) throw new Error(`tokenAccount '${taName}' ${field}='${tag}' references keypair '${n}' that wasn't pre-materialized`);
    return kp.publicKey;
  }
  // Raw base58 fallback.
  return new PublicKey(tag);
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
  mints?: ResolvedScenarioContext["mints"],
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

  // $mint:name.pubkey
  const mintMatch = seed.match(/^\$mint:([a-zA-Z_][a-zA-Z0-9_]*)\.pubkey$/);
  if (mintMatch?.[1]) {
    const m = mints?.get(mintMatch[1]);
    if (!m) throw new Error(`seed references mint '${mintMatch[1]}' that wasn't declared in scenario.mints[]`);
    return Buffer.from(m.keypair.publicKey.toBytes());
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
  if (ref.startsWith("$mint:")) {
    const name = ref.slice("$mint:".length).split(".")[0]!;
    const m = ctx.mints.get(name);
    if (!m) throw new Error(`account ref '${ref}' references undeclared mint '${name}'`);
    return m.keypair.publicKey;
  }
  if (ref.startsWith("$ata:")) {
    const name = ref.slice("$ata:".length).split(".")[0]!;
    const ta = ctx.tokenAccounts.get(name);
    if (!ta) throw new Error(`account ref '${ref}' references undeclared tokenAccount '${name}'`);
    return ta.pubkey;
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

// ─── SPL Mint pre-creation ──────────────────────────────────────────────────
//
// Encode each declared mint as a 82-byte MintLayout buffer, write directly
// to LiteSVM via setAccount with token-program ownership + rent-exempt
// lamports. Faster + simpler than running InitializeMint via CPI; both
// targets see byte-identical mint accounts because resolveScenarioContext
// generates the same keypairs once and shares ctx across runs.

const MINT_ACCOUNT_SIZE = 82;
// MINT_ACCOUNT_SIZE bytes * lamports_per_byte_year * 2 years exempt.
// Fixed value matches what the system program would compute; both sides
// see byte-identical lamports because resolveScenarioContext is shared.
const MINT_RENT_EXEMPT_LAMPORTS = 1_461_600;

export function installMintAccounts(svm: LiteSVM, ctx: ResolvedScenarioContext): void {
  for (const [, mint] of ctx.mints) {
    const data = Buffer.alloc(MINT_ACCOUNT_SIZE);
    MintLayout.encode(
      {
        mintAuthorityOption: 1,
        mintAuthority: mint.mintAuthority,
        supply: mint.supply,
        decimals: mint.decimals,
        isInitialized: true,
        freezeAuthorityOption: mint.freezeAuthority ? 1 : 0,
        freezeAuthority: mint.freezeAuthority ?? PublicKey.default,
      },
      data,
    );
    svm.setAccount(mint.keypair.publicKey, {
      lamports: MINT_RENT_EXEMPT_LAMPORTS,
      data,
      owner: mint.programOwner,
      executable: false,
      rentEpoch: 0,
    });
  }
}

// ─── SPL Token Account pre-creation ─────────────────────────────────────────
//
// Same pattern as installMintAccounts but for SPL Token Account state:
// 165-byte AccountLayout (mint + owner + amount + delegate + state +
// is_native + delegated_amount + close_authority). State byte = 1
// (Initialized). All COption flags zeroed (no delegate, not native, no
// close authority).

const TOKEN_ACCOUNT_SIZE = 165;
// Same approximate rent value the system program would compute for 165 bytes.
const TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS = 2_039_280;

export function installTokenAccounts(svm: LiteSVM, ctx: ResolvedScenarioContext): void {
  for (const [, ta] of ctx.tokenAccounts) {
    // Skip when the program creates the account at runtime — Anchor's `init
    // associated_token::*` lowers to the AT program's create_account CPI
    // and pre-installing would conflict. Non-init derived ATAs (escrow's
    // maker_ata_a) still need install at the derived address so the program
    // sees the pre-existing balance.
    if (ta.programInits) continue;
    const data = Buffer.alloc(TOKEN_ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: ta.mint,
        owner: ta.owner,
        amount: ta.balance,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1, // Initialized
        isNativeOption: 0,
        isNative: BigInt(0),
        delegatedAmount: BigInt(0),
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      data,
    );
    svm.setAccount(ta.pubkey, {
      lamports: TOKEN_ACCOUNT_RENT_EXEMPT_LAMPORTS,
      data,
      owner: ta.programOwner,
      executable: false,
      rentEpoch: 0,
    });
  }
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
  // Generic Vec<T> — borsh: u32 length prefix, then T-encoded elements.
  // Recurses on the inner type so Vec<Pubkey> / Vec<u64> / Vec<i32> etc.
  // all serialize without needing a per-shape branch. The outer Vec<u8>
  // shortcut above handles the byte-string optimization.
  const vecMatch = type.match(/^Vec<(.+)>$/);
  if (vecMatch?.[1]) {
    if (!Array.isArray(value)) {
      throw new Error(`arg '${fieldName}' is ${type} but value isn't an array`);
    }
    const inner = vecMatch[1];
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(value.length, 0);
    const elemBufs = (value as unknown[]).map((v, i) =>
      serializeOne(v, inner, `${fieldName}[${i}]`),
    );
    return Buffer.concat([lenBuf, ...elemBufs]);
  }
  throw new Error(
    `arg '${fieldName}' has unsupported type '${type}' -- V1 supports u8..u128, i8..i128, bool, Pubkey, String, Vec<T>. Custom structs deferred.`,
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

  const keys = step.accounts.map((ref, slotIdx) => {
    const pubkey = resolveAccountRef(ref, ctx);
    const isProgram = ref.startsWith("$program:");
    // B5 — consult IR.AccountRef.isMut when the slot index lines up with
    // the IR's account list AND the slot isn't a program. This closes
    // the class of "should-have-failed-but-didn't" scenarios — Anchor
    // would reject a write on a `pub foo: Account<'info, Foo>` (no mut)
    // at constraint-check time, but with the slot wrongly marked
    // writable both runs accept the write and byte-equal silently
    // holds. Now both sides see the IR-correct writability.
    //
    // Programs are always read-only. Signers default to writable (most
    // are fee payers) but yield to the IR when it says otherwise.
    let isWritable: boolean;
    let isSigner: boolean;
    if (isProgram) {
      isWritable = false;
      isSigner = false;
    } else if (slotIdx < irIx.accounts.length) {
      const irAcc = irIx.accounts[slotIdx]!;
      isWritable = irAcc.isMut;
      // Init'd non-PDA accounts (e.g. AMM's lp_mint) need signer privilege
      // — Anchor's init does create_account via CPI which requires the new
      // account's keypair to sign. Init'd PDA accounts (vault_a, vault_b,
      // pool) are signed via CPI signer_seeds; the outer TX must NOT mark
      // them is_signer (no private key available).
      //
      // ATA-derived and mint-bucket refs ($ata:foo / $mint:foo) are NEVER
      // signers regardless of IR isInit. Init'd ATAs (escrow's
      // init_if_needed for taker_ata_a/maker_ata_b) are PDAs of the ATA
      // program — created via the program's create_idempotent CPI, not
      // by the outer transaction, so they have no private key. The IR's
      // isPda flag only catches Anchor PDAs (with explicit `seeds=[]`),
      // not ATA-derived addresses, so we gate on the ref prefix here.
      const isProgramDerivedRef = ref.startsWith("$ata:") || ref.startsWith("$mint:");
      isSigner =
        irAcc.isSigner ||
        (irAcc.isInit && !irAcc.isPda && !isProgramDerivedRef) ||
        ref.startsWith("$signer:");
    } else {
      // Step has more accounts than IR knows (extra remaining_accounts):
      // default to writable, defer signer to ref shape.
      isWritable = true;
      isSigner = ref.startsWith("$signer:");
    }
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

  // Pin clock if scenario requested it AND LiteSVM exposes the surface.
  // litesvm 0.7.0 doesn't ship warpToTimestamp / warpToSlot; 1.0.0 is
  // a Solana Kit migration (deferred). When the surface is missing we
  // run with the SVM default clock — both sides of the byte-equal compare
  // see the same default, so the diff verdict is still meaningful. The
  // tradeoff is determinism *across runs* of clock-dependent programs
  // (vest math, reward accrual): two sessions on different default clocks
  // can produce different account bytes per run. Loud-warn once per
  // scenario so the operator sees the degradation in logs.
  if (scenario.clock.timestamp !== undefined) {
    if (LITESVM_CONTRACT.hasWarpToTimestamp) {
      (svm as unknown as { warpToTimestamp: (ts: bigint) => unknown })
        .warpToTimestamp(BigInt(scenario.clock.timestamp));
    } else {
      console.warn(
        `[scenario-runner] scenario.clock.timestamp=${scenario.clock.timestamp} requested but LiteSVM ${LITESVM_CONTRACT.hasWarpToTimestamp ? "" : "doesn't expose warpToTimestamp"} — running with SVM default. Byte-equal verdict still valid (both sides identical) but cross-run determinism reduced for clock-dependent programs. Upgrade to litesvm 1.0+ for clock pinning (Solana Kit migration; ~4-6 hrs).`,
      );
    }
  }
  if (scenario.clock.slot !== undefined) {
    if (LITESVM_CONTRACT.hasWarpToSlot) {
      (svm as unknown as { warpToSlot: (s: bigint) => unknown })
        .warpToSlot(BigInt(scenario.clock.slot));
    } else {
      console.warn(
        `[scenario-runner] scenario.clock.slot=${scenario.clock.slot} requested but LiteSVM doesn't expose warpToSlot — running with SVM default.`,
      );
    }
  }

  // Deploy the program at scenario's programId (or IR's declared id).
  svm.addProgram(ctx.programId, programSo);

  // Pre-create SPL Mint + Token Account state before step 0 so subsequent
  // CPIs (transfer_checked, mint_to, burn) succeed against real layouts.
  installMintAccounts(svm, ctx);
  installTokenAccounts(svm, ctx);

  // Airdrop signers.
  for (const decl of scenario.signers) {
    const kp = ctx.signers.get(decl.name)!;
    svm.airdrop(kp.publicKey, BigInt(decl.airdrop ?? 1_000_000_000));
  }

  // B2 — Pre-scan steps for $keypair refs and airdrop each one.
  // Without this, a scenario that uses `$keypair:foo` as a payer or
  // rent-paying account fails with InsufficientFundsForRent at step
  // execution. Lazy generation in resolveAccountRef gives the keypair
  // a publicKey but zero lamports. Mirror the signer-airdrop default
  // (1 SOL each).
  //
  // EXCEPT: keypairs that are init'd-non-PDA in any instruction (AMM's
  // lp_mint pattern). Anchor's `init` lowering invokes
  // SystemProgram::CreateAccount, which requires lamports=0 on the
  // destination — pre-funding the keypair makes that CPI fail. The init
  // CPI pays the rent itself, so an airdrop is unnecessary and harmful.
  const initdNonPdaKeypairNames = new Set<string>();
  for (const insn of ir.instructions) {
    for (const acc of insn.accounts) {
      if (acc.isInit && !acc.isPda) initdNonPdaKeypairNames.add(acc.name);
    }
  }
  const keypairRefNames = new Set<string>();
  for (const step of scenario.steps) {
    for (const ref of step.accounts) {
      if (ref.startsWith("$keypair:")) {
        keypairRefNames.add(ref.slice("$keypair:".length));
      }
    }
  }
  for (const name of keypairRefNames) {
    // Force lazy generation by calling resolveAccountRef, then airdrop
    // (unless this keypair is going to be init'd, which requires lamports=0).
    const pk = resolveAccountRef(`$keypair:${name}`, ctx);
    if (initdNonPdaKeypairNames.has(name)) continue;
    svm.airdrop(pk, BigInt(1_000_000_000));
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
    // Include init'd $keypair refs (their keypairs need to sign for
    // create_account CPIs that Anchor's init constraint generates).
    const signerKps: Keypair[] = [];
    const irIxForSign = ir.instructions.find((i) => i.name === step.ix);
    for (let slotIdx = 0; slotIdx < step.accounts.length; slotIdx++) {
      const ref = step.accounts[slotIdx]!;
      if (ref.startsWith("$signer:")) {
        const kp = ctx.signers.get(ref.slice("$signer:".length).split(".")[0]!);
        if (kp) signerKps.push(kp);
      } else if (ref.startsWith("$keypair:")) {
        // Only sign if the IR says this slot is_signer or is an init'd
        // non-PDA (PDA inits are signed via CPI seeds, not outer TX).
        const irAcc = irIxForSign?.accounts[slotIdx];
        if (irAcc && (irAcc.isSigner || (irAcc.isInit && !irAcc.isPda))) {
          const kp = ctx.ephemeralKeypairs.get(ref.slice("$keypair:".length).split(".")[0]!);
          if (kp) signerKps.push(kp);
        }
      }
    }
    // Always include the feePayer in the signer list — Solana requires
    // the fee payer to sign even when no instruction-level signer ref
    // is present (e.g. counter-pe's `increment` ix has no signer in its
    // accounts list, only a $keypair PDA-counter). Without this,
    // tx.sign(...emptyArr) leaves the tx unsigned and LiteSVM rejects
    // with "No signers".
    const signerKpsWithFee = [feePayer, ...signerKps];
    // Dedupe by publicKey (same keypair can appear in multiple slots).
    const uniqSignerKps = signerKpsWithFee.filter(
      (kp, idx, arr) => arr.findIndex((k) => k.publicKey.equals(kp.publicKey)) === idx,
    );

    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = feePayer.publicKey;
    tx.sign(...uniqSignerKps);

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

  // Snapshot the compare accounts. Names can resolve via signers, PDAs,
  // mints, ATAs, or ephemeral keypair refs — all carry pubkeys that
  // SVM may have written state to over the course of the scenario.
  // Bare names match a unique resolution; "$mint:foo" / "$ata:foo" /
  // "$keypair:foo" tags pin a specific bucket when names overlap.
  const resolveCompareName = (name: string): PublicKey | undefined => {
    if (name.startsWith("$signer:")) return ctx.signers.get(name.slice("$signer:".length))?.publicKey;
    if (name.startsWith("$pda:"))    return ctx.pdas.get(name.slice("$pda:".length))?.pubkey;
    if (name.startsWith("$mint:"))   return ctx.mints.get(name.slice("$mint:".length))?.keypair.publicKey;
    if (name.startsWith("$ata:"))    return ctx.tokenAccounts.get(name.slice("$ata:".length))?.pubkey;
    if (name.startsWith("$keypair:"))return ctx.ephemeralKeypairs.get(name.slice("$keypair:".length))?.publicKey;
    if (ctx.signers.has(name))         return ctx.signers.get(name)!.publicKey;
    if (ctx.pdas.has(name))            return ctx.pdas.get(name)!.pubkey;
    if (ctx.mints.has(name))           return ctx.mints.get(name)!.keypair.publicKey;
    if (ctx.tokenAccounts.has(name))   return ctx.tokenAccounts.get(name)!.pubkey;
    if (ctx.ephemeralKeypairs.has(name)) return ctx.ephemeralKeypairs.get(name)!.publicKey;
    return undefined;
  };
  const snapshots = new Map<string, AccountSnapshot>();
  for (const accName of scenario.compare.accounts) {
    const pubkey = resolveCompareName(accName);
    if (!pubkey) continue; // lint should have caught this
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
  kind:
    | "all_steps_reverted"
    | "zero_mutation"
    | "no_compare_targets"
    | "partial_compare_scope"
    | "discriminator_mismatch";
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
  const discriminatorMismatchAccounts: Array<{
    name: string;
    accountDef: string;
    anchorHasDisc: boolean;
    anvilHasDisc: boolean;
  }> = [];

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
    // C7 — discriminator-strip silent fallback warning. When the IR DOES
    // know an AccountDef for this account (so we expected a disc-prefixed
    // shape) but the on-chain bytes don't actually start with the
    // expected sha256("account:<Name>")[..8], we silently fall through
    // to raw-byte compare. That degrades the verdict UI (no per-field
    // diffs, no source-link). Surfaces a class of bugs — future parser
    // refactor renames an AccountDef, emitter strips a disc, on-chain
    // wire format drifts — that would otherwise stay hidden. Track the
    // observation here and emit a warning after the loop so
    // sanityWarnings has all the data once we know the verdict.
    if (expectedDisc !== null && !shouldStrip && (a.data.length > 0 || v.data.length > 0)) {
      discriminatorMismatchAccounts.push({
        name: accName,
        accountDef: accDef!.name,
        anchorHasDisc: a.data.length >= 8 && bufStartsWith(a.data, expectedDisc),
        anvilHasDisc: v.data.length >= 8 && bufStartsWith(v.data, expectedDisc),
      });
    }
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
    const anvilFields = tryDeserializeFields(dataAnvil, accDef, ir);
    const anchorFields = tryDeserializeFields(dataAnchor, accDef, ir);
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

  // S4 — "all steps succeeded but zero mutation observed." Different
  // shape from `zero_mutation` (which fires when the run aborted) and
  // from `partial_compare_scope` (which fires on UNCOMPARED accounts).
  // Here every step ran clean AND the compared accounts ARE present on
  // both sides AND their data is non-empty AND identical between
  // Anchor and Anvil — but no MUTATION was observed (data identical
  // before+after the run, suggesting the user's scenario only exercised
  // read paths). Surfaces a class of "the test trivially passed because
  // nothing wrote anything" — the user should add steps that actually
  // mutate state, or use assertions to prove the read returned what was
  // expected.
  //
  // Detection heuristic: every account in compare.accounts deserialised
  // to all-zero / default fields on BOTH sides. We can't easily compare
  // pre vs post snapshots without restructuring the runner, so we
  // approximate via "all fields are zero/empty in the post-state."
  // False-positive on legitimate "init to zero" scenarios is acceptable
  // — the warning's text invites the user to confirm with assertions.
  if (allStepsSucceeded
    && scenario.compare.accounts.length > 0
    && scenario.assertions.length === 0) {
    const allCompareSnapshotsZeroValued = scenario.compare.accounts.every((accName) => {
      const a = anchorRun.snapshots.get(accName);
      const v = anvilRun.snapshots.get(accName);
      if (!a || !v) return false;
      // Strip disc + check post-disc bytes are all zero.
      const accDef = findAccountDefForName(accName, ir);
      const expectedDisc = accDef ? anchorAccountDiscriminator(accDef.name) : null;
      const stripA = expectedDisc !== null && a.data.length >= 8 && bufStartsWith(a.data, expectedDisc);
      const stripV = expectedDisc !== null && v.data.length >= 8 && bufStartsWith(v.data, expectedDisc);
      const aPostDisc = stripA ? a.data.subarray(8) : a.data;
      const vPostDisc = stripV ? v.data.subarray(8) : v.data;
      const allZero = (b: Buffer) => b.length === 0 || b.every((x) => x === 0);
      return allZero(aPostDisc) && allZero(vPostDisc);
    });
    if (allCompareSnapshotsZeroValued) {
      sanityWarnings.push({
        kind: "zero_mutation",
        message:
          "All steps succeeded but every compared account's post-state bytes are zero. " +
          "Byte-equal trivially holds without proving program correctness. " +
          "Add steps that actually mutate state, or assertions[] entries " +
          "that pin specific field values, to make the verdict meaningful.",
      });
    }
  }

  // C7 — discriminator-strip silent fallback. When the IR identifies an
  // AccountDef for an account but the on-chain bytes don't carry the
  // expected sha256("account:<Name>")[..8] disc, the per-field diff card
  // silently falls back to raw bytes (no source-link, no field
  // breakdown). Surface this as a warning so future bugs (parser
  // refactor renames an AccountDef, emitter strips the disc, on-chain
  // wire format drifts) don't stay hidden behind a degraded UI.
  for (const m of discriminatorMismatchAccounts) {
    const which = m.anchorHasDisc && !m.anvilHasDisc
      ? "Anvil emit's"
      : !m.anchorHasDisc && m.anvilHasDisc
        ? "Anchor reference's"
        : "BOTH targets'";
    sanityWarnings.push({
      kind: "discriminator_mismatch",
      message:
        `Account '${m.name}' (IR type '${m.accountDef}') has ${which} bytes ` +
        `not starting with the expected Anchor account discriminator. The ` +
        `per-field diff card is degraded to raw bytes for this account. ` +
        `Check whether the emitter is dropping the discriminator prefix or ` +
        `the on-chain account isn't actually an Anchor state struct.`,
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

  // Partial-compare-scope sanity warning (M2). A green BYTE_EQUAL verdict
  // when scenario.compare.accounts lists fewer accounts than the executed
  // instructions actually touch is honest about "compared accounts match"
  // but overstates "your program is verified." Surface what's NOT in the
  // compare list so the user knows the verdict's scope.
  //
  // We compute coverage from the IR's accounts[] list per executed step
  // (excluding $program: refs which aren't user state and don't carry
  // verifiable bytes). Compare against scenario.compare.accounts. If
  // there's daylight AND the verdict is BYTE_EQUAL AND the user didn't
  // already opt-in to a non-data surface (eventLogs / msgLogs / returnData)
  // that would carry the missing semantic — fire the warning.
  if (verdict === "BYTE_EQUAL") {
    // Names of accounts the executed steps actually touched. Pull from
    // the scenario steps (which know their own account refs) rather than
    // the IR's instruction account list — the user's scenario may pass
    // signers/PDAs the IR doesn't enumerate (e.g. fee-payer).
    // Strip ALL bucket prefixes ($signer:/$pda:/$keypair:/$mint:/$ata:) so
    // touched and compared sets normalize to the same name. Without
    // stripping $mint:/$ata:, an account compared as $keypair:lp_mint
    // would mismatch the bare lp_mint in touched and false-positive
    // as uncompared.
    const stripPrefix = (ref: string): string => {
      for (const p of ["$signer:", "$pda:", "$keypair:", "$mint:", "$ata:"] as const) {
        if (ref.startsWith(p)) return ref.slice(p.length).split(".")[0]!;
      }
      return ref;
    };
    const touchedAccountRefs = new Set<string>();
    for (const step of scenario.steps) {
      const irIx = ir.instructions.find((i) => i.name === step.ix);
      if (!irIx) continue;
      for (const ref of step.accounts) {
        // Skip program refs ($program:system / token / etc.) — those are
        // protocol primitives, not state worth byte-comparing.
        if (ref.startsWith("$program:")) continue;
        touchedAccountRefs.add(stripPrefix(ref));
      }
    }
    const compared = new Set(scenario.compare.accounts.map(stripPrefix));
    const uncompared = [...touchedAccountRefs].filter((n) => !compared.has(n));
    // Also a real warning when NO compare.accounts are listed at all but
    // the steps did touch state-bearing accounts. (no_compare_targets
    // already flags zero compares + zero assertions/logs; this is a
    // narrower "you HAVE compares but they're incomplete" signal.)
    if (uncompared.length > 0 && scenario.compare.accounts.length > 0) {
      sanityWarnings.push({
        kind: "partial_compare_scope",
        message:
          `BYTE_EQUAL verdict only covers ${scenario.compare.accounts.length} of ${touchedAccountRefs.size} ` +
          `account${touchedAccountRefs.size === 1 ? "" : "s"} the scenario touches. ` +
          `Uncompared: ${uncompared.join(", ")}. ` +
          `Add to compare.accounts to widen the verifiable claim.`,
      });
    }
  }

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
  const aFields = tryDeserializeFields(aData, accDef, ir);
  const vFields = tryDeserializeFields(vData, accDef, ir);
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
 * the IR's AccountDef field types.
 *
 * Recursive type dispatch via readByType supports:
 *   - integers (u8..u128 / i8..i128) — fixed width little-endian; >32-bit
 *     returns as decimal string to dodge JSON-number precision loss
 *   - bool — 1 byte
 *   - Pubkey — 32 bytes, returns base58
 *   - String — borsh `(u32 len, bytes)`, returns string
 *   - Vec<T> — borsh `(u32 len, len * T)`, recurses on T
 *   - Option<T> — 1-byte tag (0/1) + T when Some, returns null when None
 *   - [T; N] — fixed N-element array, recurses on T
 *   - <CustomTypeName> — looks up ir.types catalog, recurses on its fields
 *     (struct: object) or returns variant name (enum)
 *
 * Returns null when the data shape doesn't match (variable-length fields
 * out of range, unknown type, etc.). Caller falls back to hex preview.
 *
 * Symmetric with the borsh / Anchor account layout — every shape Anvil's
 * IR carries can be deserialised here, so the verdict UI's per-field
 * diff card works for richer state programs (escrow Order, Multisig
 * with Vec<Pubkey>, etc.).
 */
function tryDeserializeFields(
  data: Buffer,
  accDef: { fields: { name: string; type: string }[] },
  ir?: SolanaIR,
): Record<string, unknown> | null {
  const cursor = { offset: 0 };
  const result: Record<string, unknown> = {};
  try {
    for (const f of accDef.fields) {
      const v = readByType(f.type, data, cursor, ir);
      if (v === SHAPE_BAIL) return null;
      result[f.name] = v;
    }
    return result;
  } catch {
    return null;
  }
}

/** Sentinel for "field shape didn't match buffer." Caller propagates as null. */
const SHAPE_BAIL = Symbol("shape-bail");

/**
 * Borsh-style typed reader. Mutates `cursor.offset` in place.
 *
 * Returns the deserialised JS value for the given type, or `SHAPE_BAIL`
 * when the type can't be parsed (unknown shape, OOB read, etc.). Any
 * SHAPE_BAIL bubbles up as null from tryDeserializeFields.
 */
function readByType(
  type: string,
  data: Buffer,
  cursor: { offset: number },
  ir?: SolanaIR,
): unknown {
  // Primitive integers.
  const intMatch = type.match(/^([ui])(8|16|32|64|128)$/);
  if (intMatch) {
    const signed = intMatch[1] === "i";
    const bits = parseInt(intMatch[2]!, 10);
    const byteLen = bits / 8;
    if (cursor.offset + byteLen > data.length) return SHAPE_BAIL;
    let v = 0n;
    for (let i = 0; i < byteLen; i++) v |= BigInt(data[cursor.offset + i]!) << BigInt(8 * i);
    if (signed && v >= 1n << BigInt(bits - 1)) v -= 1n << BigInt(bits);
    cursor.offset += byteLen;
    return bits <= 32 ? Number(v) : v.toString();
  }
  if (type === "bool") {
    if (cursor.offset + 1 > data.length) return SHAPE_BAIL;
    const b = data[cursor.offset];
    cursor.offset += 1;
    return b === 1;
  }
  if (type === "Pubkey") {
    if (cursor.offset + 32 > data.length) return SHAPE_BAIL;
    const v = new PublicKey(data.subarray(cursor.offset, cursor.offset + 32)).toBase58();
    cursor.offset += 32;
    return v;
  }
  if (type === "String") {
    if (cursor.offset + 4 > data.length) return SHAPE_BAIL;
    const len = data.readUInt32LE(cursor.offset);
    cursor.offset += 4;
    if (cursor.offset + len > data.length) return SHAPE_BAIL;
    const slice = data.subarray(cursor.offset, cursor.offset + len);
    cursor.offset += len;
    return new TextDecoder().decode(slice);
  }
  // Vec<T>.
  const vecMatch = type.match(/^Vec<(.+)>$/);
  if (vecMatch?.[1]) {
    if (cursor.offset + 4 > data.length) return SHAPE_BAIL;
    const len = data.readUInt32LE(cursor.offset);
    cursor.offset += 4;
    // Vec<u8> shortcut: return as number array (matches the legacy shape).
    if (vecMatch[1] === "u8") {
      if (cursor.offset + len > data.length) return SHAPE_BAIL;
      const slice = data.subarray(cursor.offset, cursor.offset + len);
      cursor.offset += len;
      return Array.from(slice);
    }
    const out: unknown[] = [];
    for (let i = 0; i < len; i++) {
      const v = readByType(vecMatch[1], data, cursor, ir);
      if (v === SHAPE_BAIL) return SHAPE_BAIL;
      out.push(v);
    }
    return out;
  }
  // Option<T> — borsh: 1-byte tag (0=None, 1=Some) + T when Some.
  const optMatch = type.match(/^Option<(.+)>$/);
  if (optMatch?.[1]) {
    if (cursor.offset + 1 > data.length) return SHAPE_BAIL;
    const tag = data[cursor.offset];
    cursor.offset += 1;
    if (tag === 0) return null;
    if (tag !== 1) return SHAPE_BAIL;
    return readByType(optMatch[1], data, cursor, ir);
  }
  // Fixed array `[T; N]`.
  const arrMatch = type.match(/^\[(.+);\s*(\d+)\]$/);
  if (arrMatch?.[1] && arrMatch[2]) {
    const inner = arrMatch[1];
    const n = parseInt(arrMatch[2], 10);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const v = readByType(inner, data, cursor, ir);
      if (v === SHAPE_BAIL) return SHAPE_BAIL;
      out.push(v);
    }
    return out;
  }
  // Custom type — look up ir.types.
  if (ir) {
    const td = ir.types.find((t) => t.name === type);
    if (td) {
      if (td.kind === "enum") {
        // Anchor enums serialize as a 1-byte variant tag (extension to
        // payloaded variants is borsh-defined; current IR doesn't carry
        // payload shapes for enum variants, so we only handle pure-tag).
        if (cursor.offset + 1 > data.length) return SHAPE_BAIL;
        const tag = data[cursor.offset]!;
        cursor.offset += 1;
        return td.variants?.[tag] ?? null;
      }
      // Struct: recurse on each field.
      const fields = td.fields ?? [];
      const obj: Record<string, unknown> = {};
      for (const f of fields) {
        const v = readByType(f.type, data, cursor, ir);
        if (v === SHAPE_BAIL) return SHAPE_BAIL;
        obj[f.name] = v;
      }
      return obj;
    }
  }
  // Unknown type — bail.
  return SHAPE_BAIL;
}
