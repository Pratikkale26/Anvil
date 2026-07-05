import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/token-swap Anchor program — specifically the `create_amm`
 * instruction.
 *
 * Re-used by:
 *   - differential-program-examples-token-swap.test.ts — asserts
 *     byte-equal on the Amm PDA post-create_amm.
 *
 * Why create_amm earns the byte-equal slot:
 *   The token-swap crate has 5 instructions (create_amm, create_pool,
 *   deposit_liquidity, withdraw_liquidity, swap_exact_tokens_for_tokens).
 *   create_amm is the only one that is pure state-init: no CPI to SPL
 *   Token, no associated-token-account allocation, no fixed-point I64F64
 *   math. It pins down the load-bearing emit shapes that downstream
 *   pool / liquidity / swap ixs all build on top of:
 *     - `#[account(init, payer, space = Amm::LEN, seeds=[id.as_ref()], bump,
 *        constraint = fee < 10000 @ TutorialError::InvalidFee)]` —
 *       PDA-init from a Pubkey-seed + space-from-impl-const + a typed
 *       constraint+error.
 *     - Handler body writes three scalars (id Pubkey, admin Pubkey from
 *       ctx.accounts.admin.key(), fee u16) — covers Pubkey + u16 layout
 *       and `ctx.accounts.X.key()` access.
 *   Total account size: 8 (disc) + 32 + 32 + 2 = 74 bytes — small enough
 *   that any per-byte divergence is immediately visible in the harness diff.
 *
 * Multi-file Anchor program (lib.rs declares `mod constants; mod errors;
 * mod instructions; mod state;` with handler bodies + Accounts structs split
 * across instructions/*.rs and state.rs / errors.rs / constants.rs). Anvil
 * parser path consumes `buildProjectSource` flattened blob; the reference
 * build uses `anchorReferenceCrateDir` so the upstream Cargo.toml's
 * anchor-lang 1.0.0-rc.5 + fixed 1.27 deps resolve verbatim.
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
  `${REPO_PATH}/tokens/token-swap/anchor/programs/token-swap`;
export const LIB_RS = `${CRATE_DIR}/src/lib.rs`;

// Upstream declare_id! — preserved verbatim. The reference build (via
// anchorReferenceCrateDir) compiles the upstream crate as-is; the Anvil
// emit is overridden to this same ID at scaffold time so both .so files
// are deployed at the same address. Matters because:
//   - DeclaredProgramIdMismatch (Anchor 0.30+ security check, error 4100)
//   - the AMM PDA seeded by id.as_ref() — the PDA address itself doesn't
//     depend on the program ID, but the owner-stamp on the account does.
export const PROGRAM_ID = "AsGVFxWqEn8icRBFQApxJe68x3r9zvfSbmiEzYFATGYn";

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
      `[program-examples-token-swap-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file program — lib.rs is `mod constants; mod errors; mod
  // instructions; mod state;`. Flatten through Anvil's parser path so
  // all Accounts structs + handler bodies + state types + constants are
  // visible in one blob. Reference build uses anchorReferenceCrateDir
  // so the on-disk tree compiles verbatim with its own Cargo.toml.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface CreateAmmCtx {
  payer: Keypair;
  /** AMM "primary key" — Pubkey arg fed to create_amm. Also the PDA seed. */
  ammId: PublicKey;
  /** Admin authority for the AMM. Read-only AccountInfo on the ix. */
  admin: PublicKey;
  /** Derived PDA: seeds = [id.as_ref()]. */
  ammPda: PublicKey;
  /** Fee in basis points. Constraint requires fee < 10_000. */
  fee: number;
}

// Deterministic, in-bounds fee. Constraint is `fee < 10000` — pick something
// non-zero so the field isn't accidentally byte-equal-from-init.
const FEE_BPS = 250;

export async function setupCreateAmm(): Promise<CreateAmmCtx> {
  const payer = Keypair.generate();
  const programIdPk = new PublicKey(PROGRAM_ID);
  // ammId / admin are deterministic Pubkeys derived from fixed seed bytes
  // so both .so runs see the identical PDA address + identical admin write.
  const ammIdBytes = new Uint8Array(32);
  ammIdBytes.set(Buffer.from("anvil-test-amm-id", "utf-8"));
  const ammId = new PublicKey(ammIdBytes);

  const adminBytes = new Uint8Array(32);
  adminBytes.set(Buffer.from("anvil-test-amm-admin", "utf-8"));
  const admin = new PublicKey(adminBytes);

  // PDA: seeds = [id.as_ref()] under the program. id is a 32-byte Pubkey,
  // so the seed is just the Pubkey bytes verbatim.
  const [ammPda] = PublicKey.findProgramAddressSync(
    [ammId.toBuffer()],
    programIdPk,
  );
  return { payer, ammId, admin, ammPda, fee: FEE_BPS };
}

export async function callCreateAmm(
  svm: LiteSVM,
  ctx: CreateAmmCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // CreateAmm accounts (declaration order in the source):
  //   amm:            PDA, init, writable, not signer
  //   admin:          AccountInfo (read-only) — not signer, not writable
  //   payer:          Signer, writable
  //   system_program: read-only
  //
  // Borsh args: id (Pubkey, 32 bytes) + fee (u16 LE, 2 bytes).
  const idBytes = ctx.ammId.toBuffer();
  const feeBytes = Buffer.alloc(2);
  feeBytes.writeUInt16LE(ctx.fee, 0);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.ammPda, isSigner: false, isWritable: true },
      { pubkey: ctx.admin, isSigner: false, isWritable: false },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("create_amm"),
        idBytes,
        feeBytes,
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_amm tx failed: ${txFailureMessage(r)}`);
  }
}

export function createAmmAccountsToCompare(ctx: CreateAmmCtx) {
  // Compare only the AMM PDA. Layout post-init:
  //   [disc(8)] [id Pubkey(32)] [admin Pubkey(32)] [fee u16(2)] = 74 bytes
  // Discriminator strip leaves the 66-byte state body for the byte compare.
  return [{ pubkey: ctx.ammPda, label: "amm_pda" }];
}
