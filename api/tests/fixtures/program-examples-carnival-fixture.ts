/**
 * Shared fixture pieces for the `carnival` program from
 * solana-developers/program-examples
 * (basics/repository-layout/anchor/programs/carnival).
 *
 * Externally-authored multi-file Anchor program with active byte-equal
 * coverage. Counts toward grant A1 (10+ byte-equal external Anchor
 * programs).
 *
 * What the program does:
 *   Three handler entry points (`go_on_ride`, `play_game`, `eat_food`),
 *   each delegating to a sibling-module helper fn whose body iterates a
 *   `Vec<T>` of in-memory "objects" (food stands / games / rides) and
 *   emits msg!() lines. Returns Ok(()) on match, Err(InvalidInstruction-
 *   Data) on no-match. CarnivalContext has a single `payer: Signer`
 *   field — the handlers never mutate any account.
 *
 * Why it's a meaningful multi-file byte-equal target:
 *   - Exercises Anvil's project-source flattener (`buildProjectSource`)
 *     on a `pub mod instructions; pub mod state;` layout with two levels
 *     of sub-modules (`instructions/{eat_food,play_game,get_on_ride}.rs`,
 *     `state/{food,game,ride}.rs`), plus an empty `pub mod error;`. The
 *     handler bodies call into those sub-modules via path syntax
 *     (`eat_food::eat_food(EatFoodInstructionData { … })`) — a shape the
 *     emit must preserve module-wise after flattening.
 *   - `CarnivalContext<'info>` has exactly one declared account. The
 *     emit must NOT silently walk the wire-supplied account list and
 *     mutate / reassign / close anything beyond that single payer. We
 *     pass a pre-seeded program-owned witness account as a
 *     remaining-account; both Anchor and Anvil runs must leave it
 *     byte-identical post-ix.
 *
 * Why not compareMsgLogs:
 *   eat_food contains `msg!("Welcome to {}!", food_stand.name)` and
 *   similar — Anvil's M7 8c formatted-msg expansion only resolves
 *   instruction args / ctx.bumps.X / numeric literals. A struct-field
 *   access through a Vec<FoodStand> iterator doesn't match any of
 *   those, so the emit falls through to the legacy literal collapse
 *   (no substitution) while Anchor's runtime format!() prints the
 *   actual stand name. compareMsgLogs would diverge by design — same
 *   class as hello-solana's `&id()` case.
 *
 * Multi-file Anchor project: we feed the flattened blob to the reference
 * Anchor build (the harness writes it to scratch/src/lib.rs), and Anvil's
 * emit consumes the same blob. The declare_id! is swapped to our
 * deterministic test ID so account ownership lines up with the deployed
 * .so.
 */
import {
  Transaction,
  TransactionInstruction,
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
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync } from "node:fs";

export const LIB_RS =
  "/tmp/program-examples/basics/repository-layout/anchor/programs/carnival/src/lib.rs";

// Deterministic test program ID. Upstream declare_id! is
// 8t94SEJh9jVjDwV7cbiuT6BvEsHo4YHP9x9a5rYH1NpP — sub our own to keep the
// fixture isolated from any other test that might reuse the upstream ID.
// Base58 alphabet excludes 0/O/I/l.
export const PROGRAM_ID = "CarnVaLExtDifExmps11111111111111111111111111";

