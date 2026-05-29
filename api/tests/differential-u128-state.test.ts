/**
 * u128 state + arithmetic byte-equal.
 *
 * DeFi leans on u128 everywhere (prices, share math, large amounts). Two ways
 * the emit could silently corrupt money: (1) the hand-rolled state reader
 * mis-sizes a u128 as 8 bytes → every field AFTER it reads at the wrong offset;
 * (2) a u128 value > 2^64 gets truncated to its low 64 bits. This fixture puts
 * a u128 BEFORE a u64 (so offset advancement past the u128 matters) and uses a
 * value with non-zero bits above bit 64, so either failure mode diverges here.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROGRAM_ID = "7iQBNE81KvCMtADYcxucpiDLM7xLEegQWHKy5rsSrg5";

// 16-byte little-endian u128.
const encodeU128LE = (v: bigint): Uint8Array => {
  const b = new Uint8Array(16);
  let x = v;
  for (let i = 0; i < 16; i++) {
    b[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return b;
};

const BIG = (1n << 70n) + 999n; // > 2^64, with both high and low bits set

const SOURCE = `
use anchor_lang::prelude::*;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod u128_state {
    use super::*;
    pub fn init(ctx: Context<Init>, big: u128, tail: u64) -> Result<()> {
        ctx.accounts.acc.big = big;
        ctx.accounts.acc.tail = tail;
        Ok(())
    }
    pub fn add(ctx: Context<Update>, amount: u128) -> Result<()> {
        ctx.accounts.acc.big += amount;
        ctx.accounts.acc.tail += 1;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 32, seeds = [b"acc"], bump)]
    pub acc: Account<'info, Data>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Update<'info> {
    #[account(mut, seeds = [b"acc"], bump)]
    pub acc: Account<'info, Data>,
}

#[account]
pub struct Data { pub big: u128, pub tail: u64 }
`;

function defineU128Fixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "u128_state_native_diff" : "u128_state_anchor_diff",

    setup: async () => {
      const payer = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [acc] = PublicKey.findProgramAddressSync([Buffer.from("acc")], programId);
      return { payer, acc };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(3_000_000_000));
      const send = (keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[], data: Buffer) => {
        const tx = new Transaction().add(new TransactionInstruction({ programId, keys, data }));
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        const r = svm.sendTransaction(tx);
        return r;
      };
      // init big = 2^70 + 999, tail = 5
      send(
        [
          { pubkey: ctx.acc, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        Buffer.from(concatBytes(anchorIxDiscriminator("init"), encodeU128LE(BIG), encodeU64LE(5n))),
      );
      // add 500 → big += 500, tail += 1 = 6
      send(
        [{ pubkey: ctx.acc, isSigner: false, isWritable: true }],
        Buffer.from(concatBytes(anchorIxDiscriminator("add"), encodeU128LE(500n))),
      );
    },

    accountsToCompare: (ctx) => [
      { pubkey: ctx.acc, label: "acc" },
    ],
  });
}

defineU128Fixture("u128-state");
defineU128Fixture("u128-state-native", "native");
