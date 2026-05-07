/**
 * Vesting differential — combines clock-pinning, SPL token CPI, AND msg!()
 * into one fixture. Heaviest fixture in the corpus by surface count.
 *
 * Exercises:
 *   - PDA-as-token-account (vault is `init token::*` with seeds — Anchor
 *     allocates via system::create_account at the PDA address, then
 *     initialize_account3 with the PDA itself as authority)
 *   - token::transfer CPI from grantor ATA → vault on create_vesting
 *   - clock-dependent vested_amount() math (linear over [start_ts, end_ts])
 *   - signer-seeded token::transfer CPI from vault → beneficiary ATA on
 *     release (vault is its own authority via PDA signer seeds)
 *
 * compareMsgLogs deliberately NOT enabled. vesting.rs uses formatted
 * msg!() (e.g. `msg!("Vesting created: {} tokens for {}", amount,
 * beneficiary)`); Pinocchio is no_std so it has no format!() and
 * Anvil's emit collapses these to the literal string with {}
 * placeholders unsubstituted. The msg!() text DIVERGES by design.
 * Documented as a follow-up emit gap; for byte-equal msg compare,
 * the program needs literal-only msg!() (see differential-staking).
 *
 * Scenario (clock pinned to T0 = 1_700_000_000, then warped to T0+500):
 *   T=T0:     create_vesting(total=1000, start=T0, cliff=T0+100, end=T0+1000)
 *             - transfers 1000 tokens grantor → vault
 *             - emits "Vesting created: 1000 tokens for <beneficiary>"
 *   T=T0+500: release()
 *             - vested = 1000 * 500/1000 = 500 tokens released
 *             - transfers 500 tokens vault → beneficiary ATA
 *             - emits "Released 500 tokens to beneficiary"
 *
 * Post-state byte-compares (3 always-on + 1 opt-in surface):
 *   - vesting PDA: total + released_amount + cliff/end + flags
 *   - vault: 500 tokens remaining (1000 − 500)
 *   - grantor ATA: 0 tokens (deposited all)
 *   - beneficiary ATA: 500 tokens
 *   - msg!() logs: 2 lines byte-equal
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  encodeI64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { Clock } from "litesvm";
import { setupMintAndAtaIxs, sendSetupTx } from "./differential-setup-helpers.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "vesting.rs");
const PROGRAM_ID = "Vest111111111111111111111111111111111111111";
const PIN_T0 = 1_700_000_000;

defineDifferential({
  fixtureName: "vesting",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "token_vesting_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,
  pinClockTimestamp: PIN_T0,
  pinClockSlot: 1,

  setup: async () => {
    const payer = Keypair.generate();
    const grantor = payer; // same keypair so we don't have to airdrop two
    const beneficiary = Keypair.generate();
    const mint = Keypair.generate();
    const programIdPk = new PublicKey(PROGRAM_ID);

    // vesting PDA: seeds = ["vesting", grantor.pubkey, beneficiary.pubkey]
    const [vestingPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vesting"), grantor.publicKey.toBuffer(), beneficiary.publicKey.toBuffer()],
      programIdPk,
    );
    // vault PDA: seeds = ["vault", vesting_pda]
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), vestingPda.toBuffer()],
      programIdPk,
    );
    const grantorAta = getAssociatedTokenAddressSync(mint.publicKey, grantor.publicKey);
    const beneficiaryAta = getAssociatedTokenAddressSync(mint.publicKey, beneficiary.publicKey);

    return { payer, grantor, beneficiary, mint, vestingPda, vaultPda, grantorAta, beneficiaryAta };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.beneficiary.publicKey, BigInt(1_000_000_000));

    // litesvm 0.7's harness-level pin only sets slot — unix_timestamp
    // doesn't advance enough between txs for our cliff math to fire.
    // Explicitly setClock() at PIN_T0 so create_vesting sees the right
    // start_ts boundary; we'll setClock() again before release.
    const setClockTo = (ts: number) => {
      svm.setClock(new Clock(BigInt(1), BigInt(ts), BigInt(0), BigInt(0), BigInt(ts)));
    };
    setClockTo(PIN_T0);

    // Setup: mint + grantor ATA with 1000 tokens minted.
    const setupTx = new Transaction().add(
      ...setupMintAndAtaIxs(
        svm, ctx.payer.publicKey, ctx.mint.publicKey, ctx.grantorAta,
        ctx.grantor.publicKey, 6, 1_000n,
      ),
    );
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mint], "setup");

    // ── create_vesting at T0. start=T0 (require start >= now), cliff=T0+100,
    // end=T0+1000, total=1000, revocable=false.
    const createIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.grantor.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.vestingPda, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.grantorAta, isSigner: false, isWritable: true },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("create_vesting"),
        ctx.beneficiary.publicKey.toBytes(),  // beneficiary: Pubkey (32 bytes)
        encodeU64LE(1_000n),                  // total_amount: u64
        encodeI64LE(BigInt(PIN_T0)),          // start_ts: i64
        encodeI64LE(BigInt(PIN_T0 + 100)),    // cliff_ts: i64
        encodeI64LE(BigInt(PIN_T0 + 1000)),   // end_ts: i64
        new Uint8Array([0]),                  // revocable: bool = false
      )),
    });
    const tx1 = new Transaction().add(createIx);
    tx1.recentBlockhash = svm.latestBlockhash();
    tx1.feePayer = ctx.grantor.publicKey;
    tx1.sign(ctx.grantor);
    const r1 = svm.sendTransaction(tx1);
    if (r1?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r1 as unknown as { err: () => { toString(): string }; meta: () => { logs: () => string[] } };
      throw new Error(`create_vesting failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
    }

    // Setup beneficiary ATA before release. Release does NOT init the
    // beneficiary's token account — it's #[account(mut)] only.
    const ataIx = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.beneficiaryAta, isSigner: false, isWritable: true },
        { pubkey: ctx.beneficiary.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(0),
    });
    const ataTx = new Transaction().add(ataIx);
    ataTx.recentBlockhash = svm.latestBlockhash();
    ataTx.feePayer = ctx.payer.publicKey;
    ataTx.sign(ctx.payer);
    const rAta = svm.sendTransaction(ataTx);
    if (rAta?.constructor?.name === "FailedTransactionMetadata") {
      const failed = rAta as unknown as { err: () => { toString(): string }; meta: () => { logs: () => string[] } };
      throw new Error(`create beneficiary ATA failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
    }

    // Advance clock to halfway through the vesting period (50% vested).
    setClockTo(PIN_T0 + 500);

    // ── release at T0+500 (50% vested).
    const releaseIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.beneficiary.publicKey, isSigner: true, isWritable: false },
        { pubkey: ctx.vestingPda, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.beneficiaryAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("release")),
    });
    const tx2 = new Transaction().add(releaseIx);
    tx2.recentBlockhash = svm.latestBlockhash();
    tx2.feePayer = ctx.beneficiary.publicKey;
    tx2.sign(ctx.beneficiary);
    const r2 = svm.sendTransaction(tx2);
    if (r2?.constructor?.name === "FailedTransactionMetadata") {
      const failed = r2 as unknown as { err: () => { toString(): string }; meta: () => { logs: () => string[] } };
      throw new Error(`release failed: ${failed.err().toString()}\nlogs:\n${failed.meta().logs().join("\n")}`);
    }
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.vestingPda, label: "vesting_pda" },
    { pubkey: ctx.vaultPda, label: "vault" },
    { pubkey: ctx.grantorAta, label: "grantor_ata" },
    { pubkey: ctx.beneficiaryAta, label: "beneficiary_ata" },
  ],
  // M7 8c local-let inference (post-slice 12) lets `releasable` and
  // `unvested` resolve to u64 via the checked-arithmetic chain
  // heuristic — vesting's 3 formatted msg!() lines (create, release,
  // revoke) all expand structurally + byte-equal Anchor's runtime
  // format!(). The 4th msg!() in close_vesting is `msg!("Vesting
  // account closed.")` (no args), already byte-equal. compareMsgLogs
  // verifies the full set order-significant.
  compareMsgLogs: true,
});
