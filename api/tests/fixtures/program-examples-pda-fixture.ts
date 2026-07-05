import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/program-derived-addresses/anchor program.
 *
 * Source: github.com/solana-developers/program-examples —
 *   basics/program-derived-addresses/anchor/programs/anchor-program-example/
 *
 * Multi-file Anchor program:
 *   - src/lib.rs           — declare_id + #[program] module
 *   - src/state/mod.rs     — re-exports
 *   - src/state/page_visits.rs — PageVisits account (page_visits: u32, bump: u8)
 *   - src/instructions/mod.rs   — re-exports
 *   - src/instructions/create.rs    — create_page_visits handler
 *   - src/instructions/increment.rs — increment_page_visits handler
 *
 * Why PDA derivation is interesting for byte-equal:
 *   - create_page_visits: Anchor's `#[account(init, seeds, bump, payer, space)]`
 *     macro expands to: derive PDA from seeds, system::create_account via
 *     PDA signer-seeds CPI, then write the discriminator + state struct.
 *     Anvil's emit replays the exact PDA derivation + create_account flow,
 *     including writing the `bump: u8` cache field into account data.
 *
 * Scenario flow: create_page_visits only. Post-scenario the PDA has
 *   `page_visits: u32 = 0, bump: u8 = <PDA-derived>`
 * The non-zero bump byte exercises the PDA-derivation lane: a divergence
 * in Anvil's findProgramAddress (wrong seeds order, wrong program ID
 * threading) surfaces immediately because the bump differs.
 *
 * The second ix `increment_page_visits` is intentionally NOT exercised in
 * this fixture — it surfaces a separate Anvil emit gap (method-receiver
 * mutation on a read-only-bound local doesn't write back to the account)
 * that warrants its own targeted fixture once the write-back path is
 * extended. Tracking that here would couple two unrelated emit paths into
 * a single failure mode.
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
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const LIB_RS =
  `${REPO_PATH}/basics/program-derived-addresses/anchor/programs/anchor-program-example/src/lib.rs`;

// Matches the upstream declare_id! verbatim. Decodes to 32 bytes — verified
// via PublicKey.toBytes().length. The harness deploys at this address in
// both Anchor and Anvil scenarios so account ownership lines up.
export const PROGRAM_ID = "oCCQRZyAbVxujyd8m57MPmDzZDmy2FoKW4ULS7KofCE";

// PageVisits::SEED_PREFIX in state/page_visits.rs.
const SEED_PREFIX = Buffer.from("page_visits");

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
      `[program-examples-pda-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file Anchor program — flatten src/{lib,state/*,instructions/*}.rs
  // into a single string. Both Anvil parser AND the reference Anchor build
  // consume the same flattened blob (the harness writes it to scratch
  // lib.rs and writes its own Cargo.toml pinned to anchor-lang 0.32).
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface PageVisitsCtx {
  payer: Keypair;
  /** Derived PDA address — Anchor's `seeds = [SEED_PREFIX, payer.key().as_ref()]`. */
  pageVisitsPda: PublicKey;
  /** Cached bump for assertion-only debugging; the on-chain account stores
   *  this value in its `bump: u8` field post-create. */
  bump: number;
}

export async function setupPageVisits(): Promise<PageVisitsCtx> {
  const payer = Keypair.generate();
  const [pageVisitsPda, bump] = PublicKey.findProgramAddressSync(
    [SEED_PREFIX, payer.publicKey.toBuffer()],
    new PublicKey(PROGRAM_ID),
  );
  return { payer, pageVisitsPda, bump };
}

export async function callPageVisitsFlow(
  svm: LiteSVM,
  ctx: PageVisitsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // create_page_visits: discriminator-only ix data (no args).
  // CreatePageVisits accounts struct declaration order:
  //   payer (mut, signer)
  //   page_visits (init, mut — PDA, NOT a tx-level signer; Anchor's init
  //     macro CPIs into system_program with PDA signer-seeds internally)
  //   system_program
  const createIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.pageVisitsPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("create_page_visits")),
  });

  // increment_page_visits — exercises the impl-method inlining fix
  // (Finding #51). IncrementPageVisits accounts: user + page_visits PDA.
  // Source: `let page_visits = &mut ctx.accounts.page_visits;
  // page_visits.increment();` — the impl method `increment(&mut self)`
  // lives in src/state/page_visits.rs and mutates self.page_visits via
  // checked_add(1). Pre-fix the mutation was dropped; post-fix it
  // round-trips back to account data via the existing state-field-assign
  // classifier. Byte-equal post-scenario:
  //   page_visits: 1, bump: <derived>
  const incrementIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.pageVisitsPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(anchorIxDiscriminator("increment_page_visits")),
  });

  for (const ix of [createIx, incrementIx]) {
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`page_visits flow tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function pageVisitsAccountsToCompare(ctx: PageVisitsCtx) {
  // Compare only the PDA — the payer is a system-owned wallet whose
  // residual lamport balance diverges by design (tx fee, rent paid for
  // the PDA). The PDA carries the authoritative byte signal:
  //   discriminator (8) + page_visits: u32 (4) + bump: u8 (1) = 13 bytes
  return [{ pubkey: ctx.pageVisitsPda, label: "page_visits_pda" }];
}
