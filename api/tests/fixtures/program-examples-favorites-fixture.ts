import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/favorites/anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-favorites.test.ts — asserts byte-equal
 *     on the Favorites PDA post-set_favorites.
 *
 * Program shape:
 *   Single instruction `set_favorites(ctx, number: u64, color: String,
 *   hobbies: Vec<String>)` whose body is
 *   `context.accounts.favorites.set_inner(Favorites { number, color, hobbies })`.
 *   The Favorites account is an init_if_needed PDA with
 *   seeds=[b"favorites", user.key().as_ref()], payer = user, space = 8 +
 *   Favorites::INIT_SPACE — where InitSpace derives the layout from
 *   `#[max_len(50)]` on color and `#[max_len(5, 50)]` on hobbies. Total
 *   account size = 8 (disc) + 8 (number) + (4+50) (color) + (4 + 5*(4+50))
 *   (hobbies) = 344 bytes.
 *
 * Why this is a meaningful byte-equal target:
 *   Variable-length Borsh serialization (String, Vec<String>) is exactly
 *   the class of payload that catches emit bugs in length prefixes,
 *   UTF-8 byte ordering, and trailing-zero handling. set_inner reassigns
 *   the entire struct, so any drift in field-order, length-prefix-width,
 *   or struct-padding shows up as a divergence.
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
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const LIB_RS =
  `${REPO_PATH}/basics/favorites/anchor/programs/favorites/src/lib.rs`;
export const CRATE_DIR =
  `${REPO_PATH}/basics/favorites/anchor/programs/favorites`;

// Use the upstream-declared declare_id! verbatim. Both targets are
// deployed at this ID; the favorites PDA derivation in setup() uses the
// same ID so the derived address is stable across runs.
export const PROGRAM_ID = "ww9C83noARSQVBnqmCUmaVdbJjmiwcV9j2LkXYMoUCV";

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
      `[program-examples-favorites-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Single-file program — readFileSync raw to bypass buildProjectSource's
  // error!() normalization (matches the established sibling-fixture pattern
  // for program-examples-counter / coral-multisig). The upstream
  // declare_id! is preserved verbatim; both the reference Anchor build
  // (via anchorReferenceCrateDir) and the Anvil-emitted .so deploy at
  // the same PROGRAM_ID.
  return readFileSync(LIB_RS, "utf-8");
}

// Borsh String: u32 LE length + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

// Borsh Vec<String>: u32 LE count + each String encoded as above.
function borshVecString(items: string[]): Uint8Array {
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, items.length, true);
  return concatBytes(head, ...items.map(borshString));
}

export interface FavoritesCtx {
  payer: Keypair;
  favoritesPda: PublicKey;
  number: bigint;
  color: string;
  hobbies: string[];
}

// Distinctive deterministic args. number=42 is recognisable in hex
// dumps (0x2a 00 00 00 00 00 00 00 LE); color/hobbies pick string
// values with byte-lengths that exercise the length-prefix path
// without hitting max_len bounds.
const NUMBER: bigint = 42n;
const COLOR = "blue";
const HOBBIES = ["coding", "skating"];

export async function setupFavorites(): Promise<FavoritesCtx> {
  const payer = Keypair.generate();
  // Derive the favorites PDA against PROGRAM_ID (the constant), not the
  // runtime programId arg passed into callScript. Both targets are
  // deployed at PROGRAM_ID — the PDA derivation must be stable across
  // both runs for the post-state byte-compare to be apples-to-apples.
  const programId = new PublicKey(PROGRAM_ID);
  const [favoritesPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("favorites"), payer.publicKey.toBuffer()],
    programId,
  );
  return {
    payer,
    favoritesPda,
    number: NUMBER,
    color: COLOR,
    hobbies: HOBBIES,
  };
}

export async function callSetFavorites(
  svm: LiteSVM,
  ctx: FavoritesCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Anchor borsh-serializes ix args positionally by handler signature:
  //   number: u64       (8 bytes LE)
  //   color: String     (u32 LE len + UTF-8)
  //   hobbies: Vec<String> (u32 LE count + each String)
  const data = Buffer.from(
    concatBytes(
      anchorIxDiscriminator("set_favorites"),
      encodeU64LE(ctx.number),
      borshString(ctx.color),
      borshVecString(ctx.hobbies),
    ),
  );

  // SetFavorites Accounts struct order:
  //   1. user            — Signer, mut (pays for init_if_needed)
  //   2. favorites       — PDA, mut, NOT a signer on the wire
  //                        (Anchor's init_if_needed emits an internal
  //                         system::create_account invoke_signed using
  //                         the bump seeds — caller never signs as PDA).
  //   3. system_program  — readonly (CPI target for create_account)
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.favoritesPda, isSigner: false, isWritable: true },
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
    throw new Error(`set_favorites tx failed: ${txFailureMessage(r)}`);
  }
}

export function favoritesAccountsToCompare(ctx: FavoritesCtx) {
  // The favorites PDA holds the entire set_inner result. Variable-length
  // Borsh state (String + Vec<String>) is the primary signal we're after.
  return [{ pubkey: ctx.favoritesPda, label: "favorites" }];
}
