import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/close-account Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-close-account.test.ts — asserts
 *     byte-equal on (a) the user_account PDA AFTER it's closed
 *     (data should be empty, lamports zero, owner reassigned to the
 *     System Program) and (b) the rent recipient (lamports should have
 *     received the closed account's lamports verbatim).
 *
 * The load-bearing surface this fixture pins down:
 *   `#[account(mut, ..., close = user)]` — Anchor's `close` constraint
 *   expands at the end of the handler into a routine that
 *     1. transfers all lamports from the account to the recipient,
 *     2. zeroes the account data,
 *     3. reassigns the account owner to the System Program,
 *     4. (Anchor 0.30+) writes the CLOSED_ACCOUNT_DISCRIMINATOR.
 *   Any Anvil emit miss on the close constraint shows up here as a
 *   data/lamport/owner divergence on either the closed account or the
 *   recipient. Pre-close state is set up by calling `create_user(name)`
 *   first so the PDA exists and is rent-funded.
 *
 * Multi-file Anchor program — lib.rs declares `mod instructions; mod state;`
 * with handlers in instructions/{create_user.rs, close_user.rs} and the
 * account type in state/user_state.rs. Anvil's parser ingests the
 * flattened buildProjectSource blob; the reference Anchor build uses
 * anchorReferenceCrateDir so the upstream crate compiles verbatim with
 * its own Cargo.toml + anchor-lang version pin.
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
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const CRATE_DIR =
  `${REPO_PATH}/basics/close-account/anchor/programs/close-account`;
export const LIB_RS = `${CRATE_DIR}/src/lib.rs`;

// Upstream declare_id! — preserved verbatim. Both the reference Anchor
// build (via anchorReferenceCrateDir, which compiles the upstream crate
// as-is) and the Anvil-emitted .so are deployed at this address, so
// PDA derivations + DeclaredProgramIdMismatch checks line up.
export const PROGRAM_ID = "99TQtoDdQ5NS2v5Ppha93aqEmv3vV9VZVfHTP5rGST3c";

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
      `[program-examples-close-account-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file program — lib.rs is just `mod instructions; mod state;`
  // declarations. Flatten through Anvil's parser path so the Accounts
  // structs + handler bodies + UserState are visible to the parser.
  // The reference Anchor build uses anchorReferenceCrateDir so it
  // compiles the original on-disk crate tree without needing the
  // flattened blob.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

// Borsh String encoding: u32 LE length + UTF-8 bytes. Used for the
// `name: String` argument to create_user.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export interface CloseAccountCtx {
  payer: Keypair;
  // user_account is a PDA at [b"USER", user.key().as_ref()] under the
  // program. Same payer/user across both .so runs so the PDA address
  // is byte-identical.
  userAccountPda: PublicKey;
  name: string;
}

const USER_NAME = "Anvil Tester";

export async function setupCloseAccount(): Promise<CloseAccountCtx> {
  const payer = Keypair.generate();
  const programIdPk = new PublicKey(PROGRAM_ID);
  // PDA: seeds = [b"USER", user.key().as_ref()] — the signer (`user`)
  // is the payer in this scenario (single account fills both roles per
  // the upstream Accounts struct).
  const [userAccountPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("USER"), payer.publicKey.toBuffer()],
    programIdPk,
  );
  return { payer, userAccountPda, name: USER_NAME };
}

export async function callCloseAccountFlow(
  svm: LiteSVM,
  ctx: CloseAccountCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Step 1: create_user(name) — allocates the PDA, funds it for rent,
  // writes UserState { bump, user, name }. Required so step 2 has
  // something to close.
  //
  // CreateUserContext accounts:
  //   - user (signer, mut)
  //   - user_account (PDA, init, mut)
  //   - system_program
  {
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.userAccountPda, isSigner: false, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(
        concatBytes(
          anchorIxDiscriminator("create_user"),
          borshString(ctx.name),
        ),
      ),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`create_user tx failed: ${txFailureMessage(r)}`);
    }
  }

  // Step 2: close_user() — the load-bearing call. The `close = user`
  // constraint on user_account expands into the close routine that
  // drains lamports → user, zeroes data, reassigns owner → System.
  //
  // CloseUserContext accounts:
  //   - user (signer, mut) — also the rent recipient
  //   - user_account (PDA, mut) — closed by the constraint
  // No system_program account on this ix (close doesn't CPI to system).
  {
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ctx.userAccountPda, isSigner: false, isWritable: true },
      ],
      data: Buffer.from(anchorIxDiscriminator("close_user")),
    });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`close_user tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function closeAccountAccountsToCompare(ctx: CloseAccountCtx) {
  // Both targets get compared on data + lamports + owner (harness defaults).
  //   - user_account: post-close — expect empty data, 0 lamports, owner=System.
  //   - user (payer): rent recipient — lamports must match between runs
  //     (start = airdrop, minus identical tx fees, plus identical refunded
  //     rent from the close). Any divergence here means the close routine
  //     transferred a different lamport amount in one of the .so binaries.
  return [
    { pubkey: ctx.userAccountPda, label: "user_account_closed" },
    { pubkey: ctx.payer.publicKey, label: "user_recipient" },
  ];
}
