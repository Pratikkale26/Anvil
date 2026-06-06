/**
 * #20 — Interface<'info, TokenInterface> token_program identity, revert-parity.
 *
 * Anchor's `Interface<'info, TokenInterface>` accepts ONLY a member of the
 * token-program set {SPL Token, Token-2022} (anchor-spl's `Ids::ids()`), and
 * reverts otherwise. #17 shipped the single-id `Program<Token>` check; #20
 * extends it to the SET-membership case (a single hardcoded id would wrongly
 * reject the valid alternate). Before #20, Anvil bound the Interface program
 * account bare — a substituted program was accepted (CPI-redirect vector).
 *
 *  - Happy path: token_program = the real SPL Token program (member) → both OK.
 *  - Attack path: token_program = the System program (real, executable, but NOT
 *    a member) → Anchor reverts; Anvil must revert too (the #20 membership
 *    check). compareTxOutcomes asserts the ok/revert sequence matches.
 *
 * The OTHER member (Token-2022) is verified by differential-program-examples-
 * t22-basics, which passes TOKEN_2022_PROGRAM_ID through an Interface
 * token_program and now carries this check — a regression there would mean the
 * membership set wrongly excludes Token-2022.
 *
 * Both Anvil targets.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROGRAM_ID = "DKiaFKUF6euvKSTayGsbhYhuk2py3xFoVHY7X5gZj1TS";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenInterface;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod iface_identity {
    use super::*;
    pub fn touch(_ctx: Context<Touch>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Touch<'info> {
    pub signer: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
`;

interface Ctx {
  payer: Keypair;
}

function send(
  svm: LiteSVM,
  ctx: Ctx,
  programId: PublicKey,
  tokenProgram: PublicKey,
): void {
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("touch")),
  });
  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  svm.sendTransaction(tx);
}

async function callScript(svm: LiteSVM, ctx: Ctx, programId: PublicKey): Promise<void> {
  svm.withDefaultPrograms();
  svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

  // HAPPY — SPL Token (a member of TokenInterface's set) → OK on both.
  send(svm, ctx, programId, TOKEN_PROGRAM_ID);
  // ATTACK — System program: real + executable but NOT a member → Anchor
  // reverts; Anvil's #20 membership check must revert too.
  send(svm, ctx, programId, SystemProgram.programId);
}

for (const target of ["pinocchio", "native"] as const) {
  defineDifferential({
    fixtureName: `interface-identity-${target}`,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: `iface_identity_${target}_diff`,
    anchorExtraDeps: `anchor-spl = "0.31"`,
    anvilTarget: target,
    compareTxOutcomes: true,

    setup: async (): Promise<Ctx> => ({ payer: Keypair.generate() }),
    callScript,
    accountsToCompare: () => [],
  });
}
