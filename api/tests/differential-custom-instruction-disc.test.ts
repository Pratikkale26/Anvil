/**
 * B6 (#13) — non-8-byte INSTRUCTION discriminator dispatch.
 *
 * Anchor 1.x `#[instruction(discriminator = ...)]` lets a handler override the
 * default 8-byte sha256("global:<name>") with a shorter/custom byte sequence.
 * Anvil's parser already resolves + carries the bytes (customDiscriminator), but
 * the router emitted a fixed `split_at(8)` + 8-byte match, so a non-8-byte disc
 * silently MISROUTED. This fixture proves the variable-length dispatch.
 *
 * Routing is made OBSERVABLE: each handler writes a DISTINCT field, so a
 * wrong-arm misroute (not just a total no-match) leaves the intended field
 * unwritten → the byte compare catches it. `compareTxOutcomes` additionally
 * catches a total misroute (Anvil errs while Anchor succeeds).
 *
 * Scope isolation: the state account uses the DEFAULT 8-byte account
 * discriminator (plain #[account]); account/event-disc overrides are a separate
 * concern. Mixed lengths are exercised: set_a=1B, set_c=2B, set_b=4B, set_d=8B
 * (default). set_a also takes a u8 arg read from the payload AFTER its 1-byte
 * disc, so the `data @ ..` rest-binding (offset correctness) is verified, not
 * just which arm matched. Runs in the normal differential lane.
 */
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";

const PROGRAM_ID = "EMKsSASXRxkdSco1grbVXBamgVxkZG9HmnF8EwrunHU2";

const SOURCE = `
use anchor_lang::prelude::*;
declare_id!("${PROGRAM_ID}");

#[program]
pub mod custom_disc_demo {
    use super::*;
    pub fn init(_ctx: Context<Init>) -> Result<()> {
        Ok(())
    }
    // 1-byte disc [7] + a u8 arg AFTER the disc. Proves the payload
    // (the \`data @ ..\` rest-binding) lands at the right offset following a
    // 1-byte discriminator — not just that the right arm matched.
    #[instruction(discriminator = 7)]
    pub fn set_a(ctx: Context<Upd>, n: u8) -> Result<()> {
        ctx.accounts.counter.a = n as u64;
        Ok(())
    }
    // 4-byte disc [1,2,3,4]
    #[instruction(discriminator = [1, 2, 3, 4])]
    pub fn set_b(ctx: Context<Upd>) -> Result<()> {
        ctx.accounts.counter.b = 22;
        Ok(())
    }
    // 2-byte disc b"hi" = [104,105]
    #[instruction(discriminator = b"hi")]
    pub fn set_c(ctx: Context<Upd>) -> Result<()> {
        ctx.accounts.counter.c = 33;
        Ok(())
    }
    // default 8-byte sha256("global:set_d") — mixed-length dispatch
    pub fn set_d(ctx: Context<Upd>) -> Result<()> {
        ctx.accounts.counter.d = 44;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 48, seeds = [b"counter"], bump)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Upd<'info> {
    #[account(mut, seeds = [b"counter"], bump)]
    pub counter: Account<'info, Counter>,
}

#[account]
pub struct Counter { pub a: u64, pub b: u64, pub c: u64, pub d: u64 }
`;

defineDifferential({
  fixtureName: "custom-instruction-disc",
  programIdBase58: PROGRAM_ID,
  anchorSource: SOURCE,
  anchorPackageName: "custom_disc_demo_diff",
  compareTxOutcomes: true,

  setup: async () => {
    const payer = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [counter] = PublicKey.findProgramAddressSync([Buffer.from("counter")], programId);
    return { payer, counter };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.payer.publicKey, BigInt(3_000_000_000));
    const send = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data: Buffer) => {
      const tx = new Transaction().add(new TransactionInstruction({ programId, keys, data }));
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      svm.sendTransaction(tx);
    };
    const upd = (data: Buffer) =>
      send([{ pubkey: ctx.counter, isSigner: false, isWritable: true }], data);

    // init (default 8-byte disc) → Counter all zeros
    send(
      [
        { pubkey: ctx.counter, isSigner: false, isWritable: true },
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      Buffer.from(anchorIxDiscriminator("init")),
    );
    upd(Buffer.from([7, 99]));        // set_a(n=99) → a = 99 (arg AFTER 1-byte disc)
    upd(Buffer.from([1, 2, 3, 4]));   // set_b → b = 22
    upd(Buffer.from([104, 105]));     // set_c (b"hi") → c = 33
    upd(Buffer.from(anchorIxDiscriminator("set_d"))); // set_d (default) → d = 44
  },

  accountsToCompare: (ctx) => [{ pubkey: ctx.counter, label: "counter" }],
});
