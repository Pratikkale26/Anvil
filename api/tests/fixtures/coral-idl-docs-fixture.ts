/**
 * Shared fixture pieces for coral-xyz/anchor's `tests/idl/programs/docs` program.
 *
 * Re-used by:
 *   - differential-coral-idl-docs.test.ts — asserts byte-equal on the
 *     pre-seeded `DataWithDoc` account post-test_idl_doc_parse.
 *
 * Source-of-truth for upstream repo path, PROGRAM_ID, scenario setup,
 * scenario call-script, and the account the instruction touches.
 *
 * What the program does:
 *   Single instruction `test_idl_doc_parse(_ctx: Context<TestIdlDocParse>)
 *   -> Result<()>` whose body is just `Ok(())`. The TestIdlDocParse Accounts
 *   struct declares one field: `pub act: Account<'info, DataWithDoc>` (no
 *   init, no mut). The program is purely a vehicle for exercising Anchor's
 *   doc-comment IDL extraction (which is why upstream uses it in tests/idl).
 *
 * Why a no-op handler is still a meaningful byte-equal target:
 *   `Account<'info, DataWithDoc>` REQUIRES the wire-supplied account to be
 *   program-owned, already initialised (8-byte discriminator + 2-byte u16
 *   payload), and successfully borsh-deserialise. We pre-seed the account
 *   inside callScript with the canonical Anchor discriminator
 *   (sha256("account:DataWithDoc")[..8]) + a distinctive u16 value, mark
 *   it program-owned, and fund it past rent-exemption. The handler does
 *   nothing — but Anchor's macro expansion DOES run its constraint
 *   plumbing (deserialize, ownership check), and then Anvil's emitted
 *   equivalent has to do the same. If Anvil's emit accidentally writes,
 *   reassigns, reallocates, or zeroes the account on a non-mut typed
 *   handler, the byte-compare catches it.
 *
 * Multi-file project? No — single src/lib.rs. Cargo.toml uses a path-dep
 * (`anchor-lang = { path = "../../../../lang" }`), so this fixture uses
 * `anchorReferenceCrateDir` so cargo can resolve the workspace path-dep
 * verbatim. Anvil's emit consumes the raw lib.rs string.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  sha256,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = "/tmp/coral-anchor";
export const LIB_RS = `${REPO_PATH}/tests/idl/programs/docs/src/lib.rs`;
export const CRATE_DIR = `${REPO_PATH}/tests/idl/programs/docs`;

// Use the upstream-declared `declare_id!` verbatim. Both the reference
// Anchor build (via anchorReferenceCrateDir — builds upstream lib.rs as-is)
// and the Anvil-emitted .so must match this ID. mkTestProgramId() would
// require rewriting the declare_id! macro AND the upstream Cargo.toml's
// crate output, which fights the anchorReferenceCrateDir contract. Match
// the same upstream-PROGRAM_ID approach used by coral-pda-derivation.
export const PROGRAM_ID = "Docs111111111111111111111111111111111111111";

// Canonical Anchor account discriminator: first 8 bytes of
// sha256("account:<StructName>"). Pre-seeded into the witness account so
// Anchor's Account<'info, DataWithDoc> deserialiser accepts it.
function dataWithDocDiscriminator(): Uint8Array {
  return sha256(new TextEncoder().encode("account:DataWithDoc")).slice(0, 8);
}

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
      `[coral-idl-docs-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: coral-anchor was not cloned. Differential will skip.";
  }
  // Single-file program — readFileSync raw to bypass buildProjectSource's
  // error!() → ProgramError::from normalization (matches the pattern used
  // by sibling coral fixtures). The upstream declare_id! is preserved
  // verbatim; both the reference Anchor build and the Anvil-emitted .so
  // see the same PROGRAM_ID.
  return readFileSync(LIB_RS, "utf-8");
}

export interface IdlDocsCtx {
  payer: Keypair;
  // Pre-seeded program-owned account passed as the lone declared account.
  // Anchor's Account<'info, DataWithDoc> requires a valid 8-byte
  // discriminator + the 2-byte u16 payload, program-owned, rent-exempt.
  act: PublicKey;
  // Recoverable expected post-state bytes for the disc + u16 payload so
  // that any drift in the byte-compare is obviously traceable.
  actPreimage: Uint8Array;
}

// Distinctive non-zero u16 value pre-seeded into the witness account.
// 0xBEEF is recognisable in hex dumps if a future regression diverges.
const DATA_VALUE_U16 = 0xbeef;

export async function setupIdlDocs(): Promise<IdlDocsCtx> {
  const payer = Keypair.generate();
  // act only needs a pubkey — it's never a signer (no init).
  const act = Keypair.generate().publicKey;

  // 8-byte Anchor disc + u16 LE payload = 10 bytes total.
  const disc = dataWithDocDiscriminator();
  const payload = new Uint8Array(10);
  payload.set(disc, 0);
  // u16 LE
  payload[8] = DATA_VALUE_U16 & 0xff;
  payload[9] = (DATA_VALUE_U16 >> 8) & 0xff;

  return { payer, act, actPreimage: payload };
}

export async function callIdlDocs(
  svm: LiteSVM,
  ctx: IdlDocsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Pre-seed the witness as program-owned with the canonical disc + u16
  // payload. Done inside callScript so both Anchor and Anvil scenarios
  // see the identical pre-state. Fund well above rent-exempt for a 10
  // byte account so Anchor's deserialiser doesn't reject on rent.
  svm.setAccount(ctx.act, {
    lamports: 10_000_000,
    data: ctx.actPreimage,
    owner: programId,
    executable: false,
    rentEpoch: 0n,
  });

  // TestIdlDocParse declares one field: `pub act: Account<'info, DataWithDoc>`
  // (not mut, no init). Non-writable on the wire — the handler is `Ok(())`
  // and shouldn't try to mutate. Not a signer either.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.act, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("test_idl_doc_parse")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`test_idl_doc_parse tx failed: ${txFailureMessage(r)}`);
  }
}

export function idlDocsAccountsToCompare(ctx: IdlDocsCtx) {
  // The act account is pre-seeded with the canonical Anchor disc +
  // DATA_VALUE_U16 payload and program-owned. The handler body is
  // `Ok(())` and the TestIdlDocParse struct field is non-mut. Both runs
  // must leave it byte-identical (data + lamports + owner).
  return [{ pubkey: ctx.act, label: "act" }];
}
