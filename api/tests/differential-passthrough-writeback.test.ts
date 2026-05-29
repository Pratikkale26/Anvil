/**
 * B2 safety proof — does a `ctx.accounts.X.field = value` write-back that
 * lands in a `pass_through` statement actually PERSIST at runtime?
 *
 * Commit 5d957d8 added `normalizeForAudit()` which strips `ctx.accounts.X → X`
 * before the audit patterns run, so the pre-emit audit no longer flags
 * ctx.accounts references inside pass_through. That is only safe if the
 * emitter genuinely persists such write-backs (rather than mutating a local
 * copy that's never serialized back). This fixture is the runtime gold-standard
 * for that claim.
 *
 * `bump_via_match` mutates `state.counter` ONLY inside a match arm — which the
 * classifier leaves as a single pass_through statement (verified). The script
 * calls mode=1 (counter += 5) TWICE after init(0). If the pass_through write
 * persists, the second call reads the saved 5 and yields 10; if it silently
 * dropped, the second call would read a stale 0 and yield 5. Byte-equality of
 * the state account against the Anchor reference therefore proves persistence.
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

const PROGRAM_ID = "J71bbk26RUUcovkTtb4cnfR4sTvFt4Uc7r7Pv3eTU4eW";

const SOURCE = `use anchor_lang::prelude::*;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod passthrough_writeback {
    use super::*;

    pub fn initialize(ctx: Context<Init>) -> Result<()> {
        ctx.accounts.state.counter = 0;
        Ok(())
    }

    // counter is mutated ONLY inside a match arm → lands in pass_through.
    pub fn bump_via_match(ctx: Context<Act>, mode: u64) -> Result<()> {
        match mode {
            0 => { ctx.accounts.state.counter = 100; }
            1 => { ctx.accounts.state.counter = ctx.accounts.state.counter + 5; }
            2 => { ctx.accounts.state.counter = ctx.accounts.state.counter + 3; }
            _ => { ctx.accounts.state.counter = 999; }
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = signer, space = 8 + 8, seeds = [b"state", signer.key().as_ref()], bump)]
    pub state: Account<'info, S>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Act<'info> {
    #[account(mut, seeds = [b"state", signer.key().as_ref()], bump)]
    pub state: Account<'info, S>,
    pub signer: Signer<'info>,
}

#[account]
pub struct S {
    pub counter: u64,
}
`;

function defineFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "passthrough_wb_native_diff" : "passthrough_wb_anchor_diff",

    setup: async () => {
      const signer = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [state] = PublicKey.findProgramAddressSync(
        [Buffer.from("state"), signer.publicKey.toBuffer()],
        programId,
      );
      return { signer, state };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.signer.publicKey, BigInt(2_000_000_000));

      const initIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.state, isSigner: false, isWritable: true },
          { pubkey: ctx.signer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("initialize")),
      });

      // bump(1): counter += 5, then bump(2): counter += 3. Distinct modes →
      // distinct txs (no duplicate-signature rejection). BOTH are
      // read-modify-writes, so the final total (8) is only correct if the
      // FIRST match-arm write persisted to the account before the second call.
      const bumpIx = (mode: bigint) => new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.state, isSigner: false, isWritable: true },
          { pubkey: ctx.signer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("bump_via_match"), encodeU64LE(mode))),
      });

      for (const ix of [initIx, bumpIx(1n), bumpIx(2n)]) {
        const tx = new Transaction().add(ix);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.signer.publicKey;
        tx.sign(ctx.signer);
        const r = svm.sendTransaction(tx);
        if (isTxFailure(r)) throw new Error(`passthrough-wb tx failed: ${txFailureMessage(r)}`);
      }
    },

    accountsToCompare: (ctx) => [
      // state.counter must be 8 (0 +5 +3). A dropped pass_through write
      // would leave it at 0/3 — byte-inequality vs the Anchor reference catches it.
      { pubkey: ctx.state, label: "state" },
    ],
  });
}

defineFixture("passthrough-writeback");
defineFixture("passthrough-writeback-native", "native");
