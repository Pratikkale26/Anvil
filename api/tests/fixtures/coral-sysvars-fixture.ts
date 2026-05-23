/**
 * Shared fixture pieces for coral-xyz/anchor's
 * `tests/sysvars/programs/sysvars` program.
 *
 * Re-used by:
 *   - differential-coral-sysvars.test.ts — asserts byte-equal on the
 *     three Sysvar slots post-sysvars(). Verifies Anvil's emit doesn't
 *     accidentally mutate sysvar accounts on a no-op handler.
 *
 * What the program does:
 *   Single instruction `sysvars(_ctx: Context<Sysvars>) -> Result<()>`
 *   with body `Ok(())`. The Sysvars Accounts struct declares three typed
 *   Sysvar bindings:
 *     - clock:         Sysvar<'info, Clock>
 *     - rent:          Sysvar<'info, Rent>
 *     - stake_history: Sysvar<'info, StakeHistory>
 *
 * Why typed Sysvar bindings are a meaningful byte-equal target:
 *   Sysvar<'info, T> is a fourth Anchor account-binding path none of the
 *   other shipped coral fixtures cover (coral-idl-docs = Account<T>,
 *   coral-system-accounts = SystemAccount, coral-safety-checks =
 *   UncheckedAccount/AccountInfo). Sysvars enforce:
 *     - wire pubkey == canonical sysvar pubkey (SysvarC1ock11... etc)
 *     - readonly (program cannot mutate)
 *     - deserialise the sysvar's typed payload (slot/unix_timestamp for
 *       Clock, lamports_per_byte_year for Rent, the EpochVec for
 *       StakeHistory)
 *
 *   The handler body is `Ok(())` — Anchor expands account validation
 *   first (constraint plumbing runs), then drops into the no-op handler.
 *   Anvil's emit MUST replicate the same: validate the three sysvars,
 *   then do nothing. If Anvil's emit accidentally writes to a Sysvar
 *   slot (which it can't on real chain — the runtime would reject —
 *   but LiteSVM may accept and surface the divergence), the byte
 *   compare catches it.
 *
 *   The three sysvars are pre-existing in LiteSVM with deterministic
 *   genesis state. Both runs see identical pre-state, the handler does
 *   nothing in both, post-state must remain byte-identical.
 *
 * Multi-file project? No — single src/lib.rs. Cargo.toml uses a path-dep
 * (`anchor-lang = { path = "../../../../lang" }`), so this fixture uses
 * `anchorReferenceCrateDir` so cargo can resolve the workspace path-dep
 * verbatim. Anvil's emit consumes the raw lib.rs string.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
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
export const LIB_RS = `${REPO_PATH}/tests/sysvars/programs/sysvars/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/sysvars/programs/sysvars`;

// Upstream declare_id! is Anchor's default test ID. Used verbatim because
// anchorReferenceCrateDir builds the upstream lib.rs as-is. Anvil's emit
// also targets this ID via the IR programId pulled from the same source.
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
      `[coral-sysvars-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — readFileSync raw to bypass buildProjectSource's
  // error!() → ProgramError::from normalization (matches sibling coral
  // fixtures). The upstream declare_id! is preserved verbatim.
  return readFileSync(LIB_RS, "utf-8");
}

export interface SysvarsCtx {
  payer: Keypair;
}

export async function setupSysvars(): Promise<SysvarsCtx> {
  const payer = Keypair.generate();
  return { payer };
}

export async function callSysvars(
  svm: LiteSVM,
  ctx: SysvarsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Sysvars Accounts struct declares three Sysvar bindings, all non-mut
  // and non-signer on the wire. Order in lib.rs is clock, rent,
  // stake_history.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      {
        pubkey: SYSVAR_STAKE_HISTORY_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.from(anchorIxDiscriminator("sysvars")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`sysvars tx failed: ${txFailureMessage(r)}`);
  }
}

export function sysvarsAccountsToCompare(_ctx: SysvarsCtx) {
  // Compare the Rent sysvar slot. Clock and StakeHistory drift with slot/
  // epoch advancement and would not be byte-identical if the two runs
  // execute in different LiteSVM slots. Rent is a static schedule
  // (lamports_per_byte_year + exemption_threshold + burn_percent) and
  // is deterministic across LiteSVM instances. The handler is `Ok(())`
  // and the field is non-mut — both runs must leave Rent byte-identical.
  return [{ pubkey: SYSVAR_RENT_PUBKEY, label: "rent_sysvar" }];
}
