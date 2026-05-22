/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/token-fundraiser Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-token-fundraiser.test.ts — asserts
 *     byte-equal on the fundraiser PDA post-`initialize`.
 *
 * Target instruction: `initialize` — the simplest writeable instruction in
 * the program. Sets up a Fundraiser PDA (seeds = ["fundraiser", maker.key()])
 * and an associated vault token account owned by that PDA. The other ix
 * (contribute, check_contributions, refund) all CPI into the token program
 * and are already covered by sibling transfer-tokens/spl-token-minter
 * fixtures.
 *
 * Multi-file Anchor layout:
 *   src/lib.rs
 *   src/constants.rs
 *   src/error.rs
 *   src/instructions/{mod,initialize,contribute,checker,refund}.rs
 *   src/state/{mod,fundraiser,contributor}.rs
 *
 * The whole project is flattened via buildProjectSource and fed to both
 * the Anvil emit path AND the reference Anchor build, so the contribute /
 * checker / refund handlers ALSO need to compile under the reference build
 * even though only `initialize` is invoked.
 *
 * Source rewrites applied for the reference build:
 *   1. `self.token_program.key()` → `self.token_program.to_account_info()`
 *      Anchor 0.32's CpiContext::new wants AccountInfo, not Pubkey. The
 *      upstream calls `let cpi_program = self.token_program.key();` then
 *      `CpiContext::new(cpi_program, ...)` in three handlers (contribute,
 *      checker, refund). Anvil's typed IR is happy either way; the rewrite
 *      is solely to keep the reference build green.
 *   2. declare_id! replaced with our deterministic test program ID.
 *
 * The fundraiser PDA payload is what we byte-compare:
 *   maker (Pubkey, 32) + mint_to_raise (Pubkey, 32) + amount_to_raise (u64, 8)
 *   + current_amount (u64, 8) + time_started (i64, 8) + duration (u16, 2)
 *   + bump (u8, 1) = 91 bytes + 8-byte discriminator. The bump (PDA-derive
 *   correctness) and the maker/mint pubkeys (account-resolution correctness)
 *   are the load-bearing fields. time_started comes from Clock::get(); the
 *   callScript explicitly pins the clock before the ix so both runs see
 *   the identical timestamp.
 *
 * Counts toward grant A1 (10+ byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  concatBytes,
  encodeU64LE,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import {
  createMintIxs,
  sendSetupTx,
} from "../differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync } from "node:fs";

export const LIB_RS =
  "/tmp/program-examples/tokens/token-fundraiser/anchor/programs/fundraiser/src/lib.rs";

// Deterministic test program ID. Upstream declare_id! is
// Eoiuq1dXvHxh6dLx3wh9gj8kSAUpga11krTrbfF5XYsC — sub our own so this
// fixture's deployed-program address doesn't collide with any other
// fixture that might happen to reuse the upstream ID. Base58 alphabet
// excludes 0/O/I/l.
export const PROGRAM_ID = "TknFndrsrExmps11111111111111111111111111111";

const UPSTREAM_DECLARE_ID = "Eoiuq1dXvHxh6dLx3wh9gj8kSAUpga11krTrbfF5XYsC";

// Pin Clock::get().unix_timestamp to a fixed value so both the Anchor and
// Anvil scenarios produce identical `time_started` in the fundraiser PDA.
// litesvm 0.7's default unixTimestamp is 0n, and the harness-level
// warpToTimestamp doesn't exist in that version — explicit setClock() in
// callScript is the only way to guarantee parity going forward (any
// future litesvm default-clock change would silently invalidate this
// fixture without it).
const PIN_UNIX_TIMESTAMP = 1_700_000_000;

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file project — flatten through the same path Anvil's parser is
  // calibrated against. Handles `mod constants/error/instructions/state`,
  // `pub use initialize::*`, etc.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  let src = buildProjectSource(entry, files);

  // Anchor 0.32's CpiContext::new expects an AccountInfo, but the upstream
  // sources pass `self.token_program.key()` (a Pubkey). Anvil's parser
  // bypasses this via typed IR (cpi_spl_transfer, etc.), but the reference
  // Anchor build would reject on a type mismatch. Rewrite every occurrence
  // — contribute.rs, checker.rs and refund.rs all use the same pattern.
  src = src.replaceAll(
    "self.token_program.key()",
    "self.token_program.to_account_info()",
  );

  // Replace declare_id! with our deterministic test program ID.
  src = src.replace(
    `declare_id!("${UPSTREAM_DECLARE_ID}");`,
    `declare_id!("${PROGRAM_ID}");`,
  );
  return src;
}

export interface TokenFundraiserCtx {
  payer: Keypair;
  maker: Keypair;
  mint: Keypair;
  fundraiserPda: PublicKey;
  fundraiserBump: number;
  vaultAta: PublicKey;
  decimals: number;
  /** Amount to raise (raw units). Must be >= MIN_AMOUNT_TO_RAISE.pow(decimals)
   *  per the require!() check in initialize — with decimals=6 that's 729. */
  amountToRaise: bigint;
  /** Duration in days. Stored verbatim in the fundraiser PDA. */
  durationDays: number;
}

