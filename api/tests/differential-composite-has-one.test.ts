/**
 * F8 (#16) — nested composite `has_one` target resolution, revert-parity.
 *
 * `Nested { my_account, related: #[account(has_one = my_account)] }` flattened
 * inside `Check { my_account (top-level, SAME name), nested }`. Anchor resolves
 * the composite has_one to the NESTED `my_account`; before the fix Anvil
 * first-matched the TOP-LEVEL `my_account`.
 *
 * The two same-named accounts are given DISTINCT keys so the mis-target is
 * observable (the existing coral-relations-derivation fixture can't distinguish
 * — its PDAs share a seed, so both resolutions yield the same key):
 *
 *  - Happy: `related.my_account` == the NESTED my_account → both OK.
 *  - Attack: `related.my_account` == the TOP-LEVEL my_account (≠ nested) →
 *    Anchor REVERTS (the nested has_one fails); pre-fix Anvil would ACCEPT
 *    (it checked the top-level, which matches); post-fix Anvil REVERTS too.
 *
 * compareTxOutcomes asserts the [ok, ok, ok(happy), revert(attack)] sequence
 * matches. Both Anvil targets.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "DKiaFKUF6euvKSTayGsbhYhuk2py3xFoVHY7X5gZj1TS";

const SOURCE = `
use anchor_lang::prelude::*;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod composite_hasone {
    use super::*;
    pub fn init_related(ctx: Context<InitRelated>, authority: Pubkey) -> Result<()> {
        ctx.accounts.related.my_account = authority;
        Ok(())
    }
    pub fn check(ctx: Context<Check>) -> Result<()> {
        let _r = &ctx.accounts.nested.related;
        Ok(())
    }
}

#[account]
pub struct Related { pub my_account: Pubkey }

#[derive(Accounts)]
pub struct InitRelated<'info> {
    #[account(init, payer = payer, space = 8 + 32)]
    pub related: Account<'info, Related>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Nested<'info> {
    /// CHECK: only the key is used (has_one target)
    pub my_account: UncheckedAccount<'info>,
    #[account(has_one = my_account)]
    pub related: Account<'info, Related>,
}

#[derive(Accounts)]
pub struct Check<'info> {
    /// CHECK: top-level, SAME name as the nested target
    pub my_account: UncheckedAccount<'info>,
    pub nested: Nested<'info>,
}
`;

interface Ctx {
  payer: Keypair;
  topMyAccount: Keypair;   // top-level my_account (key A)
  nestedMyAccount: Keypair; // nested my_account (key B, ≠ A)
  relatedHappy: Keypair;   // related.my_account = B (matches nested)
  relatedAttack: Keypair;  // related.my_account = A (matches TOP-LEVEL only)
}

function initRelated(
  svm: LiteSVM,
  ctx: Ctx,
  programId: PublicKey,
  related: Keypair,
  authority: PublicKey,
): void {
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: related.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(anchorIxDiscriminator("init_related"), authority.toBytes()),
    ),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, related);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) throw new Error("init_related setup tx failed");
}

function check(
  svm: LiteSVM,
  ctx: Ctx,
  programId: PublicKey,
  related: PublicKey,
): void {
  // Flattened account order: top my_account, nested_my_account, nested_related.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.topMyAccount.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.nestedMyAccount.publicKey, isSigner: false, isWritable: false },
      { pubkey: related, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("check")),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  svm.sendTransaction(tx);
}

async function callScript(svm: LiteSVM, ctx: Ctx, programId: PublicKey): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // related.my_account = nested key (B) → valid; and = top-level key (A) → attack.
  initRelated(svm, ctx, programId, ctx.relatedHappy, ctx.nestedMyAccount.publicKey);
  initRelated(svm, ctx, programId, ctx.relatedAttack, ctx.topMyAccount.publicKey);

  // HAPPY — related.my_account (B) == nested my_account (B) → both OK.
  check(svm, ctx, programId, ctx.relatedHappy.publicKey);
  // ATTACK — related.my_account (A) == TOP-LEVEL only, ≠ nested (B) → Anchor
  // reverts; pre-fix Anvil (mis-targeting top-level) would accept; post-fix
  // Anvil reverts too.
  check(svm, ctx, programId, ctx.relatedAttack.publicKey);
}

for (const target of ["pinocchio", "native"] as const) {
  defineDifferential({
    fixtureName: `composite-has-one-${target}`,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: `composite_hasone_${target}_diff`,
    anvilTarget: target,
    compareTxOutcomes: true,

    setup: async (): Promise<Ctx> => ({
      payer: Keypair.generate(),
      topMyAccount: Keypair.generate(),
      nestedMyAccount: Keypair.generate(),
      relatedHappy: Keypair.generate(),
      relatedAttack: Keypair.generate(),
    }),
    callScript,
    accountsToCompare: () => [],
  });
}
