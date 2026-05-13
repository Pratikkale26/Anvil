/**
 * Shared fixture pieces for the `favorites` Anchor program from
 * solana-developers/program-examples (basics/favorites).
 *
 * Externally-authored Anchor program with active byte-equal coverage:
 * the third real-world fixture after anchor-escrow-2025 (RW2) and
 * coral-events. Counts toward CX1's 5-fixture EM1 Phase-2-trigger
 * threshold.
 *
 * Why this one: small (66 LoC), modern Anchor (0.31), uses
 * init_if_needed + set_inner + Vec<String> — three patterns that
 * should round-trip byte-equal through Anvil's emit but exercise
 * different IR edges than the existing fixtures. The program is
 * already in /tmp/program-examples (cargo-build green on both
 * pinocchio + native per realworld-cargo.test.ts), so promotion to
 * byte-equal is a wrapper-only change with no /tmp/ bloat.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

/**
 * Path to the upstream lib.rs. Already cloned to /tmp/program-examples
 * by realworld-cargo.test.ts on first run; this fixture relies on that
 * existing clone rather than re-fetching to avoid /tmp/ bloat.
 */
export const LIB_RS =
  "/tmp/program-examples/basics/favorites/anchor/programs/favorites/src/lib.rs";
export const CRATE_DIR =
  "/tmp/program-examples/basics/favorites/anchor/programs/favorites";
export const PROGRAM_ID = "ww9C83noARSQVBnqmCUmaVdbJjmiwcV9j2LkXYMoUCV";

/**
 * Returns true if the upstream source is present and the fixture should
 * run. Returns false (with a console warn) if /tmp/program-examples
 * isn't there — realworld-cargo.test.ts auto-clones on first run; if
 * it hasn't run, this fixture skips loudly rather than silently.
 */
export function isAvailable(): boolean {
  if (existsSync(LIB_RS)) return true;
  console.warn(
    `[favorites-fixture] /tmp/program-examples missing; run a test that triggers ` +
      `the realworld-cargo auto-clone first (e.g. bun test tests/realworld-cargo.test.ts).`,
  );
  return false;
}

export function loadAnchorSource(): string {
  if (!isAvailable()) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  return readFileSync(LIB_RS, "utf-8");
}

export interface FavoritesCtx {
  user: Keypair;
  favoritesPda: PublicKey;
  /** Deterministic args used by both reference + Anvil scenarios. */
  args: { number: bigint; color: string; hobbies: string[] };
}

export async function setupFavorites(): Promise<FavoritesCtx> {
  const user = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);
  const [favoritesPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("favorites"), user.publicKey.toBuffer()],
    programId,
  );
  return {
    user,
    favoritesPda,
    args: {
      number: 1337n,
      color: "indigo",
      hobbies: ["rust", "solana", "compilers"],
    },
  };
}

/**
 * Borsh string encoding: u32 LE length followed by UTF-8 bytes.
 * Anchor + Anvil both use borsh with identical wire format, so the
 * same encode call here produces the same ix data for both runs.
 */
function encodeBorshString(s: string): Uint8Array {
  const bytes = Buffer.from(s, "utf-8");
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length, true);
  return concatBytes(len, new Uint8Array(bytes));
}

function encodeBorshVecString(arr: string[]): Uint8Array {
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, arr.length, true);
  const parts: Uint8Array[] = [count];
  for (const s of arr) parts.push(encodeBorshString(s));
  return concatBytes(...parts);
}

export async function callSetFavorites(
  svm: LiteSVM,
  ctx: FavoritesCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.user.publicKey, BigInt(2_000_000_000));

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.user.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.favoritesPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("set_favorites"),
        encodeU64LE(ctx.args.number),
        encodeBorshString(ctx.args.color),
        encodeBorshVecString(ctx.args.hobbies),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.user.publicKey;
  tx.sign(ctx.user);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) throw new Error(`set_favorites tx failed: ${txFailureMessage(r)}`);
}
