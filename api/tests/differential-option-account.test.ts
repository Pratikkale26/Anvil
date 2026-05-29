/**
 * B6 Option<T> arc — TARGET fixture (fixture-first). Defines what "done" looks
 * like for optional-account support. Currently RED: Anvil stubs any instruction
 * with an Option<T> account as `unimplemented!()`, so `bump` panics → reverts
 * while Anchor succeeds. That divergence is the gap this arc closes, surface by
 * surface (see docs/plan-option-t-accounts.md).
 *
 * GUARDED OFF by default (process.env.B6_OPTION_T) so it doesn't break the suite
 * while the emit is unimplemented. Un-guard once the emit surfaces land + it
 * goes byte-equal green. Run now with: B6_OPTION_T=1 bun test tests/differential-option-account.test.ts
 *
 * It exercises both gates at once: account byte-compare (counter value) AND the
 * B5 revert-parity gate (bump must succeed on both, not panic on one).
 */
import { test } from "bun:test";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROGRAM_ID = "37KTrvsN5HgR9SbtR6RXRidgieH1PjJidAtTdkWjZk2Q";

const SOURCE = `
use anchor_lang::prelude::*;
declare_id!("${PROGRAM_ID}");

#[program]
pub mod opt_account_demo {
    use super::*;
    pub fn init_counter(ctx: Context<InitCounter>) -> Result<()> {
        ctx.accounts.counter.value = 7;
        Ok(())
    }
    // Option<T> instruction: add the config's factor when present, else 1.
    pub fn bump(ctx: Context<Bump>) -> Result<()> {
        let add = if let Some(cfg) = &ctx.accounts.maybe_config { cfg.factor } else { 1 };
        ctx.accounts.counter.value += add;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitCounter<'info> {
    #[account(init, payer = payer, space = 16, seeds = [b"counter"], bump)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Bump<'info> {
    #[account(mut, seeds = [b"counter"], bump)]
    pub counter: Account<'info, Counter>,
    pub maybe_config: Option<Account<'info, Config>>,
}

#[account]
pub struct Counter { pub value: u64 }
#[account]
pub struct Config { pub factor: u64 }
`;

if (process.env.B6_OPTION_T) {
  defineDifferential({
    fixtureName: "option-account",
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: "opt_account_demo_diff",
    compareTxOutcomes: true,

    setup: async () => {
      const payer = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [counter] = PublicKey.findProgramAddressSync([Buffer.from("counter")], programId);
      return { payer, counter };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));
      const send = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data: Buffer) => {
        const tx = new Transaction().add(new TransactionInstruction({ programId, keys, data }));
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx); // tolerate failure — revert-parity captures the outcome
      };
      // init_counter → counter.value = 7
      send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        Buffer.from(anchorIxDiscriminator("init_counter")),
      );
      // bump with maybe_config = None (Anchor's None sentinel = the program id) → counter += 1 = 8
      send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: programId, isSigner: false, isWritable: false },
        ],
        Buffer.from(anchorIxDiscriminator("bump")),
      );
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.counter, label: "counter" }],
  });
} else {
  // B6 Option<T> arc target. RED until the emit surfaces land (see
  // docs/plan-option-t-accounts.md). Run on demand: B6_OPTION_T=1 bun test …
  test.skip("option-account differential — B6 Option<T> arc target (set B6_OPTION_T=1)", () => {});
}
