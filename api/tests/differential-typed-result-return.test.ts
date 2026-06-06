/**
 * Typed-Result (`-> Result<T>`, T != ()) byte-equal return-data gate.
 *
 * Anchor's #[program] macro expands a non-unit `Ok(value)` handler tail to
 * `set_return_data(&borsh::to_vec(&value)?); Ok(())`. Anvil's router uses a
 * uniform `-> ProgramResult`, so it wires the SAME pattern for single-tail
 * `Ok(<expr>)` getters (isWireableTypedResult). Byte-equality holds by
 * delegation: both serialize the same value through Borsh (`borsh::to_vec`
 * here, `AnchorSerialize` = Borsh in the macro). This fixture proves it end-to-
 * end against a real Anchor reference build, across all four value shapes:
 *
 *   return_u64               -> Ok(10)                       (primitive literal)
 *   return_struct            -> Ok(s)  / StructReturn{..}     (in-mod derived struct)
 *   return_vec               -> Ok(vec![12, 13, 14, 100])    (length-prefixed Vec<u8>)
 *   return_u64_from_account  -> Ok(account.value)            (deserialized state read)
 *
 * Source is the committed real-world fixture tests/fixtures/realworld/
 * anchor-cpi-test.rs (coral-xyz/anchor tests/cpi-returns/programs/callee).
 *
 * Both Anvil targets are exercised — the set_return_data import path differs
 * (`pinocchio::program::set_return_data` vs `solana_program::program::…`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "fixtures", "realworld", "anchor-cpi-test.rs");
const PROGRAM_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

interface Ctx {
  user: Keypair;
  // Non-PDA: the state account is a fresh Keypair that signs its own create.
  account: Keypair;
}

async function setup(): Promise<Ctx> {
  return { user: Keypair.generate(), account: Keypair.generate() };
}

// Each reader returns a value via the macro/set_return_data channel; the
// harness (compareReturnData) captures the returnData() of every step and
// byte-compares the Anchor and Anvil arrays.
const READERS = [
  "return_u64",
  "return_struct",
  "return_vec",
  "return_u64_from_account",
];

async function callScript(
  svm: LiteSVM,
  ctx: Ctx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.user.publicKey, BigInt(10_000_000_000));

  // initialize — creates the CpiReturnAccount and writes `value = 10`. Source
  // account order: account (signer+writable, non-PDA init), user (payer),
  // system_program.
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.account.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });
  const initTx = new Transaction().add(initIx);
  initTx.recentBlockhash = svm.latestBlockhash();
  initTx.feePayer = ctx.user.publicKey;
  initTx.sign(ctx.user, ctx.account);
  const initRes = svm.sendTransaction(initTx);
  if (isTxFailure(initRes)) {
    throw new Error(`initialize tx failed: ${txFailureMessage(initRes)}`);
  }

  // Each reader takes Context<CpiReturn> { account: Account<CpiReturnAccount> }
  // — read-only, no signer. The account must already be initialized (owner +
  // discriminator checks) which the initialize call above satisfies.
  for (const name of READERS) {
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.account.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator(name)),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.user.publicKey;
    tx.sign(ctx.user);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`${name} tx failed: ${txFailureMessage(r)}`);
    }
  }
}

// Both targets — the set_return_data import + call path differ per framework.
for (const target of ["pinocchio", "native"] as const) {
  defineDifferential({
    fixtureName: `typed-result-return-${target}`,
    programIdBase58: PROGRAM_ID,
    anchorSource: readFileSync(SRC, "utf-8"),
    anchorPackageName: `typed_result_return_${target}_diff`,
    anvilTarget: target,

    setup,
    callScript,
    // Also confirm the initialize state write byte-equals (value = 10).
    accountsToCompare: (ctx) => [{ pubkey: ctx.account.publicKey, label: "account" }],
    // The headline surface: every reader's borsh-encoded return value must
    // byte-match Anchor's macro expansion.
    compareReturnData: true,
  });
}
