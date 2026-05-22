/**
 * Shared fixture pieces for coral-anchor's tests/escrow `initialize_escrow` flow.
 *
 * Re-used by:
 *   - differential-coral-escrow.test.ts — asserts byte-equal on the freshly
 *     init'd escrow_account AND on the deposit token account whose owner
 *     gets reassigned to the escrow PDA via the set_authority CPI.
 *
 * `initialize_escrow` is the simplest of the three escrow instructions:
 * pure state init on the escrow_account (5 fields from inputs) plus ONE
 * CPI (token_interface::set_authority) reassigning the deposit token
 * account's owner to the program PDA derived from a fixed seed. We
 * compare BOTH accounts so the byte-equal gate covers the state write
 * AND the CPI's downstream effect (the SPL TokenAccount.owner field).
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the accounts the instruction touches.
 *
 * ──────────────────────────────────────────────────────────────────────
 * KNOWN ANVIL BUGS WORKED AROUND BY THIS FIXTURE
 *
 * (a) Scaffold pulls broken spl-token-2022 v6 transitively.
 *     The escrow source imports `anchor_spl::token_2022::spl_token_2022
 *     ::instruction::AuthorityType`. Anvil's `extractUsedCrates` scans
 *     the literal `spl_token_2022::` text and adds spl-token-2022 = "6"
 *     to the scaffold's [dependencies]. But v6.0.0's
 *     `extension::confidential_mint_burn` module has internal cfg
 *     gating that breaks compilation with the default
 *     `["no-entrypoint"]` feature set (verify_burn_proof /
 *     verify_mint_proof gated behind zk-ops feature, but processor.rs
 *     calls them unconditionally). `loadAnchorSource` rewrites the
 *     import to route through `anchor_spl::token::spl_token`'s thin
 *     interface re-export — both anchor-spl modules expose the SAME
 *     spec'd AuthorityType, and the Anvil emit doesn't reference
 *     `spl_token_2022::` directly (the cpi_spl_set_authority kind
 *     emits a hand-rolled instruction with inlined program ID), so
 *     the rewrite is invisible to runtime correctness.
 *
 * (b) cpi_spl_set_authority hardcodes Token-2022 program ID.
 *     The source declares `token_program: Interface<'info, TokenInterface>`
 *     (runtime dispatch — works with either Token or Token-2022 depending
 *     on which program is passed in the accounts list). But the Anvil
 *     emit for cpi_spl_set_authority inlines a Token-2022 program ID
 *     constant and CPIs to that regardless of the runtime account.
 *     This is a cousin of the 2026-05-18 visitor bug fix for token
 *     transfers (`tokenProgramArg` was dropped for transfers under
 *     Interface<TokenInterface>); the same fix has not yet been
 *     ported to set_authority. This fixture pins both Anchor + Anvil
 *     runs to Token-2022 so both runs converge on the hardcoded ID —
 *     the byte-equal compare is still meaningful (state writes +
 *     post-CPI owner reassignment), but the dispatch path is not
 *     exercised. When the emit is fixed to honor runtime dispatch,
 *     this fixture should swap to the regular Token program to
 *     exercise the dispatch path. See:
 *     project-autonomous-2026-05-18-late.md
 * ──────────────────────────────────────────────────────────────────────
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMint2Instruction,
  createInitializeAccount3Instruction,
  createMintToInstruction,
} from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { sendSetupTx } from "../differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

// Use coral-anchor's tests/escrow program (single-file Anchor program with
// the canonical PaulX-tutorial-inspired escrow flow). The crate has path-
// deps on anchor-lang/anchor-spl under ../../../../lang and ../../../../spl,
// so the reference build MUST use anchorReferenceCrateDir to cargo-build
// the upstream crate verbatim.
export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/tests/escrow/programs/escrow/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/escrow/programs/escrow`;
// PROGRAM_ID matches declare_id! in lib.rs verbatim. Validated as a 32-byte
// base58 decode below at module load.
export const PROGRAM_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";
// Sanity-check: 32-byte decode. Catches a copy-paste typo in declare_id!
// before the harness wastes a full SBF build on a doomed program ID.
if (new PublicKey(PROGRAM_ID).toBuffer().length !== 32) {
  throw new Error(`coral-escrow PROGRAM_ID is not 32 bytes: ${PROGRAM_ID}`);
}

// "escrow" seed — must match ESCROW_PDA_SEED in lib.rs verbatim. The CPI
// inside initialize_escrow uses `Pubkey::find_program_address(&[b"escrow"],
// program_id)` and passes the resulting PDA as the new authority on the
// deposit token account. The byte-equal compare on deposit_token_account
// only matches when both Anchor + Anvil derive the SAME PDA.
const ESCROW_PDA_SEED = Buffer.from("escrow");

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file Anchor program. Bypass buildProjectSource for the same
  // reason coral-multisig does: the normalizer rewrites `error!(X)` to
  // `ProgramError::from(X)` which would break the reference build (the
  // reference uses anchorReferenceCrateDir, but the Anvil parser also
  // accepts the raw form). Feeding the raw bytes serves both paths.
  let src = readFileSync(LIB_RS, "utf-8");
  // Scaffold workaround (a) — see docstring. Routes AuthorityType through
  // anchor_spl::token's thin spl_token_interface re-export.
  src = src.replace(
    "token_2022::spl_token_2022::instruction::AuthorityType",
    "token::spl_token::instruction::AuthorityType",
  );
  return src;
}

export interface InitializeEscrowCtx {
  payer: Keypair;
  initializer: Keypair;
  mint: Keypair;
  depositTokenAccount: Keypair;
  receiveTokenAccount: Keypair;
  escrowAccount: Keypair;
  receiveTokenOwner: Keypair;
  escrowPda: PublicKey;
  initializerAmount: bigint;
  takerAmount: bigint;
  decimals: number;
  preMintRaw: bigint;
}

export async function setupInitializeEscrow(): Promise<InitializeEscrowCtx> {
  // Same keypair generation for both Anchor + Anvil runs — defineDifferential
  // calls setup() exactly once and re-uses the ctx for both scenarios, so
  // every Keypair.generate() here produces identical bytes across runs.
  const payer = Keypair.generate();
  const initializer = Keypair.generate();
  const mint = Keypair.generate();
  const depositTokenAccount = Keypair.generate();
  const receiveTokenAccount = Keypair.generate();
  const escrowAccount = Keypair.generate();
  // Some owner for the receive token account. The program only reads the
  // pubkey, never the underlying authority — but the SPL Token Account
  // still requires SOME owner. Pick a deterministic keypair.
  const receiveTokenOwner = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [ESCROW_PDA_SEED],
    programId,
  );
  const decimals = 6;
  const initializerAmount = 100n;
  const takerAmount = 250n;
  // Pre-mint enough that the deposit account holds >= initializerAmount
  // (constraint check in the InitializeEscrow struct).
  const preMintRaw = 1_000n;
  return {
    payer,
    initializer,
    mint,
    depositTokenAccount,
    receiveTokenAccount,
    escrowAccount,
    receiveTokenOwner,
    escrowPda,
    initializerAmount,
    takerAmount,
    decimals,
    preMintRaw,
  };
}

export async function callInitializeEscrow(
  svm: LiteSVM,
  ctx: InitializeEscrowCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
  // initializer pays for `escrow_account` rent (Anchor `payer = initializer`),
  // so it needs funding too.
  svm.airdrop(ctx.initializer.publicKey, BigInt(10_000_000_000));

  // Setup tx: create+init mint, create+init deposit token account (owner =
  // initializer so the set_authority CPI succeeds — authority must sign),
  // mint tokens to the deposit account, create+init receive token account.
  // ALL Token-2022 — see fixture docstring (b) for why the runtime path
  // is pinned to Token-2022 rather than the regular Token program.
  const mintRent = Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE)));
  const accountRent = Number(svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE)));
  const setupTx = new Transaction()
    // Mint account, owned by Token-2022.
    .add(SystemProgram.createAccount({
      fromPubkey: ctx.payer.publicKey,
      newAccountPubkey: ctx.mint.publicKey,
      lamports: mintRent,
      space: MINT_SIZE,
      programId: TOKEN_2022_PROGRAM_ID,
    }))
    .add(createInitializeMint2Instruction(
      ctx.mint.publicKey,
      ctx.decimals,
      ctx.payer.publicKey,
      null,
      TOKEN_2022_PROGRAM_ID,
    ))
    // Deposit token account (owner = initializer).
    .add(SystemProgram.createAccount({
      fromPubkey: ctx.payer.publicKey,
      newAccountPubkey: ctx.depositTokenAccount.publicKey,
      lamports: accountRent,
      space: ACCOUNT_SIZE,
      programId: TOKEN_2022_PROGRAM_ID,
    }))
    .add(createInitializeAccount3Instruction(
      ctx.depositTokenAccount.publicKey,
      ctx.mint.publicKey,
      ctx.initializer.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ))
    // Mint preMintRaw tokens to the deposit account so the constraint
    // `amount >= initializer_amount` holds.
    .add(createMintToInstruction(
      ctx.mint.publicKey,
      ctx.depositTokenAccount.publicKey,
      ctx.payer.publicKey,
      ctx.preMintRaw,
      [],
      TOKEN_2022_PROGRAM_ID,
    ))
    // Receive token account (any owner — only its pubkey is read).
    .add(SystemProgram.createAccount({
      fromPubkey: ctx.payer.publicKey,
      newAccountPubkey: ctx.receiveTokenAccount.publicKey,
      lamports: accountRent,
      space: ACCOUNT_SIZE,
      programId: TOKEN_2022_PROGRAM_ID,
    }))
    .add(createInitializeAccount3Instruction(
      ctx.receiveTokenAccount.publicKey,
      ctx.mint.publicKey,
      ctx.receiveTokenOwner.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ));
  sendSetupTx(
    svm,
    setupTx,
    ctx.payer.publicKey,
    [ctx.payer, ctx.mint, ctx.depositTokenAccount, ctx.receiveTokenAccount],
    "setup (mint + deposit + receive token accounts)",
  );

  // Anchor arg encoding (borsh): initializer_amount u64 LE, taker_amount u64 LE.
  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("initialize_escrow"),
      encodeU64LE(ctx.initializerAmount),
      encodeU64LE(ctx.takerAmount),
    ),
  );

  // Account ordering MUST mirror InitializeEscrow struct verbatim:
  //   initializer (Signer, mut)
  //   initializer_deposit_token_account (InterfaceAccount<TokenAccount>, mut)
  //   initializer_receive_token_account (InterfaceAccount<TokenAccount>)
  //   escrow_account (Account<EscrowAccount>, init, mut)
  //   system_program
  //   token_program  — pass TOKEN_2022_PROGRAM_ID; see docstring (b).
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.initializer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.depositTokenAccount.publicKey, isSigner: false, isWritable: true },
      { pubkey: ctx.receiveTokenAccount.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.escrowAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(initIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // payer covers tx fees + airdrop slack; initializer signs as the ix-level
  // Signer + funds the escrow_account init via `payer = initializer`;
  // escrowAccount signs as the freshly-init'd account.
  tx.sign(ctx.payer, ctx.initializer, ctx.escrowAccount);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`initialize_escrow failed: ${txFailureMessage(r)}`);
  }
}

export function escrowAccountsToCompare(ctx: InitializeEscrowCtx) {
  // escrow_account: pure state write (5 fields from ix args + account pubkeys).
  // deposit_token_account: set_authority CPI reassigns the owner field
  // (bytes 32..64 of the SPL TokenAccount layout) from initializer to the
  // escrow PDA. The Anvil emit must produce the identical SPL TokenAccount
  // post-image. Both surfaces gate a different class of correctness.
  return [
    { pubkey: ctx.escrowAccount.publicKey, label: "escrow_account" },
    { pubkey: ctx.depositTokenAccount.publicKey, label: "deposit_token_account" },
  ];
}
