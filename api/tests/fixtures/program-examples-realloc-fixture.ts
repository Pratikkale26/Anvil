import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/realloc/anchor program — the SHRINK path of Anchor's realloc
 * constraint family.
 *
 * Distinct from sibling `program-examples-anchor-realloc-fixture.ts`:
 *   - sibling: initialize("hi") -> update("hello, anvil") -> GROW
 *   - this:    initialize("hello") -> update("x")        -> SHRINK
 *
 * Why both directions are worth gating:
 *   `realloc::zero = true` is most commonly associated with growth (zero
 *   the freshly-allocated bytes), but the realloc runtime path also runs
 *   on shrink — the account length drops to the new size and the rent
 *   delta is REFUNDED to `realloc::payer`. If Anvil's emit silently drops
 *   the realloc constraint on the shrink branch, the account stays at
 *   the original length (17 bytes here) with stale trailing bytes
 *   ("ello" of the prior payload) instead of shrinking to 13. The
 *   byte-equal compare catches that — Anchor's reference build shrinks,
 *   Anvil's emit must too. Lamports also diverge (rent refund missing on
 *   Anvil's side if realloc is dropped), which is the secondary gate.
 *
 * Targets `native` because Pinocchio's stable AccountInfo doesn't expose
 * realloc — same reason the sibling growth fixture pins native.
 *
 * Builds the upstream crate verbatim via `anchorReferenceCrateDir` (it
 * pins anchor-lang 1.0.0; the standalone `cargo build-sbf` resolves
 * because the per-crate Cargo.toml has no workspace path-deps). The Anvil
 * emit consumes the raw lib.rs blob through `anchorSource`.
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
export const CRATE_DIR =
  `${REPO_PATH}/basics/realloc/anchor/programs/anchor-realloc`;
export const LIB_RS = `${CRATE_DIR}/src/lib.rs`;

// Upstream declare_id! used verbatim — the harness will rewrite Anvil's
// emit to match, and the reference build (anchorReferenceCrateDir) sees
// the upstream source unchanged. No declare_id! swap needed because we
// don't share this ID with any other fixture (the sibling growth fixture
// rewrites to a different ID).
export const PROGRAM_ID = "Fod47xKXjdHVQDzkFPBvfdWLm8gEAV4iMSXkfUzCHiSD";

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
      `[program-examples-realloc-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Raw read — bypass buildProjectSource's error!() normalization (same
  // pattern as the sibling coral-* fixtures). The upstream declare_id!
  // is preserved verbatim; both the reference build and the Anvil-emit
  // see PROGRAM_ID.
  return readFileSync(LIB_RS, "utf-8");
}

export interface ReallocShrinkCtx {
  payer: Keypair;
  messageAccount: Keypair;
}

export async function setupReallocShrink(): Promise<ReallocShrinkCtx> {
  // `message_account` is a fresh keypair (Initialize has no seeds — plain
  // init via payer-supplied signer). Same keypair shared across scenarios
  // is what makes the post-state byte-comparable.
  const payer = Keypair.generate();
  const messageAccount = Keypair.generate();
  return { payer, messageAccount };
}

// Borsh String: u32 LE length + UTF-8 bytes.
function encodeBorshString(s: string): Buffer {
  const utf8 = Buffer.from(s, "utf-8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(utf8.length, 0);
  return Buffer.concat([lenBuf, utf8]);
}

// initialize -> 5-byte payload, account = 8 disc + 4 len + 5 = 17 bytes
const INITIAL_MESSAGE = "hello";
// update -> 1-byte payload, account = 8 disc + 4 len + 1 = 13 bytes
const SHRUNK_MESSAGE = "x";

export async function callReallocShrinkFlow(
  svm: LiteSVM,
  ctx: ReallocShrinkCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // initialize(input: String) — allocates Message::required_space("hello") =
  // 17 bytes (8 disc + 4 len-prefix + 5 utf-8 bytes), writes the String.
  const initData = Buffer.concat([
    Buffer.from(anchorIxDiscriminator("initialize")),
    encodeBorshString(INITIAL_MESSAGE),
  ]);
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      {
        pubkey: ctx.messageAccount.publicKey,
        isSigner: true,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: initData,
  });

  // update(input: String) — triggers Anchor's realloc constraint family on
  // the SHRINK path:
  //   realloc = Message::required_space(1)  // 17 -> 13 bytes
  //   realloc::payer = payer                // receives rent REFUND
  //   realloc::zero = true                  // no-op on shrink (no new
  //                                         //   bytes), but the constraint
  //                                         //   must still emit the
  //                                         //   realloc call itself
  // Then overwrites message_account.message with "x".
  const updateData = Buffer.concat([
    Buffer.from(anchorIxDiscriminator("update")),
    encodeBorshString(SHRUNK_MESSAGE),
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

  // Init tx — payer AND messageAccount sign (the latter is the new-account
  // signer required by Anchor's `init` expansion to system::create_account).
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

  // Update tx — only payer signs (messageAccount is post-init, no longer
  // a signer). This is the tx that exercises the realloc-shrink path.
  {
    const tx = new Transaction().add(updateIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`update (realloc shrink) tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function reallocShrinkAccountsToCompare(ctx: ReallocShrinkCtx) {
  // message_account should be exactly 13 bytes post-update (8 disc + 4 len
  // + "x"). If Anvil's emit drops the realloc constraint, the account stays
  // at 17 bytes with stale "ello" trailing — the data length divergence
  // alone fails the compare. Lamport delta (rent refund on shrink) is the
  // secondary gate via the harness's default compareLamports=true.
  return [{ pubkey: ctx.messageAccount.publicKey, label: "message_account" }];
}
