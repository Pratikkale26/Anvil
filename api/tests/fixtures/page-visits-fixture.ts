/**
 * Shared fixture pieces for the `program-derived-addresses` Anchor
 * program from solana-developers/program-examples (basics/program-
 * derived-addresses).
 *
 * Externally-authored Anchor program — RW6. Two-instruction flow:
 *
 *   1. create_page_visits(ctx) — creates a PDA seeded by
 *      [b"page_visits", payer.key()]. Stores `PageVisits {
 *      page_visits: u32, bump: u8 }`.
 *   2. increment_page_visits(ctx) — increments page_visits via an
 *      impl method on the state struct.
 *
 * Scenario here exercises ONLY `create_page_visits` for the narrow
 * byte-equal gate. The `.increment()` impl-method call exercises an
 * Anchor auto-save pattern where mutations through `&mut
 * ctx.accounts.X` get persisted on Drop — Anvil's emit doesn't
 * structurally model that today (custom-method mutation detection is
 * narrower than Anchor's blanket Drop hook). Adding the increment to
 * the byte-equal scenario would surface a known gap; covering create
 * alone keeps the fixture honest about what's currently provable.
 *
 * Multi-file Anchor project (constants/state/instructions modules)
 * — uses project-source helpers to flatten for Anvil's parser.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
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

export const LIB_RS =
  "/tmp/program-examples/basics/program-derived-addresses/anchor/programs/anchor-program-example/src/lib.rs";
export const CRATE_DIR =
  "/tmp/program-examples/basics/program-derived-addresses/anchor/programs/anchor-program-example";
export const PROGRAM_ID = "oCCQRZyAbVxujyd8m57MPmDzZDmy2FoKW4ULS7KofCE";

export function isAvailable(): boolean {
  if (existsSync(LIB_RS)) return true;
  console.warn(
    `[page-visits-fixture] /tmp/program-examples missing; run a test that triggers ` +
      `the realworld-cargo auto-clone first.`,
  );
  return false;
}

export function loadAnchorSource(): string {
  if (!isAvailable()) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface PageVisitsCtx {
  payer: Keypair;
  pageVisitsPda: PublicKey;
}

export async function setupPageVisits(): Promise<PageVisitsCtx> {
  const payer = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  const [pageVisitsPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("page_visits"), payer.publicKey.toBuffer()],
    programId,
  );
  return { payer, pageVisitsPda };
}

export async function callCreatePageVisits(
  svm: LiteSVM,
  ctx: PageVisitsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.pageVisitsPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("create_page_visits")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if ("err" in r) throw new Error(`create_page_visits tx failed: ${JSON.stringify(r.err)}`);
}
