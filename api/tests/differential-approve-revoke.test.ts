/**
 * approve / revoke differential (#38) — the SPL Token delegation pair.
 *
 * Pinocchio emits `spl_token_approve[_signed]` / `spl_token_revoke[_signed]`
 * helpers wrapping pinocchio_token::instructions::{Approve, Revoke}; Native
 * emits inline spl_token::instruction::{approve, revoke} + invoke. This is
 * the runtime gate on both: if either miscounts the delegate COption tag,
 * swaps source/delegate, or drops the amount, the token-account byte-compare
 * after approve (delegate + delegated_amount set) or after revoke (delegate
 * cleared, delegated_amount zeroed) diverges.
 *
 * Source inlined (no demo-programs entry) so the feature ships without
 * corpus-coverage bookkeeping; the shape is a minimal two-instruction
 * program that does nothing but the two CPIs.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  ACCOUNT_SIZE,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
  createMintToInstruction,
  createApproveInstruction,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "De1eg8teAppRove1111111111111111111111111111";

const SRC = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Approve, Revoke, Token, TokenAccount};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod delegate_token {
    use super::*;

    pub fn delegate(ctx: Context<Delegate>, amount: u64) -> Result<()> {
        token::approve(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Approve {
                    to: ctx.accounts.token_account.to_account_info(),
                    delegate: ctx.accounts.delegate.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    pub fn undelegate(ctx: Context<Undelegate>) -> Result<()> {
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Revoke {
                source: ctx.accounts.token_account.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ))?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Delegate<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,
    /// CHECK: delegate pubkey only
    pub delegate: AccountInfo<'info>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Undelegate<'info> {
    #[account(mut)]
    pub token_account: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`;

interface Ctx {
  payer: InstanceType<typeof Keypair>;
  authority: InstanceType<typeof Keypair>;
  delegate: InstanceType<typeof Keypair>;
  mint: InstanceType<typeof Keypair>;
  tokenAccount: InstanceType<typeof Keypair>;
}

const setup = async (): Promise<Ctx> => ({
  payer: Keypair.generate(),
  authority: Keypair.generate(),
  delegate: Keypair.generate(),
  mint: Keypair.generate(),
  tokenAccount: Keypair.generate(),
});

/** Mint + token account owned by `authority`, minted 1000 tokens. When
 *  `preApprove` is set, an SPL-level approve seeds an existing delegate so a
 *  later program `revoke` has something to clear (non-vacuous revoke test). */
function fundAndInit(
  svm: LiteSVM, ctx: Ctx, preApprove?: { delegate: PublicKey; amount: bigint },
): void {
  svm.withDefaultPrograms().withNativeMints();
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
  const mintRent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
  const acctRent = svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE));
  const tx = new Transaction()
    .add(SystemProgram.createAccount({
      fromPubkey: ctx.payer.publicKey, newAccountPubkey: ctx.mint.publicKey,
      lamports: Number(mintRent), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID,
    }))
    .add(createInitializeMintInstruction(ctx.mint.publicKey, 6, ctx.payer.publicKey, null))
    .add(SystemProgram.createAccount({
      fromPubkey: ctx.payer.publicKey, newAccountPubkey: ctx.tokenAccount.publicKey,
      lamports: Number(acctRent), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID,
    }))
    .add(createInitializeAccountInstruction(ctx.tokenAccount.publicKey, ctx.mint.publicKey, ctx.authority.publicKey))
    .add(createMintToInstruction(ctx.mint.publicKey, ctx.tokenAccount.publicKey, ctx.payer.publicKey, 1000n));
  if (preApprove) {
    tx.add(createApproveInstruction(
      ctx.tokenAccount.publicKey, preApprove.delegate, ctx.authority.publicKey, preApprove.amount,
    ));
  }
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  const signers = preApprove
    ? [ctx.payer, ctx.mint, ctx.tokenAccount, ctx.authority]
    : [ctx.payer, ctx.mint, ctx.tokenAccount];
  tx.sign(...signers);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) throw new Error(`setup failed: ${txFailureMessage(r)}`);
}

function sendProgramIx(
  svm: LiteSVM, ctx: Ctx, ix: TransactionInstruction, label: string,
): void {
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ctx.authority);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) throw new Error(`${label} failed: ${txFailureMessage(r)}`);
}

const common = {
  programIdBase58: PROGRAM_ID,
  anchorSource: SRC,
  anchorPackageName: "delegate_token_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"
spl-token = "7.0"`,
  setup,
  // SPL-layout token account (no Anchor disc). delegate COption (bytes
  // 76..108) + delegated_amount (121..129) carry the signal.
  stripDiscriminator: false,
  accountsToCompare: (ctx: Ctx) => [
    { pubkey: ctx.tokenAccount.publicKey, label: "token_account" },
  ],
};

// ── approve: fresh account → program.delegate(250) → delegate + amount set.
//    Non-vacuous: a silent no-op on Anvil leaves the delegate COption empty
//    while Anchor sets it, so the buffers diverge.
defineDifferential({
  ...common,
  fixtureName: "approve",
  callScript: async (svm: LiteSVM, ctx: Ctx, programId: PublicKey) => {
    fundAndInit(svm, ctx);
    sendProgramIx(svm, ctx, new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.tokenAccount.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.delegate.publicKey, isSigner: false, isWritable: false },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("delegate"),
        new Uint8Array(new BigUint64Array([250n]).buffer),
      )),
    }), "delegate");
  },
});

// ── revoke: account pre-approved (delegate D1/500 via SPL) →
//    program.undelegate() → delegate COption + delegated_amount cleared.
//    Non-vacuous: a silent no-op on Anvil keeps the pre-seeded delegate while
//    Anchor clears it.
defineDifferential({
  ...common,
  fixtureName: "revoke",
  callScript: async (svm: LiteSVM, ctx: Ctx, programId: PublicKey) => {
    fundAndInit(svm, ctx, { delegate: ctx.delegate.publicKey, amount: 500n });
    sendProgramIx(svm, ctx, new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.tokenAccount.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("undelegate")),
    }), "undelegate");
  },
});
