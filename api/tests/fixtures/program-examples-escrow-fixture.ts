import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/escrow Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-escrow.test.ts — asserts byte-equal
 *     on the Offer PDA post-make_offer.
 *
 * The program (multi-file: lib.rs + constants.rs + error.rs +
 * instructions/{mod,make_offer,take_offer,shared}.rs + state/{mod,offer}.rs)
 * exercises the canonical "Anchor token escrow" pattern using the
 * token-interface family (Interface<TokenInterface> + InterfaceAccount<Mint
 * / TokenAccount>). We deliberately wire the scenario through the legacy
 * SPL Token program ID — that's what's in LiteSVM's default program set
 * via withDefaultPrograms() + withNativeMints(), and the Interface dispatch
 * routes to whichever program ID the instruction supplies at the
 * token_program account slot.
 *
 * Scenario: make_offer only.
 *   - Pre-create mintA (decimals=6), mintB (decimals=6), maker's ATA for
 *     mintA, mint 1_000_000 token A into maker's ATA.
 *   - Call make_offer(id=42, token_a_offered_amount=250_000,
 *     token_b_wanted_amount=500_000). Handler:
 *       (a) CPI transfer_checked moves 250_000 token A from maker ATA -> vault.
 *       (b) Init Offer PDA at seeds = [b"offer", maker, id_le] and writes
 *           {id, maker, mint_a, mint_b, token_b_wanted_amount, bump}.
 *
 * Why we compare only the Offer PDA:
 *   - The Offer is the sole #[account]-typed account the handler writes;
 *     its post-state is the authoritative byte signal of correct handler
 *     codegen (set_inner with bump from ctx.bumps.offer + Pubkey field
 *     ordering + u64 borsh layout).
 *   - The vault ATA is an SPL TokenAccount (no 8-byte Anchor discriminator).
 *     Mixing it into accountsToCompare under stripDiscriminator: true
 *     (the harness option is global per-fixture) would silently chop
 *     bytes 0-7 of the TokenAccount layout (mint pubkey high bytes).
 *     Mirror anchor-escrow-2025-fixture's narrow byte-equal pattern.
 *
 * Counts toward grant A1 (10+ byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import {
  setupMintAndAtaIxs,
  createMintIxs,
  sendSetupTx,
} from "../differential-setup-helpers.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../../src/parser/project-source.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync } from "node:fs";

export const REPO_PATH = join(TEST_SCRATCH, "program-examples");
export const CRATE_DIR =
  `${REPO_PATH}/tokens/escrow/anchor/programs/escrow`;
export const LIB_RS = `${CRATE_DIR}/src/lib.rs`;

// Upstream declare_id! verbatim — the reference Anchor build (via
// anchorReferenceCrateDir) uses the crate's own Cargo.toml + lib.rs as-is,
// so the deployed .so will only accept this ID. Anvil's emit deploys to
// the same ID for byte-equal parity.
export const PROGRAM_ID = "qbuMdeYxYJXBjU6C6qFKjZKjXmrU83eDQomHdrch826";

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Multi-file project: src/{lib,constants,error}.rs + src/instructions/{mod,
  // make_offer,take_offer,shared}.rs + src/state/{mod,offer}.rs. Flatten via
  // buildProjectSource so the Anvil parser sees a single source blob
  // (same path account-data + create-token use). The reference Anchor
  // build consumes the upstream crate directly via anchorReferenceCrateDir.
  const entry = getProjectEntryPath(LIB_RS);
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(entry, files);
}

export interface MakeOfferCtx {
  payer: Keypair;
  maker: Keypair;
  mintA: Keypair;
  mintB: Keypair;
  id: bigint;
  offerPda: PublicKey;
  makerAtaA: PublicKey;
  vaultAta: PublicKey;
}

export async function setupMakeOffer(): Promise<MakeOfferCtx> {
  const payer = Keypair.generate();
  const maker = Keypair.generate();
  const mintA = Keypair.generate();
  const mintB = Keypair.generate();
  const id = 42n;
  const programIdPk = new PublicKey(PROGRAM_ID);

  // Offer PDA seeds = [b"offer", maker.key().as_ref(), id.to_le_bytes()] —
  // 3 seeds (not 2 like anchor-escrow-2025). Maker is part of the seed
  // so multi-maker scenarios don't collide on the same id.
  const idLe = Buffer.alloc(8);
  idLe.writeBigUInt64LE(id);
  const [offerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("offer"), maker.publicKey.toBuffer(), idLe],
    programIdPk,
  );

  // ATAs derived under legacy SPL Token program ID — the runtime
  // dispatch in Interface<TokenInterface> uses whichever program ID we
  // pass at the token_program slot, and LiteSVM ships the legacy SPL
  // Token program preloaded via withDefaultPrograms().
  const makerAtaA = getAssociatedTokenAddressSync(
    mintA.publicKey,
    maker.publicKey,
  );
  // Vault ATA: authority = offer PDA (allowOwnerOffCurve = true).
  const vaultAta = getAssociatedTokenAddressSync(
    mintA.publicKey,
    offerPda,
    true,
  );

  return { payer, maker, mintA, mintB, id, offerPda, makerAtaA, vaultAta };
}