export async function setupTokenFundraiser(): Promise<TokenFundraiserCtx> {
  const payer = Keypair.generate();
  const maker = Keypair.generate();
  const mint = Keypair.generate();
  const decimals = 6;
  // MIN_AMOUNT_TO_RAISE = 3; check is `amount >= 3.pow(decimals)` = 729.
  // Pass 1000 (raw units) — comfortably above the floor.
  const amountToRaise = 1000n;
  const durationDays = 30;

  // fundraiser PDA: seeds = ["fundraiser", maker.key().as_ref()] under
  // the deployed program ID. Same derivation runs in both Anchor and
  // Anvil scenarios (the maker keypair is shared), so the PDA address
  // — and the bump byte cached into account data — must match.
  const [fundraiserPda, fundraiserBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("fundraiser"), maker.publicKey.toBuffer()],
    new PublicKey(PROGRAM_ID),
  );

  // Vault ATA: associated token account for the fundraiser PDA holding
  // the mint_to_raise mint. The fundraiser PDA is off-curve (PDAs always
  // are), so allowOwnerOffCurve must be true; the default false throws.
  const vaultAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    fundraiserPda,
    /* allowOwnerOffCurve */ true,
  );

  return {
    payer,
    maker,
    mint,
    fundraiserPda,
    fundraiserBump,
    vaultAta,
    decimals,
    amountToRaise,
    durationDays,
  };
}

// u16 little-endian encoding for the `duration` arg. There's no helper in
// differential-harness for u16 — inline.
function encodeU16LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

export async function callTokenFundraiserInitialize(
  svm: LiteSVM,
  ctx: TokenFundraiserCtx,
  programId: PublicKey,
): Promise<void> {
  // Import Clock lazily to avoid a top-level import that would couple the
  // file to litesvm's exports in fixtures that don't pin the clock.
  const { Clock } = await import("litesvm");

  // Pin the clock BEFORE any tx so both Anchor and Anvil scenarios see the
  // identical `unix_timestamp` when initialize reads Clock::get(). Without
  // this the fundraiser.time_started field would depend on litesvm's
  // default-clock behavior, which has shifted between versions.
  svm.setClock(
    new Clock(
      BigInt(1),                       // slot
      BigInt(PIN_UNIX_TIMESTAMP),      // epoch_start_timestamp
      BigInt(0),                       // epoch
      BigInt(0),                       // leader_schedule_epoch
      BigInt(PIN_UNIX_TIMESTAMP),      // unix_timestamp
    ),
  );

  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
  // maker pays for the fundraiser PDA + vault ATA — fund it.
  svm.airdrop(ctx.maker.publicKey, BigInt(10_000_000_000));

  // Setup: allocate + initialize the mint. The fundraiser+vault are created
  // by the program-under-test's `initialize` ix via Anchor's `init` macros,
  // so we do NOT pre-create either here — that allocation shape is part of
  // what the byte-equal harness compares (via the fundraiser PDA payload).
  const setupTx = new Transaction().add(
    ...createMintIxs(
      svm,
      ctx.payer.publicKey,
      ctx.mint.publicKey,
      ctx.decimals,
      ctx.payer.publicKey, // mint authority (irrelevant for initialize)
    ),
  );
  sendSetupTx(
    svm,
    setupTx,
    ctx.payer.publicKey,
    [ctx.payer, ctx.mint],
    "setup-mint",
  );

  // Account ordering MUST mirror the Initialize struct verbatim:
  //   maker (Signer, mut)
  //   mint_to_raise (Account<Mint>)
  //   fundraiser (init, PDA)
  //   vault (init, ATA owned by fundraiser PDA)
  //   system_program
  //   token_program
  //   associated_token_program
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.maker.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.fundraiserPda, isSigner: false, isWritable: true },
      { pubkey: ctx.vaultAta, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // Args: u64 amount (LE) + u16 duration (LE) = 10 bytes after the
    // 8-byte discriminator.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("initialize"),
        encodeU64LE(ctx.amountToRaise),
        encodeU16LE(ctx.durationDays),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // maker signs at the ix level (Signer<'info>) AND funds the system::
  // create_account for the PDA + ATA (payer = maker on both inits). The
  // outer `payer` keypair signs as tx-level fee payer.
  tx.sign(ctx.payer, ctx.maker);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize failed: ${txFailureMessage(r)}`);
  }
}

export function tokenFundraiserAccountsToCompare(ctx: TokenFundraiserCtx) {
  // Compare only the fundraiser PDA — it carries the authoritative byte
  // signal:
  //   discriminator (8 — stripped by harness)
  //   maker: Pubkey (32) — catches account-resolution drift
  //   mint_to_raise: Pubkey (32) — catches account-resolution drift
  //   amount_to_raise: u64 (8) — catches arg-decoding drift
  //   current_amount: u64 (8) — must be 0 after init
  //   time_started: i64 (8) — catches Clock::get() lowering drift (clock pinned)
  //   duration: u16 (2) — catches u16 arg-decoding drift
  //   bump: u8 (1) — catches PDA-derivation drift
  // = 91 bytes post-discriminator.
  //
  // Vault ATA is intentionally NOT compared: it's a standard SPL token
  // account allocation whose byte-equal-ness is already covered by the
  // sibling transfer-tokens fixture (init_if_needed on the ATA path).
  // Adding it here would double the surface without catching anything new.
  return [{ pubkey: ctx.fundraiserPda, label: "fundraiser_pda" }];
}
