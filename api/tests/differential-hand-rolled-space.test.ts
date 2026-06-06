/**
 * F3 guard — honor an explicit hand-rolled `space = Type::CONST` on an init account.
 *
 * `Registry::INIT_SPACE = 8 + 32 + 4 + 12 = 56` is a hand-rolled, discriminator-
 * INCLUSIVE const (the `name` String is capped at 12 by the author). Anvil's
 * field-recompute junk-defaults an un-#[max_len] String to 64, so PRE-FIX it
 * emitted `space = 8 + Registry::INIT_SPACE` against its own recompute (8 + 32 +
 * (4+64) = 108) → allocated 8 + 108 = 116, while Anchor allocates 56. The init
 * account's data.length + rent diverge. POST-FIX, const-eval resolves the source
 * const to the literal 56 and emits it → byte-equal.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const PROGRAM_ID = "9H79XZbDrGF66GhEsbcaA4zmQPbsfAeVAvAW1YVP8vev";

const SOURCE = `
use anchor_lang::prelude::*;

declare_id!("${PROGRAM_ID}");

#[program]
pub mod hand_space {
    use super::*;
    pub fn init_reg(ctx: Context<InitReg>, name: String) -> Result<()> {
        let r = &mut ctx.accounts.registry;
        r.key = ctx.accounts.payer.key();
        r.name = name;
        Ok(())
    }
}

#[account]
pub struct Registry {
    pub key: Pubkey,
    pub name: String,
}

impl Registry {
    pub const INIT_SPACE: usize = 8 + 32 + 4 + 12;
}

#[derive(Accounts)]
pub struct InitReg<'info> {
    #[account(init, payer = payer, space = Registry::INIT_SPACE, seeds = [b"reg", payer.key().as_ref()], bump)]
    pub registry: Account<'info, Registry>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
`;

function encodeString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length, true);
  return concatBytes(len, bytes);
}

function defineFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SOURCE,
    anchorPackageName: anvilTarget === "native" ? "hand_space_native_diff" : "hand_space_diff",

    setup: async () => {
      const payer = Keypair.generate();
      const programId = new PublicKey(PROGRAM_ID);
      const [registry] = PublicKey.findProgramAddressSync(
        [Buffer.from("reg"), payer.publicKey.toBuffer()],
        programId,
      );
      return { payer, registry };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.registry, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("init_reg"), encodeString("hi"))),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      const r = svm.sendTransaction(tx);
      if (r?.constructor?.name === "FailedTransactionMetadata") {
        const f = r as unknown as { err: () => { toString(): string }; meta: () => { logs: () => string[] } };
        throw new Error(`init_reg failed: ${f.err().toString()}\n${f.meta().logs().join("\n")}`);
      }
      // Hard assertion: a coincidental rent match can't mask a size diff.
      const acc = svm.getAccount(ctx.registry);
      if (!acc) throw new Error("registry account missing after init");
      if (acc.data.length !== 56) throw new Error(`registry data.length = ${acc.data.length}, expected 56 (hand-rolled space)`);
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [
      { pubkey: ctx.registry, label: "registry" },
    ],
  });
}

defineFixture("hand-rolled-space");
