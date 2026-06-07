/**
 * PDA signer seed = another account's `.key()`, with a LET-BOUND bump
 * (`let bump = ctx.bumps.vault;`) passed via a `let seeds = …` array to
 * `CpiContext::new_with_signer` (hard-sweep F6, #24). The distinct `.key()`
 * sibling of F2.
 *
 * The vault PDA is derived from `owner.key()`. Pinocchio HEAD mis-set the seed
 * state account to the seed SOURCE (`owner`) — because the bump is let-bound,
 * so `&[bump]` (not `ctx.bumps.vault`) is what appears in the seed list and the
 * pass-1 bump detector misses it — then the `.key()` rewrite branch turned
 * `owner.key()` into the PDA's OWN key `vault.key()`. A PDA can't be derived
 * from a seed list containing its own key, so invoke_signed fails and the SOL
 * withdrawal silently reverts (funds locked). Native was always correct.
 *
 * TEETH (compareTxOutcomes + vault lamports): payout(0.3 SOL) vault -> owner.
 *   - Anchor / fixed-Anvil: seed = owner.key() -> derives vault -> valid signer
 *     -> transfer succeeds -> vault drops 0.3 SOL.
 *   - Pinocchio HEAD: seed = vault.key() -> wrong/unsignable PDA ->
 *     invoke_signed fails -> tx reverts -> vault unchanged.
 * So Pinocchio diverges on HEAD (outcome ok->revert AND vault lamports); the
 * fix matches Anchor. Native passes on HEAD and on the fix (control).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROGRAM_ID = "LcR2zuz4oH2aXECzDCUKk4rS4fw8zKuea6LcHcjaNjm";

const SRC = `use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod vault_payout {
    use super::*;
    pub fn payout(ctx: Context<Payout>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[b"vault", ctx.accounts.owner.key.as_ref(), &[bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Payout<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: PDA vault holding lamports
    #[account(mut, seeds = [b"vault", owner.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
`;

function defineFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SRC,
    anchorPackageName: anvilTarget === "native"
      ? "vault_payout_native_diff"
      : "vault_payout_anchor_diff",
    compareTxOutcomes: true,

    setup: async () => {
      const programId = new PublicKey(PROGRAM_ID);
      const owner = Keypair.generate();
      const [vaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault"), owner.publicKey.toBuffer()],
        programId,
      );
      return { owner, vaultPda };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.owner.publicKey, BigInt(2_000_000_000));
      // Fund the vault PDA with 1 SOL (system-owned, holds lamports).
      svm.airdrop(ctx.vaultPda, BigInt(1_000_000_000));

      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("payout"), encodeU64LE(300_000_000n))),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.owner.publicKey;
      tx.sign(ctx.owner);
      svm.sendTransaction(tx); // tolerate failure — HEAD-Pinocchio is expected to revert
    },

    accountsToCompare: (ctx) => [
      // vault PDA residual lamports — proves the signed transfer moved the SOL.
      { pubkey: ctx.vaultPda, label: "vault_pda" },
    ],
  });
}

defineFixture("pda-seed-keyref-letbump");
defineFixture("pda-seed-keyref-letbump-native", "native");
