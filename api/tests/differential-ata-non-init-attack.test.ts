/**
 * F2-full guard — non-init `associated_token` ADDRESS PIN, with revert-parity.
 *
 * A non-init `#[account(mut, associated_token::mint = mint, associated_token::authority = owner)]`
 * account carries a canonical-ATA address pin. Anchor derives the canonical ATA and
 * rejects a mismatch; before F2-full the emit consumed the account bare, so an
 * attacker could substitute any token account with the right mint+authority.
 *
 * - Happy path: `ata` = the canonical ATA → both runtimes OK, byte-equal post-state
 *   (proves the derivation is correct: a wrong seed-order/token-program would make
 *   Anvil revert here while Anchor succeeds).
 * - Attack path: a REAL token account with the correct mint + authority + balance but
 *   created at a NON-canonical address → Anchor reverts (ConstraintAssociated); Anvil
 *   must revert too (the F2-full check). A real-but-wrong-address account isolates the
 *   address pin as the ONLY failing constraint.
 */
import { Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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
  createAtaIx,
  mintToIx,
  sendSetupTx,
} from "./differential-setup-helpers.ts";

const PROGRAM_ID = "DKiaFKUF6euvKSTayGsbhYhuk2py3xFoVHY7X5gZj1TS";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, Mint, TokenAccount, Transfer};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod ata_pin {
    use super::*;
    pub fn drain(ctx: Context<Drain>, amount: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.ata.to_account_info(),
                    to: ctx.accounts.dest.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Drain<'info> {
    #[account(mut, associated_token::mint = mint, associated_token::authority = owner)]
    pub ata: Account<'info, TokenAccount>,
    #[account(mut)]
    pub dest: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub owner: Signer<'info>,
    pub token_program: Program<'info, Token>,
}
`;

defineDifferential({
  fixtureName: "ata-non-init-attack",
  programIdBase58: PROGRAM_ID,
  anchorSource: SOURCE,
  anchorPackageName: "ata_pin_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,
  // The attack send must REVERT on both runtimes; compare the ok/revert sequence.
  compareTxOutcomes: true,

  setup: async () => {
    const payer = Keypair.generate();
    const owner = Keypair.generate();
    const mint = Keypair.generate();
    const destAcct = Keypair.generate();
    const attackAcct = Keypair.generate();
    const canonicalAta = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey);
    return { payer, owner, mint, destAcct, attackAcct, canonicalAta };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.owner.publicKey, BigInt(1_000_000_000));

    // mint + canonical ATA(owner) + dest token account + the attack token account
    // (a REAL token account with the SAME mint + authority, at a non-canonical addr).
    const setup = new Transaction()
      .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.payer.publicKey))
      .add(createAtaIx(ctx.payer.publicKey, ctx.canonicalAta, ctx.owner.publicKey, ctx.mint.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.destAcct.publicKey, ctx.mint.publicKey, ctx.payer.publicKey))
      .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.attackAcct.publicKey, ctx.mint.publicKey, ctx.owner.publicKey))
      .add(mintToIx(ctx.mint.publicKey, ctx.canonicalAta, ctx.payer.publicKey, 1_000n))
      .add(mintToIx(ctx.mint.publicKey, ctx.attackAcct.publicKey, ctx.payer.publicKey, 1_000n));
    sendSetupTx(svm, setup, ctx.payer.publicKey, [ctx.payer, ctx.mint, ctx.destAcct, ctx.attackAcct], "setup");

    const drainIx = (ata: PublicKey) =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: ctx.destAcct.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: false },
          { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("drain"), encodeU64LE(100n))),
      });

    const send = (ix: TransactionInstruction) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer, ctx.owner);
      svm.sendTransaction(tx);
    };

    send(drainIx(ctx.canonicalAta));        // HAPPY — ok on both (canonical ATA)
    send(drainIx(ctx.attackAcct.publicKey)); // ATTACK — revert on both (address pin)
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.canonicalAta, label: "canonical_ata" },
    { pubkey: ctx.destAcct.publicKey, label: "dest" },
  ],
});
