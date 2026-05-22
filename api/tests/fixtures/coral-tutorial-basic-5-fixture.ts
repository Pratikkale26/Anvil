/**
 * Shared fixture pieces for coral-xyz/anchor's `examples/tutorial/basic-5`
 * program (the robot-action-state example).
 *
 * Re-used by:
 *   - differential-coral-tutorial-basic-5.test.ts — asserts byte-equal on
 *     the `action_state` PDA after a create -> walk -> jump scenario.
 *
 * What the program does:
 *   PDA `action_state` with seeds = [b"action-state", user.key().as_ref()].
 *   Five instructions:
 *     - create: init, sets {user, action: 0}
 *     - walk:   action = 1   (has_one = user)
 *     - run:    action = 2   (has_one = user)
 *     - jump:   action = 3   (has_one = user)
 *     - reset:  action = 0   (has_one = user)
 *
 * Scope: byte-equal on `action_state` PDA after `create -> walk -> jump`.
 * The expected post-state is `{ user, action: 3 }`. The scenario exercises:
 *   - PDA derivation with two-part seed (literal + signer key)
 *   - #[account(init, payer, space = 8 + ActionState::INIT_SPACE)]
 *   - has_one = user constraint validation on follow-up calls
 *   - sequential mutation of a single u8 field — regression catcher for
 *     emit drift on plain field-assign branches
 *
 * Single-file program. Upstream Cargo.toml path-deps anchor-lang from
 *   `../../../../../lang`, so the fixture uses `anchorReferenceCrateDir`.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
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

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/examples/tutorial/basic-5/programs/basic-5/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/examples/tutorial/basic-5/programs/basic-5`;

// Upstream declare_id! verbatim.
export const PROGRAM_ID = "DuT6R8tQGYa8ACYXyudFJtxDppSALLcmK39b7918jeSC";

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
      `[coral-tutorial-basic-5-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface BasicFiveCtx {
  user: Keypair;
  actionStatePda: PublicKey;
  actionStateBump: number;
}

export async function setupBasicFive(): Promise<BasicFiveCtx> {
  const user = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  // seeds = [b"action-state", user.key().as_ref()]
  const [actionStatePda, actionStateBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("action-state"), user.publicKey.toBuffer()],
    programId,
  );
  return { user, actionStatePda, actionStateBump };
}

export async function callCreateWalkJump(
  svm: LiteSVM,
  ctx: BasicFiveCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.user.publicKey, BigInt(10_000_000_000));

  // create: no args — `create(ctx: Context<Create>) -> Result<()>`.
  // Create Accounts struct order (source order):
  //   action_state: PDA Account (init, payer = user, seeds=[...], bump)
  //     — writable, NOT a signer (PDA — Anchor signs via invoke_signed)
  //   user: Signer (mut) — pays for create_account
  //   system_program: Program<System>
  const createIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.actionStatePda, isSigner: false, isWritable: true },
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("create")),
  });

  // walk: no args. Accounts struct order: action_state (mut, has_one=user),
  // user (mut, Signer). No system_program — no init on this path.
  const walkIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.actionStatePda, isSigner: false, isWritable: true },
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(anchorIxDiscriminator("walk")),
  });

  // jump: same shape as walk.
  const jumpIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.actionStatePda, isSigner: false, isWritable: true },
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
    ],
    data: Buffer.from(anchorIxDiscriminator("jump")),
  });

  // create tx
  {
    const tx = new Transaction().add(createIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.user.publicKey;
    tx.sign(ctx.user);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`create tx failed: ${txFailureMessage(r)}`);
    }
  }

  // walk tx
  {
    const tx = new Transaction().add(walkIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.user.publicKey;
    tx.sign(ctx.user);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`walk tx failed: ${txFailureMessage(r)}`);
    }
  }

  // jump tx
  {
    const tx = new Transaction().add(jumpIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.user.publicKey;
    tx.sign(ctx.user);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`jump tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function basic5AccountsToCompare(ctx: BasicFiveCtx) {
  // 8-byte disc + 32-byte user pubkey + 1-byte action = 41 bytes.
  // After create -> walk -> jump, the expected payload is { user, action: 3 }.
  return [{ pubkey: ctx.actionStatePda, label: "action_state" }];
}
