/**
 * Raw invoke / invoke_signed of system_instruction::transfer (#20).
 *
 * Hand-rolled SOL movement — NOT the Anchor `system_program::transfer`
 * CpiContext helper — is the canonical "move lamports out of a PDA" idiom
 * that anchor-spl doesn't wrap. Before #20 the parser routed these bare
 * `invoke()` / `invoke_signed()` calls to the `cpi_custom` path, which
 * stubbed the WHOLE instruction as `unimplemented!()` on Pinocchio.
 *
 * #20 normalizes the inline-builder form
 *   `invoke_signed(&system_instruction::transfer(from, to, lamports), …, seeds)`
 * into the existing, byte-equal-proven `cpi_system_transfer` IR node, so the
 * emit is shared with the CpiContext path. This fixture proves the
 * normalization is byte-equal on BOTH targets across two surfaces:
 *   - deposit  → UNSIGNED   `invoke(&system_instruction::transfer(authority → vault), …)`
 *   - withdraw → PDA-SIGNED `invoke_signed(&system_instruction::transfer(vault → authority), …, &[&[b"vault", …, &[bump]]])`
 *
 * If the normalization swaps from/to, drops the signer seeds, or mis-reads
 * the lamport amount, the vault PDA's residual balance diverges here.
 * (Native cpi_system_transfer was previously unexercised by any differential
 * — this is its first byte-equal coverage too.)
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

const PROGRAM_ID = "BVteaLENkGN3Ze4yq6B1mvGiPPMAFEqi3dDgan64VeKA";

const SOURCE = `use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod raw_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let vault_state = &mut ctx.accounts.vault_state;
        vault_state.authority = ctx.accounts.authority.key();
        vault_state.bump = ctx.bumps.vault_state;
        vault_state.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    pub fn deposit(ctx: Context<VaultAction>, amount: u64) -> Result<()> {
        invoke(
            &system_instruction::transfer(
                ctx.accounts.authority.key,
                ctx.accounts.vault.key,
                amount,
            ),
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
        invoke_signed(
            &system_instruction::transfer(
                ctx.accounts.vault.key,
                ctx.accounts.authority.key,
                amount,
            ),
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

function defineRawVaultFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "raw_vault_native_diff" : "raw_vault_anchor_diff",

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
      // 2 SOL covers rent for vault_state + the deposit + tx fees.
      svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

      const keys = [
        { pubkey: ctx.vaultState, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];

      const initIx = new TransactionInstruction({
        programId, keys,
        data: Buffer.from(anchorIxDiscriminator("initialize")),
      });
      // deposit 0.5 SOL authority → vault (unsigned raw invoke)
      const depositIx = new TransactionInstruction({
        programId, keys,
        data: Buffer.from(concatBytes(anchorIxDiscriminator("deposit"), encodeU64LE(500_000_000n))),
      });
      // withdraw 0.2 SOL vault → authority (PDA-signed raw invoke_signed);
      // leaves 0.3 SOL in the vault, well above rent-exempt minimum.
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
        if (isTxFailure(r)) throw new Error(`raw-vault tx failed: ${txFailureMessage(r)}`);
      }
    },

    accountsToCompare: (ctx) => [
      // vault_state — layout + rent-allocation equality.
      { pubkey: ctx.vaultState, label: "vault_state" },
      // vault PDA — residual lamports after deposit/withdraw. The assertion
      // that the signed transfer moved exactly the right amount.
      { pubkey: ctx.vaultPda, label: "vault_pda" },
    ],
  });
}

// Pinocchio (production default) + Native — both regenerate the canonical
// signer-seeds prelude from the vault PDA's constraints, so verify both
// compile + byte-equal.
defineRawVaultFixture("raw-invoke-sol");
defineRawVaultFixture("raw-invoke-sol-native", "native");
