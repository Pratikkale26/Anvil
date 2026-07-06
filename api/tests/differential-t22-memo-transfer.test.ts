/**
 * Token-2022 RequiredMemoTransfers extension differential (#43).
 *
 * Validates `cpi_t22_memo_transfer` (enable path) emits a CPI byte-equal
 * to Anchor's `memo_transfer_initialize` helper. Before this kind existed,
 * `memo_transfer_initialize` fell through the detector to a pass_through
 * refuse — a real anchor-spl helper that transpiled to "manual verification
 * required" rather than emitted.
 *
 * Setup: initialize a Token-2022 mint, allocate a token account WITH
 * MemoTransfer extension space, initialize it (owner = `owner` keypair),
 * then run the program's `enable_memos` instruction. Byte-compare the
 * resulting token-account state.
 *
 * Why byte-equal proves the wire format: enabling the extension writes the
 * MemoTransfer TLV (`require_incoming_transfer_memos = true`) into the
 * account's extension region. Discriminator 30 + sub-byte 0, accounts
 * [account writable, owner signer]. If the emit got the discriminator,
 * sub-byte, or account order wrong, the Token-2022 program either reverts
 * (byte-equality fails on the success path) or writes a different TLV, so
 * the whole-account byte compare is a robust gate.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  MINT_SIZE,
  ExtensionType,
  getAccountLen,
  createInitializeMintInstruction,
  createInitializeAccountInstruction,
} from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const SRC = join(import.meta.dir, "..", "src", "demo-programs", "t22-memo-transfer.rs");
const PROGRAM_ID = "74QBDrdTNg8hqnDzZzLoCzQL1T7eR9KtCKmHy5R1vGDr";

defineDifferential({
  fixtureName: "t22-memo-transfer",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(SRC, "utf-8"),
  anchorPackageName: "t22_memo_transfer_anchor_diff",
  anchorExtraDeps: 'anchor-spl = { version = "0.31", features = ["token_2022"] }',

  setup: async () => {
    const payer = Keypair.generate();
    const authority = Keypair.generate();
    const owner = Keypair.generate();
    const mint = Keypair.generate();
    const tokenAccount = Keypair.generate();
    return { payer, authority, owner, mint, tokenAccount };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

    const mintRent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
    // Allocate the token account WITH MemoTransfer extension space so the
    // enable call has room to write the extension TLV.
    const accountLen = getAccountLen([ExtensionType.MemoTransfer]);
    const accountRent = svm.minimumBalanceForRentExemption(BigInt(accountLen));

    const setupTx = new Transaction()
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.mint.publicKey,
        lamports: Number(mintRent),
        space: MINT_SIZE,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeMintInstruction(
        ctx.mint.publicKey,
        6,
        ctx.authority.publicKey,
        ctx.authority.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ))
      .add(SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: ctx.tokenAccount.publicKey,
        lamports: Number(accountRent),
        space: accountLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }))
      .add(createInitializeAccountInstruction(
        ctx.tokenAccount.publicKey,
        ctx.mint.publicKey,
        ctx.owner.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ));
    setupTx.recentBlockhash = svm.latestBlockhash();
    setupTx.feePayer = ctx.payer.publicKey;
    setupTx.sign(ctx.payer, ctx.mint, ctx.tokenAccount);
    const r1 = svm.sendTransaction(setupTx);
    if (isTxFailure(r1)) {
      throw new Error(`t22-memo-transfer setup failed: ${txFailureMessage(r1)}`);
    }

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.tokenAccount.publicKey, isSigner: false, isWritable: true },
        { pubkey: ctx.owner.publicKey, isSigner: true, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("enable_memos")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.owner);
    const r2 = svm.sendTransaction(tx);
    if (isTxFailure(r2)) {
      throw new Error(`enable_memos failed: ${txFailureMessage(r2)}`);
    }
  },

  stripDiscriminator: false,
  accountsToCompare: (ctx) => [
    { pubkey: ctx.tokenAccount.publicKey, label: "token_account_memo" },
  ],
});
