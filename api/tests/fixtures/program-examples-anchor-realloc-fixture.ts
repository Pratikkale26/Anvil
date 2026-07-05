import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for the `anchor_realloc` program from
 * solana-developers/program-examples (basics/realloc/anchor).
 *
 * Why this fixture earns a slot in the byte-equal matrix:
 *   The `update` instruction exercises Anchor's full realloc constraint
 *   family — `realloc = <expr>`, `realloc::payer = payer`,
 *   `realloc::zero = true` — on a String-valued account. That puts three
 *   distinct realloc-path encodings on the line in one pass:
 *     - account-data growth from old_len -> new_len under realloc::zero
 *     - rent-exempt delta paid by `realloc::payer` (lamport accounting)
 *     - Borsh `String` re-serialization at the new length-prefix
 *   Sibling `coral-realloc` only exercises `init`; this one is the first
 *   external byte-equal that actually triggers the realloc runtime path.
 *
 * Distinct from coral-realloc:
 *   - coral-realloc: PDA-init with Vec<u8> + bump (init-only, no realloc).
 *   - this one:     fresh-keypair init then realloc-on-update (init + realloc).
 *
 * Single-file Anchor program: we readFileSync the upstream lib.rs and
 * rewrite declare_id! to our test PROGRAM_ID before handing the source
 * to both the parser and the reference build (the harness does not
 * rewrite declare_id! itself; mismatched IDs trip
 * DeclaredProgramIdMismatch / custom error 0x1004 in Anchor 0.30+).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const LIB_RS =
  `${REPO_PATH}/basics/realloc/anchor/programs/anchor-realloc/src/lib.rs`;
// Fresh 32-byte base58 ID, unique across the fixture corpus. We rewrite
// the upstream declare_id! to this value in loadAnchorSource() below so
// both the reference build and the Anvil emit advertise the same ID.
export const PROGRAM_ID = "35i3b56TongcDpbvZX8jDdDByDtFzzkyEGdir3V1Awka";

const UPSTREAM_DECLARE_ID = "Fod47xKXjdHVQDzkFPBvfdWLm8gEAV4iMSXkfUzCHiSD";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    [
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/solana-developers/program-examples",
      REPO_PATH,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (r.status !== 0) {
    console.warn(
      `[program-examples-anchor-realloc-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Anchor 0.30+ has DeclaredProgramIdMismatch (custom error 4100) — the
  // source's declare_id! MUST equal the deployed program ID, or the runtime
  // rejects every instruction. Swap upstream -> our test PROGRAM_ID.
  return readFileSync(LIB_RS, "utf-8").replace(
    `declare_id!("${UPSTREAM_DECLARE_ID}")`,
    `declare_id!("${PROGRAM_ID}")`,
  );
}

export interface AnchorReallocCtx {
  payer: Keypair;
  messageAccount: Keypair;
}

export async function setupAnchorRealloc(): Promise<AnchorReallocCtx> {
  // `message_account` is a fresh keypair (no `seeds = [...]` on the
  // Initialize accounts struct — plain `init`, payer-funded). Sharing the
  // keypair across both scenarios is what makes post-scenario state
  // byte-comparable.
  const payer = Keypair.generate();
  const messageAccount = Keypair.generate();
  return { payer, messageAccount };
}

// Borsh-encode a String arg: u32 LE length prefix + UTF-8 bytes.
function encodeBorshString(s: string): Buffer {
  const utf8 = Buffer.from(s, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(utf8.length, 0);
  return Buffer.concat([lenBuf, utf8]);
}

const INITIAL_MESSAGE = "hi";
const REALLOC_MESSAGE = "hello, anvil";

export async function callAnchorReallocFlow(
  svm: LiteSVM,
  ctx: AnchorReallocCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // initialize(input: String) — sets message_account.message = input,
  // allocating exactly Message::required_space(input.len()) bytes:
  //   8 disc + 4 len-prefix + input.len() = 14 bytes for "hi".
  const initData = Buffer.concat([
    Buffer.from(anchorIxDiscriminator("initialize")),
    encodeBorshString(INITIAL_MESSAGE),
  ]);
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.messageAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  // update(input: String) — triggers Anchor's realloc constraint:
  //   realloc = Message::required_space(input.len())   // grow to new size
  //   realloc::payer = payer                            // pay rent delta
  //   realloc::zero = true                              // zero new bytes
  // Then overwrites message_account.message with the new value.
  const updateData = Buffer.concat([
    Buffer.from(anchorIxDiscriminator("update")),
    encodeBorshString(REALLOC_MESSAGE),
  ]);
  const updateIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      {
        pubkey: ctx.messageAccount.publicKey,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: updateData,
  });

  // Init tx (payer + message_account both sign — message_account is the
  // new-account signer for `init`).
  {
    const tx = new Transaction().add(initIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.messageAccount);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
    }
  }

  // Update tx — payer only; message_account is no longer a signer
  // post-init. This is the tx that exercises the realloc constraint.
  {
    const tx = new Transaction().add(updateIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`update (realloc) tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function anchorReallocAccountsToCompare(ctx: AnchorReallocCtx) {
  return [{ pubkey: ctx.messageAccount.publicKey, label: "message_account" }];
}
