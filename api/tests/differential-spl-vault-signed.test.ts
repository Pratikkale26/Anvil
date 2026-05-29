/**
 * PDA-signed SPL transfer via a CpiContext impl-method helper + with_signer.
 *
 * This is the gap the existing spl-transfer fixture leaves open: that one
 * covers the UNSIGNED helper form (`CpiContext::new` + a regular signer).
 * NOTHING covered the PDA-signed form — `ctx.accounts.transfer_ctx().with_signer(seeds)`
 * — at runtime, even though it's the canonical vault/escrow withdraw pattern
 * (the program signs as the PDA that owns the vault).
 *
 * The emit *looks* right (helper inlines, bump derives, signer seeds appear),
 * but "compiles" ≠ "moves the right lamports under the right authority". If
 * the inlined CPI drops the signer seeds, picks the wrong authority slot, or
 * mis-encodes the amount, the vault/dest token buffers diverge here.
 */
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import {
  createMintIxs,
  createTokenAccountIxs,
  mintToIx,
  sendSetupTx,
} from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "3CUX6AFky1hZHNhkMRqkNJnRZ4wVUzHiUWMy4vdCL7HU";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod spl_vault {
    use super::*;
    // Withdraw from a PDA-owned vault: the program signs as the vault
    // authority via the impl-method helper + with_signer(seeds).
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[b"vault-auth", &[bump]];
        let signer = &[&seeds[..]];
        token::transfer(ctx.accounts.transfer_ctx().with_signer(signer), amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub dest: Account<'info, TokenAccount>,
    /// CHECK: PDA authority that owns the vault; validated by the seeds constraint.
    #[account(seeds = [b"vault-auth"], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
}

impl<'info> Withdraw<'info> {
    fn transfer_ctx(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.vault.to_account_info(),
                to: self.dest.to_account_info(),
                authority: self.vault_authority.to_account_info(),
            },
        )
    }
}
`;

function defineVaultFixture(fixtureName: string, anvilTarget?: "native") {
defineDifferential({
  fixtureName,
  anvilTarget,
  programIdBase58: PROGRAM_ID,
  anchorSource: SOURCE,
  anchorPackageName: anvilTarget === "native" ? "spl_vault_native_diff" : "spl_vault_anchor_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,

  setup: async () => {
    const payer = Keypair.generate();
    const mintAuth = Keypair.generate();
    const mint = Keypair.generate();
    const vault = Keypair.generate();
    const dest = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [vaultAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault-auth")],
      programId,
    );
    return { payer, mintAuth, mint, vault, dest, vaultAuthority };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    // mint + PDA-owned vault + dest, then fund the vault.
    const setupTx = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.mintAuth.publicKey, ctx.mintAuth.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.vault.publicKey, ctx.mint.publicKey, ctx.vaultAuthority))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.dest.publicKey, ctx.mint.publicKey, ctx.payer.publicKey))
      .add(mintToIx(ctx.mint.publicKey, ctx.vault.publicKey, ctx.mintAuth.publicKey, 1_000_000n));
    sendSetupTx(svm, setupTx, ctx.payer.publicKey,
      [ctx.payer, ctx.mint, ctx.vault, ctx.dest, ctx.mintAuth],
      "setup");

    // withdraw 250_000 from the PDA-owned vault → dest. The PDA is NOT a tx
    // signer — the program signs for it via with_signer(seeds).
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vault.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.dest.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultAuthority, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(
        anchorIxDiscriminator("withdraw"),
        encodeU64LE(250_000n),
      )),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`withdraw failed: ${txFailureMessage(r)}`);
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.vault.publicKey, label: "vault" },
    { pubkey: ctx.dest.publicKey, label: "dest" },
  ],
});
}

// Pinocchio (production default) + Native — both route signer seeds through the
// same regenerated `let seeds: &[&[u8]] = &[…]` block, so verify both compile + byte-equal.
defineVaultFixture("spl-vault-signed");
defineVaultFixture("spl-vault-signed-native", "native");