const UPSTREAM_DECLARE_ID = "8t94SEJh9jVjDwV7cbiuT6BvEsHo4YHP9x9a5rYH1NpP";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file project: instructions/{mod,eat_food,play_game,get_on_ride}.rs +
  // state/{mod,food,game,ride}.rs + error.rs. Flatten through the same
  // path Anvil's parser is calibrated against.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  let src = buildProjectSource(entry, files);

  // Replace declare_id! with our deterministic test ID so the on-chain
  // program ID matches what the LiteSVM scenario expects. No CpiContext
  // sites in this program, so no .key()/.to_account_info() rewrite needed.
  src = src.replace(
    `declare_id!("${UPSTREAM_DECLARE_ID}");`,
    `declare_id!("${PROGRAM_ID}");`,
  );

  // ─── Flattener partial-collapse paper-overs ───────────────────────────
  // `buildProjectSource` renames the helper-fn callsite to avoid the
  // collision between an `instructions/eat_food.rs::pub fn eat_food`
  // and the `#[program] pub fn eat_food` ix handler (rewrites the call
  // to `eat_food_eat_food(...)`), but does NOT rewrite the
  // struct-literal path arg (`eat_food::EatFoodInstructionData { … }`)
  // nor the sibling `food::get_food_stands` / `game::get_games` /
  // `ride::get_rides` calls inside those helpers. After flattening
  // those modules no longer exist as paths, so the reference Anchor
  // build fails to resolve them.
  //
  // Anvil's downstream emit collapses these paths itself
  // (the G83 module-path collapse), so the Anvil side is unaffected
  // by the upstream stale paths. We pre-apply the same collapse here
  // purely to make the reference Anchor build cargo-green; the Anvil
  // emit consumes the post-collapse blob identically.
  //
  // This is a latent flattener bug worth surfacing if anyone is
  // looking — the rename should be either complete (struct paths +
  // sibling-mod calls) or absent (let the post-flatten path collapser
  // own it end-to-end).
  src = src.replace(
    "eat_food::EatFoodInstructionData",
    "EatFoodInstructionData",
  );
  src = src.replace(
    "play_game::PlayGameInstructionData",
    "PlayGameInstructionData",
  );
  src = src.replace(
    "get_on_ride::GetOnRideInstructionData",
    "GetOnRideInstructionData",
  );
  src = src.replace(/food::get_food_stands/g, "get_food_stands");
  src = src.replace(/game::get_games/g, "get_games");
  src = src.replace(/ride::get_rides/g, "get_rides");
  return src;
}

// Borsh String encoding: u32 LE length + UTF-8 bytes.
function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

// u32 little-endian. The shared harness exports encodeU64LE but not u32.
function encodeU32LE(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

export interface CarnivalCtx {
  payer: Keypair;
  // Pre-seeded program-owned witness account passed as a remaining-account
  // in the tx. The eat_food handler never references it
  // (CarnivalContext has only `payer`), so both runs must leave it
  // byte-identical post-ix.
  witness: PublicKey;
  // Distinctive non-zero payload pre-seeded into the witness — any drift
  // (zeroing, truncation, reassignment) would diff loudly. Different
  // formula than hello-solana / checking-accounts to avoid any
  // cross-fixture coincidence.
  witnessPayload: Uint8Array;
  // Instruction args. "Larry's Pizza" requires >= 3 tickets per
  // state/food.rs; supplying 5 hits the "Enjoy your pizza!" success
  // branch on both runs. Any name not in get_food_stands() falls through
  // the loop into Err(InvalidInstructionData) — both sides would fail
  // identically and the test would look byte-equal but actually broken.
  eaterName: string;
  eaterTicketCount: number;
  foodStandName: string;
}

export async function setupCarnival(): Promise<CarnivalCtx> {
  const payer = Keypair.generate();
  const witness = Keypair.generate().publicKey;
  // 32 bytes of recognizable pattern (different formula than
  // hello-solana / checking-accounts to avoid any cross-fixture
  // coincidence).
  const witnessPayload = new Uint8Array(32);
  for (let i = 0; i < witnessPayload.length; i++) {
    witnessPayload[i] = (i * 13 + 71) & 0xff;
  }
  return {
    payer,
    witness,
    witnessPayload,
    eaterName: "Anvil",
    eaterTicketCount: 5,
    foodStandName: "Larry's Pizza",
  };
}

export async function callEatFood(
  svm: LiteSVM,
  ctx: CarnivalCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // Pre-seed the witness as program-owned with the deterministic
  // payload. Done inside callScript so both Anchor and Anvil scenarios
  // see the identical pre-state.
  svm.setAccount(ctx.witness, {
    lamports: 1_000_000,
    data: ctx.witnessPayload,
    owner: programId,
    executable: false,
    rentEpoch: 0n,
  });

  // CarnivalContext has a single declared account (payer, mut signer).
  // Witness goes on the wire as a remaining-account — Anchor binds it
  // into ctx.remaining_accounts; the handler never references it.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.witness, isSigner: false, isWritable: true },
    ],
    // Args: borsh String name + u32 LE ticket_count + borsh String
    // food_stand_name. Order matches the handler signature.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("eat_food"),
        borshString(ctx.eaterName),
        encodeU32LE(ctx.eaterTicketCount),
        borshString(ctx.foodStandName),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`eat_food tx failed: ${txFailureMessage(r)}`);
  }
}

export function carnivalAccountsToCompare(ctx: CarnivalCtx) {
  // witness pre-seeded with witnessPayload and program-owned — both runs
  // must leave it byte-identical (data + lamports + owner) since the
  // handler body is a pure msg!() walk + Ok(()) and CarnivalContext
  // declares only the payer.
  return [{ pubkey: ctx.witness, label: "witness" }];
}
