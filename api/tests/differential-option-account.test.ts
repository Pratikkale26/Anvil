/**
 * B6 Option<T> arc — TARGET fixture (fixture-first). Exercises BOTH Option
 * branches of `bump`: None (else → +1) and Some (deserialize the optional
 * Config → += cfg.factor). Verifies the read-only if-let-Some deserialize
 * surface end-to-end (not just compile).
 *
 * GUARDED OFF by default (process.env.B6_OPTION_T) so it doesn't break the
 * suite while Option<T> emit is experimental. Run on demand:
 *   B6_OPTION_T=1 bun test tests/differential-option-account.test.ts
 *
 * Exercises account byte-compare (counter + config) AND the B5 revert-parity
 * gate (every tx must succeed on both runtimes).
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
    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        ctx.accounts.config.factor = 10;
        Ok(())
    }
    // Option<T>: add the config's factor when present, else 1.
    pub fn bump(ctx: Context<Bump>) -> Result<()> {
        if let Some(cfg) = &ctx.accounts.maybe_config {
            ctx.accounts.counter.value += cfg.factor;
        } else {
            ctx.accounts.counter.value += 1;
        }
        Ok(())
    }
    // Mutable optional: deserialize, mutate, save (exercises the &mut if-let-Some handler).
    pub fn bump_mut(ctx: Context<BumpMut>) -> Result<()> {
        if let Some(cfg) = &mut ctx.accounts.maybe_config {
            cfg.factor += 5;
        }
        Ok(())
    }
    // AccountInfo-level call on an optional: cfg.key() must route to the
    // underlying AccountInfo binding (with deref) to match Anchor's owned Pubkey.
    pub fn read_key(ctx: Context<Bump>) -> Result<()> {
        if let Some(cfg) = &ctx.accounts.maybe_config {
            if cfg.key() != ctx.accounts.counter.key() {
                ctx.accounts.counter.value += 7;
            }
        }
        Ok(())
    }
    // to_account_info() routes to the AccountInfo binding, so .lamports() on it
    // is valid (the direct cfg.lamports() is not valid Anchor on Account<T>).
    pub fn read_lamports(ctx: Context<Bump>) -> Result<()> {
        if let Some(cfg) = &ctx.accounts.maybe_config {
            ctx.accounts.counter.value += cfg.to_account_info().lamports();
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
pub struct InitConfig<'info> {
    #[account(init, payer = payer, space = 16, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
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

#[derive(Accounts)]
pub struct BumpMut<'info> {
    #[account(mut)]
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
      const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
      return { payer, counter, config };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(3_000_000_000));
      const send = (
        keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[],
        data: Buffer,
      ) => {
        const tx = new Transaction().add(new TransactionInstruction({ programId, keys, data }));
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx); // tolerate failure — revert-parity captures the outcome
      };
      const payerKeys = (pda: PublicKey) => [
        { pubkey: pda, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
      // init_counter → counter.value = 7
      send(payerKeys(ctx.counter), Buffer.from(anchorIxDiscriminator("init_counter")));
      // init_config → config.factor = 10
      send(payerKeys(ctx.config), Buffer.from(anchorIxDiscriminator("init_config")));
      // bump with maybe_config = None (program-id sentinel) → else → counter += 1 = 8
      send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: programId, isSigner: false, isWritable: false },
        ],
        Buffer.from(anchorIxDiscriminator("bump")),
      );
      // bump with maybe_config = Some(config) → deserialize → counter += cfg.factor(10) = 18
      send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: ctx.config, isSigner: false, isWritable: false },
        ],
        Buffer.from(anchorIxDiscriminator("bump")),
      );
      // bump_mut with maybe_config = Some(config) → deserialize, mutate, save → config.factor 10 → 15
      send(
        [{ pubkey: ctx.config, isSigner: false, isWritable: true }],
        Buffer.from(anchorIxDiscriminator("bump_mut")),
      );
      // read_key: cfg.key() != counter.key() (true) → counter += 7
      send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: ctx.config, isSigner: false, isWritable: false },
        ],
        Buffer.from(anchorIxDiscriminator("read_key")),
      );
      // read_lamports: counter += cfg.to_account_info().lamports() (config's rent-exempt balance)
      send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: ctx.config, isSigner: false, isWritable: false },
        ],
        Buffer.from(anchorIxDiscriminator("read_lamports")),
      );
    },

    accountsToCompare: (ctx) => [
      { pubkey: ctx.counter, label: "counter" },
      { pubkey: ctx.config, label: "config" },
    ],
  });
} else {
  // B6 Option<T> arc target. RED until the emit surfaces land (see
  // docs/plan-option-t-accounts.md). Run on demand: B6_OPTION_T=1 bun test …
  test.skip("option-account differential — B6 Option<T> arc target (set B6_OPTION_T=1)", () => {});
}
