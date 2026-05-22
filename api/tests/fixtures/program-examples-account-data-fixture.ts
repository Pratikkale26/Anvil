/**
 * Shared fixture pieces for solana-developers/program-examples'
 * basics/account-data Anchor program.
 *
 * Externally-authored multi-file Anchor program with active byte-equal
 * coverage. Counts toward grant A1 (10+ byte-equal external Anchor
 * programs).
 *
 * What the program does:
 *   Single instruction `create_address_info(ctx, name, house_number, street,
 *   city)` initialises a new fresh-keypair `address_info: Account<'info,
 *   AddressInfo>` with `space = ANCHOR_DISCRIMINATOR_SIZE +
 *   AddressInfo::INIT_SPACE` (8 + 163 = 171 bytes) and writes the four
 *   fields via the deref-set pattern (`*ctx.accounts.address_info =
 *   AddressInfo { name, house_number, street, city }`).
 *
 * Why a meaningful byte-equal target:
 *   - Exercises Anvil's project-source flattener (`buildProjectSource`)
 *     on a `pub mod constants; pub mod instructions; pub mod state;`
 *     layout — the `space = ANCHOR_DISCRIMINATOR_SIZE + INIT_SPACE`
 *     constraint depends on a cross-module const lookup AND on
 *     `#[derive(InitSpace)]` macro expansion. Either lookup failing
 *     would break the size-allocation byte parity.
 *   - The `*ctx.accounts.address_info = AddressInfo { ... }` deref-set
 *     pattern must serialize the borsh payload into the underlying
 *     data buffer identically to Anchor's expanded code. Any drift in
 *     the borsh order (4 fields with two layouts: u32-len-prefixed
 *     String + u8) is caught by the post-state byte compare.
 *
 * Multi-file Anchor project: we flatten via `buildProjectSource` so the
 * Anvil parser sees a single blob, while the reference Anchor build
 * uses `anchorReferenceCrateDir` to consume the upstream crate verbatim
 * (which preserves the Anchor 1.0.0-rc.5 dep + workspace structure).
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
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

export const REPO_PATH = "/tmp/program-examples";
export const CRATE_DIR =
  `${REPO_PATH}/basics/account-data/anchor/programs/anchor-program-example`;
export const LIB_RS = `${CRATE_DIR}/src/lib.rs`;

// Use the upstream-declared program ID verbatim. Both the reference Anchor
// build (via anchorReferenceCrateDir — builds upstream crate as-is) and
// the Anvil-emitted .so must match this ID. Matches the coral-idl-docs
// pattern (anchorReferenceCrateDir + upstream declare_id! verbatim).
export const PROGRAM_ID = "GpVcgWdgVErgLqsn8VYUch6EqDerMgNqoLSmGyKrd6MR";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file project: src/{lib,constants}.rs + src/instructions/{mod,
  // create}.rs + src/state/{mod,address_info}.rs. Flatten through the same
  // path Anvil's parser is calibrated against so const lookups
  // (ANCHOR_DISCRIMINATOR_SIZE) and InitSpace expansion (AddressInfo)
  // resolve before the parser sees them.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
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

export interface AccountDataCtx {
  payer: Keypair;
  // The address_info account is initialised by the handler; both Anchor
  // and Anvil scenarios share the same keypair so post-scenario account
  // state is byte-comparable.
  addressInfo: Keypair;
  // Deterministic inputs — short ASCII strings keep the borsh prefix
  // small while leaving the rest of the 163-byte INIT_SPACE allocation
  // as create_account zeros. Both runs must produce identical trailing
  // zero padding because neither writes past the borsh payload.
  name: string;
  houseNumber: number;
  street: string;
  city: string;
}

export async function setupAccountData(): Promise<AccountDataCtx> {
  const payer = Keypair.generate();
  const addressInfo = Keypair.generate();
  return {
    payer,
    addressInfo,
    name: "Anvil",
    houseNumber: 42,
    street: "Solana Street",
    city: "Devnet City",
  };
}

export async function callCreateAddressInfo(
  svm: LiteSVM,
  ctx: AccountDataCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

  // CreateAddressInfo accounts struct order:
  //   payer (mut signer), address_info (init, mut signer — new keypair),
  //   system_program.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.addressInfo.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // Args: borsh String name + u8 house_number + borsh String street +
    // borsh String city. Order matches the handler signature.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("create_address_info"),
        borshString(ctx.name),
        new Uint8Array([ctx.houseNumber]),
        borshString(ctx.street),
        borshString(ctx.city),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  // Both payer (rent + tx fee) and the new address_info account
  // (system::create_account requires the new account to sign) must sign.
  tx.sign(ctx.payer, ctx.addressInfo);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_address_info failed: ${txFailureMessage(r)}`);
  }
}

export function accountDataAccountsToCompare(ctx: AccountDataCtx) {
  // The address_info account is the only state mutated by the handler.
  // Anchor's #[account] derive writes the 8-byte discriminator at offset 0,
  // then the borsh payload (name + house_number + street + city). The
  // harness strips the discriminator by default; the compared bytes are
  // the borsh payload followed by create_account zero-padding up to
  // INIT_SPACE (163 bytes).
  return [{ pubkey: ctx.addressInfo.publicKey, label: "address_info" }];
}