export async function callMakeOffer(
  svm: LiteSVM,
  ctx: MakeOfferCtx,
  programId: PublicKey,
): Promise<void> {
  // withDefaultPrograms() loads legacy SPL Token + ATA program; the
  // escrow's Interface<TokenInterface> dispatches via the token_program
  // account, so passing TOKEN_PROGRAM_ID at that slot routes correctly.
  svm.withDefaultPrograms().withNativeMints();
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
  svm.airdrop(ctx.maker.publicKey, BigInt(2_000_000_000));

  // Setup: mintA + makerAtaA (1_000_000 token A minted) + mintB.
  const setupTx = new Transaction()
    .add(
      ...setupMintAndAtaIxs(
        svm,
        ctx.payer.publicKey,
        ctx.mintA.publicKey,
        ctx.makerAtaA,
        ctx.maker.publicKey,
        6,
        1_000_000n,
      ),
    )
    .add(
      ...createMintIxs(
        svm,
        ctx.payer.publicKey,
        ctx.mintB.publicKey,
        6,
        ctx.payer.publicKey,
        ctx.payer.publicKey,
      ),
    );
  sendSetupTx(
    svm,
    setupTx,
    ctx.payer.publicKey,
    [ctx.payer, ctx.mintA, ctx.mintB],
    "escrow setup",
  );

  // Account list order MUST mirror the MakeOffer struct field declaration
  // order exactly (9 keys):
  //   1. maker                      (signer, writable — fee payer + offer rent)
  //   2. token_mint_a               (readonly)
  //   3. token_mint_b               (readonly)
  //   4. maker_token_account_a      (writable — debit source for vault transfer)
  //   5. offer                      (writable — init via PDA seeds)
  //   6. vault                      (writable — init ATA, authority = offer PDA)
  //   7. associated_token_program   (readonly)
  //   8. token_program              (readonly — Interface routes via this slot)
  //   9. system_program             (readonly)
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.maker.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mintA.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.mintB.publicKey, isSigner: false, isWritable: false },
      { pubkey: ctx.makerAtaA, isSigner: false, isWritable: true },
      { pubkey: ctx.offerPda, isSigner: false, isWritable: true },
      { pubkey: ctx.vaultAta, isSigner: false, isWritable: true },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // Args: u64 id + u64 token_a_offered_amount + u64 token_b_wanted_amount.
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("make_offer"),
        encodeU64LE(ctx.id),
        encodeU64LE(250_000n),
        encodeU64LE(500_000n),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.maker.publicKey;
  tx.sign(ctx.maker);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`make_offer failed: ${txFailureMessage(r)}`);
  }
}

export function makeOfferAccountsToCompare(ctx: MakeOfferCtx) {
  // Offer PDA is the only #[account]-typed account the handler writes —
  // its post-state is the authoritative byte signal. The vault ATA is an
  // SPL TokenAccount (no 8-byte Anchor discriminator) so mixing it in
  // under stripDiscriminator: true would silently chop the first 8 bytes
  // of the SPL Account layout. Compare offer only — same narrow pattern
  // anchor-escrow-2025 settled on for its byte-equal fixture.
  return [{ pubkey: ctx.offerPda, label: "offer_pda" }];
}
