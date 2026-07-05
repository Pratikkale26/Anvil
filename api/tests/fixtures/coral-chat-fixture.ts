import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/chat/programs/chat`
 * — specifically the `create_user` instruction.
 *
 * Re-used by:
 *   - differential-coral-chat.test.ts — asserts byte-equal on the User PDA
 *     post-create_user (Pinocchio target).
 *
 * Why `create_user` over the other two handlers:
 *   - `create_user` is the only state-init handler with body writes that
 *     can be byte-compared. `create_chat_room` uses `#[account(zero)]` on
 *     a pre-allocated 10MB zero-copy AccountLoader (huge + harder to
 *     fixture). `send_message` is a follow-up that reads the chat-room
 *     buffer; not a state-init.
 *   - The handler exercises a tight bundle of bytes worth verifying
 *     identically across targets:
 *       * Anchor-style PDA init with seeds = [authority.key().as_ref()]
 *       * Borsh-serialized String field (length-prefix + UTF-8 bytes)
 *       * Pubkey authority field
 *       * Bump byte from ctx.bumps.user
 *     The total written payload after create_user("anvil") is
 *       [disc(8)] [name_len(4)=5] [name=b"anvil"(5)] [authority(32)] [bump(1)]
 *     = 50 bytes, with the remaining 195 bytes (245 alloc - 50 written)
 *     left as the zero-buffer from system_program::create_account.
 *     Both runs must produce the identical 245-byte account body.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * Source: github.com/coral-xyz/anchor — tests/chat/programs/chat.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = join(TEST_SCRATCH, "coral-anchor");
export const LIB_RS = `${REPO_PATH}/tests/chat/programs/chat/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/chat/programs/chat`;
// Matches declare_id! in lib.rs verbatim — default Anchor test ID.
export const PROGRAM_ID = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    [
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "https://github.com/coral-xyz/anchor",
      REPO_PATH,
    ],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (r.status !== 0) {
    console.warn(
      `[coral-chat-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — raw readFileSync bypasses buildProjectSource's
  // error!() → ProgramError::from normalization. The chat program has a
  // tiny `enum ErrorCode { Unknown }` declared but never used by
  // create_user, so the normalization isn't strictly needed; raw is the
  // safe default matching the sibling coral fixtures.
  return readFileSync(LIB_RS, "utf-8");
}

export interface CreateUserCtx {
  payer: Keypair;        // The Anchor source calls this `authority`.
  userPda: PublicKey;
  name: string;
}

// Deterministic name — keeps the borsh-serialized payload identical
// across runs. 5 bytes (UTF-8) chosen to fit comfortably under max_len(200).
const USER_NAME = "anvil";

export async function setupCreateUser(): Promise<CreateUserCtx> {
  const payer = Keypair.generate();
  const programIdPk = new PublicKey(PROGRAM_ID);
  // PDA derivation matches Accounts struct: seeds = [authority.key().as_ref()]
  const [userPda] = PublicKey.findProgramAddressSync(
    [payer.publicKey.toBuffer()],
    programIdPk,
  );
  return { payer, userPda, name: USER_NAME };
}

// Borsh String encoding: u32 LE length-prefix + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export async function callCreateUser(
  svm: LiteSVM,
  ctx: CreateUserCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // CreateUser Accounts struct (lib.rs order):
  //   user: Account<User>           — init via seeds = [authority.key], bump
  //                                   (PDA-derived; only payer signs)
  //   authority: Signer<'info>      — mut, signer (pays for create_account)
  //   system_program: AccountInfo   — readonly (CPI target for create_account)
  //
  // Args: name: String (borsh u32-len + UTF-8 bytes)
  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("create_user"),
      borshString(ctx.name),
    ),
  );

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.userPda, isSigner: false, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`chat/create_user tx failed: ${txFailureMessage(r)}`);
  }
}

export function userAccountsToCompare(ctx: CreateUserCtx) {
  return [{ pubkey: ctx.userPda, label: "user_pda" }];
}
