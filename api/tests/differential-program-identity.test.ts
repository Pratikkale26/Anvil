/**
 * #17 — Program<'info, T> identity verification, with revert-parity.
 *
 * Anchor's `Program<'info, Token>` constraint rejects any account whose key
 * isn't the SPL Token program id (ErrorCode::InvalidProgramId). Before #17,
 * Anvil bound the program account bare with no check, so a substituted program
 * account was accepted — and some CPI emit paths read that passed account's key
 * (`AccountMeta::new(token_program.key(), …)`), making it a CPI-redirect vector.
 *
 * The handler is trivial: the `Program<Token>` constraint is validated by Anchor
 * (and now by Anvil's pre-check) regardless of whether the body uses the
 * account, so this isolates the identity check as the only thing under test.
 *
 *  - Happy path: token_program = the real SPL Token program → both runtimes OK.
 *  - Attack path: token_program = the System program (a real, executable, but
 *    WRONG-key program) → Anchor reverts (InvalidProgramId); Anvil must revert
 *    too (the #17 check). compareTxOutcomes asserts the ok/revert sequence
 *    matches.
 *
 * Both Anvil targets — the key-comparison idiom differs (pinocchio
 * `x.key() != &ID` vs native `*x.key != ID`).
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
use anchor_spl::token::Token;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod prog_identity {
    use super::*;
    pub fn touch(_ctx: Context<Touch>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Touch<'info> {
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
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
  // Loads the real SPL Token program at TOKEN_PROGRAM_ID so the happy path's
  // Program<Token> constraint (key + executable) is satisfiable.
  svm.withDefaultPrograms();
  svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

  // HAPPY — real token program → OK on both runtimes.
  send(svm, ctx, programId, TOKEN_PROGRAM_ID);
  // ATTACK — System program in the token_program slot: real + executable but
  // WRONG key → Anchor reverts (InvalidProgramId); Anvil must revert too.
  send(svm, ctx, programId, SystemProgram.programId);
}

for (const target of ["pinocchio", "native"] as const) {
  defineDifferential({
    fixtureName: `program-identity-${target}`,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: `prog_identity_${target}_diff`,
    anchorExtraDeps: `anchor-spl = "0.31"`,
    anvilTarget: target,
    compareTxOutcomes: true,

    setup: async (): Promise<Ctx> => ({ payer: Keypair.generate() }),
    callScript,
    accountsToCompare: () => [],
  });
}
