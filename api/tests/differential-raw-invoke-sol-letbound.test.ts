/**
 * Raw invoke / invoke_signed of a LET-BOUND system_instruction::transfer (#20).
 *
 * Companion to differential-raw-invoke-sol (the inline-builder form). The
 * far more common real-world shape binds the instruction first:
 *
 *     let ix = system_instruction::transfer(from.key, to.key, amount);
 *     invoke_signed(&ix, &[…], &[&[seeds]])?;
 *
 * The body-classifier records the single, never-mutated `let ix = transfer(…)`
 * binding, drops the let, and folds the downstream `invoke[_signed](&ix, …)`
 * into the byte-equal-proven cpi_system_transfer kind. This proves that fold
 * is byte-equal on both targets across deposit (unsigned `invoke`) and
 * withdraw (PDA-signed `invoke_signed`). If the dataflow look-back resolved the
 * wrong binding, swapped from/to, or dropped the seeds, the vault PDA's
 * residual lamports diverge from the Anchor reference here.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "AncB5CMLfioP259UvMJoUBy26SEnpc9mzhxzCN1dbAnC";

const SOURCE = `use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod raw_vault_lb {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.authority = ctx.accounts.authority.key();
        vault_state.bump = ctx.bumps.vault_state;
        vault_state.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<VaultAction>, amount: u64) -> Result<()> {
        let ix = system_instruction::transfer(
            ctx.accounts.authority.key,
            ctx.accounts.vault.key,
            amount,
        );
        invoke(
            &ix,
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.vault.to_account_info(),
            ],
        )?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<VaultAction>, amount: u64) -> Result<()> {
        let bump = ctx.accounts.vault_state.vault_bump;
        let authority_key = ctx.accounts.authority.key();
        let ix = system_instruction::transfer(
            ctx.accounts.vault.key,
            ctx.accounts.authority.key,
            amount,
        );
        invoke_signed(
            &ix,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.authority.to_account_info(),
            ],
            &[&[b"vault", authority_key.as_ref(), &[bump]]],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = 8 + VaultState::INIT_SPACE,
        seeds = [b"vault_state", authority.key().as_ref()], bump)]
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: PDA that holds SOL
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct VaultAction<'info> {
    #[account(mut, seeds = [b"vault_state", authority.key().as_ref()], bump = vault_state.bump)]
    pub vault_state: Account<'info, VaultState>,
    /// CHECK: PDA that holds SOL
    #[account(mut, seeds = [b"vault", authority.key().as_ref()], bump = vault_state.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultState {
    pub authority: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
}
`;

function defineLbFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "raw_vault_lb_native_diff" : "raw_vault_lb_anchor_diff",

    setup: async () => {
      const authority = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [vaultState] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_state"), authority.publicKey.toBuffer()],
        programId,
      );
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), authority.publicKey.toBuffer()],
        programId,
      );
      return { authority, vaultState, vaultPda };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));
      const keys = [
        { pubkey: ctx.vaultState, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const initIx = new TransactionInstruction({
        programId, keys, data: Buffer.from(anchorIxDiscriminator("initialize")),
      });
      const depositIx = new TransactionInstruction({
        programId, keys,
        data: Buffer.from(concatBytes(anchorIxDiscriminator("deposit"), encodeU64LE(500_000_000n))),
      });
      const withdrawIx = new TransactionInstruction({
        programId, keys,
        data: Buffer.from(concatBytes(anchorIxDiscriminator("withdraw"), encodeU64LE(200_000_000n))),
      });
      for (const ix of [initIx, depositIx, withdrawIx]) {
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.authority.publicKey;
        tx.sign(ctx.authority);
        const r = svm.sendTransaction(tx);
        if (isTxFailure(r)) throw new Error(`raw-vault-lb tx failed: ${txFailureMessage(r)}`);
      }
    },

    accountsToCompare: (ctx) => [
      { pubkey: ctx.vaultState, label: "vault_state" },
      { pubkey: ctx.vaultPda, label: "vault_pda" },
    ],
  });
}

defineLbFixture("raw-invoke-sol-letbound");
defineLbFixture("raw-invoke-sol-letbound-native", "native");
