/**
 * Shared fixture pieces for the `lever` program from
 * solana-developers/program-examples (basics/cross-program-invocation/anchor).
 *
 * The upstream example pairs `lever` with a sibling `hand` program; `hand`
 * CPI's into `lever`'s `switch_power` to toggle a shared PowerStatus account.
 * For byte-equal we test `lever` directly (no CPI caller needed) — the
 * `switch_power` ix is identical whether invoked top-level or via CPI, and
 * driving it directly avoids dragging the `hand` .so into the harness.
 *
 * Shape:
 *   - initialize(InitializeLever): init a fresh-keypair PowerStatus account
 *     (8 disc + 1 bool, padded by Anchor to 8+8 per the upstream `space`).
 *   - switch_power(SetPowerStatus, name: String): flips is_on, msg!'s the
 *     name and the new state.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 *
 * Single-file Anchor program: we readFileSync the upstream lib.rs raw.
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
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const REPO_PATH = "/tmp/program-examples";
export const LIB_RS =
  `${REPO_PATH}/basics/cross-program-invocation/anchor/programs/lever/src/lib.rs`;
// Upstream declare_id! — unique within the test suite (greppped, no
// collisions), so no rewrite needed.
export const PROGRAM_ID = "E64FVeubGC4NPNF2UBJYX4AkrVowf74fRJD9q6YhwstN";

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
      `[program-examples-cpi-lever-fixture] clone failed (status=${r.status}); fixtures will skip`,
    );
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Raw upstream lib.rs — declare_id! is already the canonical upstream
  // value and unique within the test suite.
  return readFileSync(LIB_RS, "utf-8");
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

export interface LeverCtx {
  payer: Keypair;
  power: Keypair;
  name: string;
}

export async function setupLever(): Promise<LeverCtx> {
  // PowerStatus is initialized via `#[account(init, payer = user, space = 8 + 8)]`
  // — no `seeds = [...]`, so it's a fresh-keypair account, not a PDA. Both
  // Anchor + Anvil scenarios share the keypair so post-flow state is byte-
  // comparable.
  const payer = Keypair.generate();
  const power = Keypair.generate();
  return { payer, power, name: "Chekov" };
}

export async function callLeverFlow(
  svm: LiteSVM,
  ctx: LeverCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // initialize: no args (discriminator-only ix data). Account order matches
  // the InitializeLever struct: power (init), user (signer, mut),
  // system_program.
  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.power.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDiscriminator("initialize")),
  });

  // switch_power(name: String): toggles power.is_on, msg!'s the name. The
  // SetPowerStatus accounts struct has just the mutable `power` account.
  const switchIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.power.publicKey, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("switch_power"),
        borshString(ctx.name),
      ),
    ),
  });

  // Init tx — payer + power both sign (power is the new-account signer).
  {
    const tx = new Transaction().add(initIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer, ctx.power);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`initialize tx failed: ${txFailureMessage(r)}`);
    }
  }

  // switch_power tx — payer only (power is no longer a signer post-init).
  {
    const tx = new Transaction().add(switchIx);
    tx.recentBlockhash = svm.latestBlockhash();
    tx.feePayer = ctx.payer.publicKey;
    tx.sign(ctx.payer);
    const r = svm.sendTransaction(tx);
    if (isTxFailure(r)) {
      throw new Error(`switch_power tx failed: ${txFailureMessage(r)}`);
    }
  }
}

export function leverAccountsToCompare(ctx: LeverCtx) {
  return [{ pubkey: ctx.power.publicKey, label: "power_status" }];
}
