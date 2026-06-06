/**
 * #21 — Program<'info, Metadata> (MPL Token Metadata) identity, revert-parity.
 *
 * Anchor's `Program<'info, Metadata>` checks key == metaqbxx… (+ executable);
 * #17/#20 closed the token programs, #21 adds the well-known Metadata + Memo
 * single-id programs. Before #21, Anvil bound the program account bare.
 *
 *  - Happy path: metadata_program = the metaqbxx id, with an executable program
 *    loaded there (we deploy a dummy .so at that address — Anchor's Program<T>
 *    check validates key + executable, NOT the program's code) → both OK.
 *  - Attack path: metadata_program = the System program (real, executable, but
 *    WRONG key) → Anchor reverts; Anvil must revert too (the #21 check).
 *
 * Both Anvil targets.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROGRAM_ID = "DKiaFKUF6euvKSTayGsbhYhuk2py3xFoVHY7X5gZj1TS";
const MPL_METADATA_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::metadata::Metadata;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod metadata_identity {
    use super::*;
    pub fn touch(_ctx: Context<Touch>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Touch<'info> {
    pub signer: Signer<'info>,
    pub metadata_program: Program<'info, Metadata>,
}
`;

interface Ctx {
  payer: Keypair;
}

function send(
  svm: LiteSVM,
  ctx: Ctx,
  programId: PublicKey,
  metadataProgram: PublicKey,
): void {
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: false },
      { pubkey: metadataProgram, isSigner: false, isWritable: false },
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
  svm.airdrop(ctx.payer.publicKey, BigInt(1_000_000_000));

  // HAPPY — the real MPL Metadata program id (an executable program is loaded
  // there via auxiliaryPrograms) → Program<Metadata> (key + executable) OK.
  send(svm, ctx, programId, new PublicKey(MPL_METADATA_ID));
  // ATTACK — System program: real + executable but WRONG key → Anchor reverts;
  // Anvil's #21 check must revert too.
  send(svm, ctx, programId, SystemProgram.programId);
}

for (const target of ["pinocchio", "native"] as const) {
  defineDifferential({
    fixtureName: `metadata-identity-${target}`,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: `metadata_identity_${target}_diff`,
    // anchor-spl's metadata module (the `Metadata` program type) is gated
    // behind the `metadata` feature.
    anchorExtraDeps: `anchor-spl = { version = "0.31", features = ["metadata"] }`,
    anvilTarget: target,
    compareTxOutcomes: true,
    // Deploy an executable program AT the MPL Metadata id so the happy-path
    // Program<Metadata> check (key + executable) is satisfiable. The handler
    // never CPIs to it, so any executable .so works — Anchor's Program<T>
    // validates the key + executable flag, not the program's code.
    auxiliaryPrograms: [{ programId: MPL_METADATA_ID, soFilename: "counter_callee.so" }],

    setup: async (): Promise<Ctx> => ({ payer: Keypair.generate() }),
    callScript,
    accountsToCompare: () => [],
  });
}
