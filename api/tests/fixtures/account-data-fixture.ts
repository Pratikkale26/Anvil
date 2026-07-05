import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for the `account-data` Anchor program from
 * solana-developers/program-examples (basics/account-data).
 *
 * Externally-authored Anchor program — RW4. Three String fields with
 * `#[max_len(50)]` make this the densest exercise of the max_len fix
 * landed in 4f33bdf: AddressInfo's INIT_SPACE = 4+50 + 1 + 4+50 +
 * 4+50 = 163 bytes. Without the fix, Anvil would have allocated only
 * 64+1+64+64 = 193 bytes via the legacy String=64 default — wrong by
 * 30 bytes per direction. The byte-equal gate now proves Anchor and
 * Anvil produce the same on-chain layout.
 *
 * Multi-file project (constants.rs + state/address_info.rs +
 * instructions/create.rs) — uses project-source helpers to flatten
 * for Anvil's parser; the Anchor reference build runs against the
 * upstream crate verbatim via anchorReferenceCrateDir.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
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
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";

export const LIB_RS =
  join(TEST_SCRATCH, "program-examples", "basics/account-data/anchor/programs/anchor-program-example/src/lib.rs");
export const CRATE_DIR =
  join(TEST_SCRATCH, "program-examples", "basics/account-data/anchor/programs/anchor-program-example");
export const PROGRAM_ID = "GpVcgWdgVErgLqsn8VYUch6EqDerMgNqoLSmGyKrd6MR";

export function isAvailable(): boolean {
  if (existsSync(LIB_RS)) return true;
  console.warn(
    `[account-data-fixture] /tmp/program-examples missing; run a test that triggers ` +
      `the realworld-cargo auto-clone first (e.g. bun test tests/realworld-cargo.test.ts).`,
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

export interface AccountDataCtx {
  payer: Keypair;
  /**
   * The address_info account is a fresh keypair (not a PDA) — Anchor's
   * `init` constraint without `seeds` allocates a new account at the
   * caller-supplied pubkey. Both runs use the SAME keypair so the on-
   * chain pubkey is identical, which is what byte-equal compares.
   */
  addressInfo: Keypair;
  args: { name: string; houseNumber: number; street: string; city: string };
}

export async function setupAccountData(): Promise<AccountDataCtx> {
  const payer = Keypair.generate();
  const addressInfo = Keypair.generate();
  return {
    payer,
    addressInfo,
    args: {
      name: "Alice",
      houseNumber: 42,
      street: "Main Street",
      city: "Solana Beach",
    },
  };
}

function encodeBorshString(s: string): Uint8Array {
  const bytes = Buffer.from(s, "utf-8");
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, bytes.length, true);
  return concatBytes(len, new Uint8Array(bytes));
}

export async function callCreateAddressInfo(
  svm: LiteSVM,
  ctx: AccountDataCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.addressInfo.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("create_address_info"),
        encodeBorshString(ctx.args.name),
        new Uint8Array([ctx.args.houseNumber]),
        encodeBorshString(ctx.args.street),
        encodeBorshString(ctx.args.city),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // Both signers — addressInfo signs because it's the new account being
  // allocated by system_program::create_account inside Anchor's init.
  tx.sign(ctx.payer, ctx.addressInfo);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) throw new Error(`create_address_info tx failed: ${txFailureMessage(r)}`);
}
