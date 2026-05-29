/**
 * Integer-overflow revert parity.
 *
 * Anchor compiles release with `overflow-checks = true`, so `value += amount`
 * panics → reverts on overflow. If Anvil's emitted program WRAPPED instead
 * (overflow-checks omitted from its Cargo.toml), the overflowing add would
 * SUCCEED with a wrapped value — a silent money-loss divergence (deposit
 * overflows to near-zero, withdrawal underflows to huge, etc.).
 *
 * This pins the property: the overflowing tx must REVERT on both runtimes
 * (B5 revert-parity via compareTxOutcomes) AND the counter must be byte-equal
 * (unchanged by the reverted add). If Anvil ever drops overflow-checks, the
 * outcome flips ok↔revert here and this fixture fails loudly.
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

const PROGRAM_ID = "H947QKnchT5EsB96zK3j2P5PjEEQpd7Bir6isnPhNJxP";
const U64_MAX = 2n ** 64n - 1n;

const SOURCE = `
use anchor_lang::prelude::*;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod overflow_demo {
    use super::*;
    pub fn init(ctx: Context<Init>, start: u64) -> Result<()> {
        ctx.accounts.counter.value = start;
        Ok(())
    }
    pub fn add(ctx: Context<Add>, amount: u64) -> Result<()> {
        ctx.accounts.counter.value += amount;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = payer, space = 16, seeds = [b"counter"], bump)]
    pub counter: Account<'info, Counter>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Add<'info> {
    #[account(mut, seeds = [b"counter"], bump)]
    pub counter: Account<'info, Counter>,
}

#[account]
pub struct Counter { pub value: u64 }
`;

function defineOverflowFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "overflow_native_diff" : "overflow_anchor_diff",
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
        svm.sendTransaction(tx); // tolerate failure — the overflowing add is expected to revert
      };
      // init counter = u64::MAX - 10
      send(
        [
          { pubkey: ctx.counter, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        Buffer.from(concatBytes(anchorIxDiscriminator("init"), encodeU64LE(U64_MAX - 10n))),
      );
      // add 5 → MAX-5 (ok)
      send(
        [{ pubkey: ctx.counter, isSigner: false, isWritable: true }],
        Buffer.from(concatBytes(anchorIxDiscriminator("add"), encodeU64LE(5n))),
      );
      // add 20 → MAX-5 + 20 overflows → MUST revert on both (not wrap)
      send(
        [{ pubkey: ctx.counter, isSigner: false, isWritable: true }],
        Buffer.from(concatBytes(anchorIxDiscriminator("add"), encodeU64LE(20n))),
      );
    },

    accountsToCompare: (ctx) => [
      { pubkey: ctx.counter, label: "counter" },
    ],
  });
}

defineOverflowFixture("overflow-revert");
defineOverflowFixture("overflow-revert-native", "native");
