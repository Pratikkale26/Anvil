/**
 * F7 / #22 TEETH — a custom #[account] state struct with a field NAMED `amount`
 * must read the STRUCT field, not SPL token-account byte-64. Pre-fix Anvil
 * substituted `ctx.accounts.pool.amount` → `token_account_amount(pool)?`
 * unconditionally (name-based, no type check), reading byte-64 of an unrelated
 * custom state — a silent money-math corruption, validator-clean.
 *
 * Pool layout (8-byte Anchor disc + fields):
 *   disc[0..8] | authority[8..40] | bump[40] | amount[41..49] | reserve[49..113]
 * The REAL `amount` (a u64) sits at byte 41 = 1000. SPL token-account `.amount`
 * lives at byte 64 — which here falls inside `reserve` (offset 64 = reserve[15])
 * and is seeded to a DIFFERENT value, 5000. So:
 *   - Anchor / Anvil-fix read pool.amount (the struct field @41) = 1000
 *   - Anvil-HEAD reads token_account_amount (byte-64) = 5000
 *
 * `snapshot` writes `pool.amount + vault.amount` into record.value. The real
 * token account `vault` (balance 0) is what makes HEAD even COMPILE: the
 * `token_account_amount` helper is only emitted when the instruction reads a
 * token-like account's `.amount`. Without `vault`, HEAD emits a call to a
 * helper it never defines (E0425) — a loud compile error, not the silent
 * corruption. With `vault` present (amount=0), the helper IS emitted and HEAD
 * silently reads pool byte-64: record.value = 5000+0 vs Anchor/fix 1000+0.
 *
 * The 113-byte Pool is >72 bytes so HEAD's token_account_amount helper
 * (`data.len() < 72` guard) reads the wrong VALUE, not a length revert.
 */
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  sha256,
  Keypair,
  PublicKey,
  LiteSVM,
  mkTestProgramId,
} from "./differential-harness.ts";
import { setupMintAndAtaIxs, sendSetupTx } from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = mkTestProgramId("AmtGateTestAccount1111111111111111111111111");

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
declare_id!("${PROGRAM_ID}");

#[program]
pub mod amount_field_gate {
    use super::*;
    pub fn snapshot(ctx: Context<Snapshot>) -> Result<()> {
        ctx.accounts.record.value = ctx.accounts.pool.amount + ctx.accounts.vault.amount;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Snapshot<'info> {
    pub pool: Account<'info, Pool>,
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)] pub record: Account<'info, Record>,
    pub signer: Signer<'info>,
}

#[account]
pub struct Pool { pub authority: Pubkey, pub bump: u8, pub amount: u64, pub reserve: [u8; 64] }

#[account]
pub struct Record { pub value: u64 }
`;

const POOL_DISC = sha256(new TextEncoder().encode("account:Pool")).slice(0, 8);
const RECORD_DISC = sha256(new TextEncoder().encode("account:Record")).slice(0, 8);

function poolData(amountAt41: bigint, valueAt64: bigint): Buffer {
  const buf = Buffer.alloc(113); // 8 disc + 32 auth + 1 bump + 8 amount + 64 reserve
  Buffer.from(POOL_DISC).copy(buf, 0);
  buf.writeBigUInt64LE(amountAt41, 41); // the REAL Pool.amount struct field
  buf.writeBigUInt64LE(valueAt64, 64);  // byte-64 (inside reserve) — SPL .amount offset
  return buf;
}

function recordData(value: bigint): Buffer {
  const buf = Buffer.alloc(16); // 8 disc + 8 value
  Buffer.from(RECORD_DISC).copy(buf, 0);
  buf.writeBigUInt64LE(value, 8);
  return buf;
}

defineDifferential({
  fixtureName: "amount-field-gate",
  programIdBase58: PROGRAM_ID,
  anchorSource: SOURCE,
  anchorPackageName: "amount_field_gate_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const authority = Keypair.generate();
    const mint = Keypair.generate();
    const pool = Keypair.generate();
    const record = Keypair.generate();
    const vault = getAssociatedTokenAddressSync(mint.publicKey, authority.publicKey);
    return { payer, authority, mint, pool, record, vault };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // Real spl_token mint + vault ATA, balance 0 (only needs to exist so the
    // token_account_amount helper is emitted — its .amount contributes 0).
    const setupTx = new Transaction().add(
      ...setupMintAndAtaIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, ctx.vault, ctx.authority.publicKey, 6, 0n),
    );
    sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mint], "setup");

    // Pool: struct amount (@41) = 1000, byte-64 region (@64) = 5000.
    const pData = poolData(1000n, 5000n);
    svm.setAccount(ctx.pool.publicKey, {
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(pData.length))),
      data: new Uint8Array(pData),
      owner: programId,
      executable: false,
    });
    // Record: value = 0 (overwritten by snapshot).
    const rData = recordData(0n);
    svm.setAccount(ctx.record.publicKey, {
      lamports: Number(svm.minimumBalanceForRentExemption(BigInt(rData.length))),
      data: new Uint8Array(rData),
      owner: programId,
      executable: false,
    });

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.pool.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.vault, isSigner: false, isWritable: false },
        { pubkey: ctx.record.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("snapshot")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`snapshot failed: ${txFailureMessage(r)}`);
  },

  // Anchor+fix write record.value = 1000 (+0); HEAD writes 5000 (+0).
  accountsToCompare: (ctx) => [
    { pubkey: ctx.record.publicKey, label: "record" },
  ],
});
