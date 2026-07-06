/**
 * Nested variable-length type deserialization (#41).
 *
 * Account `Data { id: u64, sub: Sub, tail: u64 }` where `Sub { name: String,
 * count: u32 }` is a nested struct carrying a variable-length field. Anvil
 * previously loud-refused (`unimplemented!`) any account field whose type is a
 * nested var-length struct; now it emits open-ended Borsh read/write and
 * advances the cursor by the bytes consumed.
 *
 * Why `tail` after `sub` matters: if Anvil read/wrote `sub` at a FIXED byte
 * offset it would desync the cursor and place `tail` at the wrong position —
 * so a byte-equal on the whole account proves the variable-length layout is
 * byte-identical to Anchor's borsh derive.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = "Nested1111111111111111111111111111111111111";

const SRC = `
use anchor_lang::prelude::*;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod nested {
    use super::*;
    pub fn init(ctx: Context<Init>, sub: Sub, tail: u64) -> Result<()> {
        let d = &mut ctx.accounts.data;
        d.id = 7;
        d.sub = sub;
        d.tail = tail;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct Sub {
    pub name: String,
    pub count: u32,
}

#[account]
pub struct Data {
    pub id: u64,
    pub sub: Sub,
    pub tail: u64,
}

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(init, payer = signer, space = 256)]
    pub data: Account<'info, Data>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
`;

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const len = new Uint8Array(new Uint32Array([bytes.length]).buffer);
  return concatBytes(len, bytes);
}
function u32LE(n: number): Uint8Array { return new Uint8Array(new Uint32Array([n]).buffer); }
function u64LE(n: bigint): Uint8Array { return new Uint8Array(new BigUint64Array([n]).buffer); }

defineDifferential({
  fixtureName: "nested-varlen",
  programIdBase58: PROGRAM_ID,
  anchorSource: SRC,
  anchorPackageName: "nested_varlen_anchor_diff",

  setup: async () => ({
    signer: Keypair.generate(),
    data: Keypair.generate(),
  }),

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.signer.publicKey, BigInt(10_000_000_000));

    // init(Sub { name: "hello-world", count: 42 }, tail: 999).
    // The "hello-world" (11 bytes) makes sub variable-length; tail must land
    // right after it on both runtimes.
    const args = concatBytes(
      borshString("hello-world"),
      u32LE(42),
      u64LE(999n),
    );
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.data.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("init"), args)),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.signer.publicKey;
    tx.sign(ctx.signer, ctx.data);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) throw new Error(`init failed: ${txFailureMessage(r)}`);
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.data.publicKey, label: "data_nested_varlen" },
  ],
});
