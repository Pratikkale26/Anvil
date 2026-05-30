/**
 * B6 Option<T> arc — MULTI-OPTIONAL layout fixture (the highest-risk surface:
 * account-meta slot + None-sentinel + idx mapping for ≥2 trailing optionals).
 *
 * The single-optional fixture (differential-option-account) verified one
 * trailing optional. Real multisig programs (squads-v4: every config-mgmt ix
 * has 2 trailing optionals, spending_limit_use has 5) need the MULTI case
 * verified before the un-gate detector may pass that layout — a None in an
 * earlier slot must NOT shift the idx of a later optional (Anchor keeps every
 * optional in its fixed slot, None = program-id sentinel).
 *
 * `bump2` reads two trailing optionals with DIFFERENT factors (10 vs 100) so a
 * None in slot-1-only vs slot-2-only is distinguishable. The scenario exercises
 * all four combinations: (None,None) (Some,None) (None,Some) (Some,Some).
 * Byte-equality of counter against the Anchor reference proves the slot mapping.
 *
 * GUARDED OFF by default (B6_OPTION_T). Run: B6_OPTION_T=1 bun test tests/differential-option-account-multi.test.ts
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

const PROGRAM_ID = "EpPCKKJotrKzSshipkfbXsUiHA5wBpGFnzku9JmKh4Gh";

const SOURCE = `
use anchor_lang::prelude::*;
declare_id!("${PROGRAM_ID}");

#[program]
pub mod opt_multi_demo {
    use super::*;
    pub fn init_counter(ctx: Context<InitCounter>) -> Result<()> {
        ctx.accounts.counter.value = 7;
        Ok(())
    }
    pub fn init_config_a(ctx: Context<InitConfigA>) -> Result<()> {
        ctx.accounts.config.factor = 10;
        Ok(())
    }
    pub fn init_config_b(ctx: Context<InitConfigB>) -> Result<()> {
        ctx.accounts.config.factor = 100;
        Ok(())
    }
    // Two TRAILING optionals: +1 baseline, + each present config's factor.
    pub fn bump2(ctx: Context<Bump2>) -> Result<()> {
        ctx.accounts.counter.value += 1;
        if let Some(a) = &ctx.accounts.config_a {
            ctx.accounts.counter.value += a.factor;
        }
        if let Some(b) = &ctx.accounts.config_b {
            ctx.accounts.counter.value += b.factor;
        }
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
pub struct InitConfigA<'info> {
    #[account(init, payer = payer, space = 16, seeds = [b"cfga"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitConfigB<'info> {
    #[account(init, payer = payer, space = 16, seeds = [b"cfgb"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Bump2<'info> {
    #[account(mut, seeds = [b"counter"], bump)]
    pub counter: Account<'info, Counter>,
    pub config_a: Option<Account<'info, Config>>,
    pub config_b: Option<Account<'info, Config>>,
}

#[account]
pub struct Counter { pub value: u64 }
#[account]
pub struct Config { pub factor: u64 }
`;

if (process.env.B6_OPTION_T) {
  defineDifferential({
    fixtureName: "option-account-multi",
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: "opt_multi_demo_diff",
    compareTxOutcomes: true,

    setup: async () => {
      const payer = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [counter] = PublicKey.findProgramAddressSync([Buffer.from("counter")], programId);
      const [cfgA] = PublicKey.findProgramAddressSync([Buffer.from("cfga")], programId);
      const [cfgB] = PublicKey.findProgramAddressSync([Buffer.from("cfgb")], programId);
      return { payer, counter, cfgA, cfgB };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(4_000_000_000));
      const send = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data: Buffer) => {
        const tx = new Transaction().add(new TransactionInstruction({ programId, keys, data }));
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx);
      };
      const initKeys = (pda: PublicKey) => [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      const N = programId; // None-sentinel slot
      // counter=7, cfgA.factor=10, cfgB.factor=100
      send(initKeys(ctx.counter), Buffer.from(anchorIxDiscriminator("init_counter")));
      send(initKeys(ctx.cfgA), Buffer.from(anchorIxDiscriminator("init_config_a")));
      send(initKeys(ctx.cfgB), Buffer.from(anchorIxDiscriminator("init_config_b")));
      const bump2 = (a: PublicKey, b: PublicKey) => send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: a, isSigner: false, isWritable: false },
          { pubkey: b, isSigner: false, isWritable: false },
        ],
        Buffer.from(anchorIxDiscriminator("bump2")),
      );
      bump2(N, N);            // +1                  → 8
      bump2(ctx.cfgA, N);     // +1+10               → 19
      bump2(N, ctx.cfgB);     // +1+100  (slot-1 None, slot-2 Some — the key case) → 120
      bump2(ctx.cfgA, ctx.cfgB); // +1+10+100        → 231
    },

    accountsToCompare: (ctx) => [
      { pubkey: ctx.counter, label: "counter" },
      { pubkey: ctx.cfgA, label: "config_a" },
      { pubkey: ctx.cfgB, label: "config_b" },
    ],
  });
} else {
  test.skip("option-account-multi differential — B6 multi-optional layout (set B6_OPTION_T=1)", () => {});
}
