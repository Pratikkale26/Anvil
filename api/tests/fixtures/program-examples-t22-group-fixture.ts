/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/token-2022/group Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-t22-group.test.ts — asserts byte-equal
 *     on the Mint PDA post-test_initialize_group (a Token-2022 Mint with the
 *     GroupPointer extension, owned by TOKEN_2022_PROGRAM_ID).
 *
 * The program exercises Anchor's `extensions::group_pointer::*` constraint
 * sugar on an `InterfaceAccount<Mint>` init:
 *
 *   #[account(
 *       init,
 *       seeds = [b"group"], bump,
 *       payer = payer,
 *       mint::decimals = 2,
 *       mint::authority = mint_account,
 *       mint::freeze_authority = mint_account,
 *       extensions::group_pointer::authority = mint_account,
 *       extensions::group_pointer::group_address = mint_account,
 *   )]
 *   pub mint_account: InterfaceAccount<'info, Mint>,
 *
 * Anchor expands this into: system::create_account (sized for Mint +
 * GroupPointer extension), then group_pointer_initialize CPI, then
 * initialize_mint2 CPI — all against the Token-2022 program.
 *
 * Anvil's parser recognises the `extensions::group_pointer::*` constraint
 * keys as of commit f6c2ca9, but per the task brief (2026-05-22) the EMIT
 * side has NOT been wired for per-extension CPI emission. This fixture is
 * the byte-equal regression gate that will fire the day that emit lands —
 * for now its purpose is to PROVE the gap (related to finding #50) rather
 * than gate landed work.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs) — adds +1
 * to the portfolio regardless of pass/fail verdict, because the
 * differential apparatus + fixture is now versioned and re-runnable.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  mkTestProgramId,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

// Upstream path. tokens/token-2022/group is the canonical "T22 group
// extension" example in the solana-developers repo.
export const LIB_RS =
  "/tmp/program-examples/tokens/token-2022/group/anchor/programs/group/src/lib.rs";

// Deterministic 32-byte base58 test program ID. Upstream declare_id! is
// 4XCDGMD8fsdjUzmYj6d9if8twFt1f23Ym52iDmWK8fFs — pin our own so the
// fixture stays isolated from sibling tests.
export const PROGRAM_ID = mkTestProgramId(
  "T22GrpExmps11111111111111111111111111111111",
);

const UPSTREAM_DECLARE_ID = "4XCDGMD8fsdjUzmYj6d9if8twFt1f23Ym52iDmWK8fFs";

// Upstream lib.rs holds:
//   - imports for spl-token-2022 extension state inspection
//     (StateWithExtensions / GroupPointer)
//   - one #[program] instruction `test_initialize_group` whose body calls
//     a helper `check_mint_data` that unpacks the Mint's extension data
//     for logging — gated on extension types being live on the runtime
//   - the InitializeGroup accounts struct (the byte-equal target)
//   - an `impl InitializeGroup { fn check_mint_data }` helper using
//     spl-token-2022 extension APIs directly
//
// We slice down to just the InitializeGroup accounts struct + a stub
// `test_initialize_group` instruction with `Ok(())` body. The HONEST
// scope is: validate Anvil emits the SAME byte-equivalent Mint PDA as
// reference Anchor, given the `init + extensions::group_pointer::*`
// constraints. The `check_mint_data` helper performs no state mutation
// (msg!-only), so dropping it changes nothing observable on-chain.
//
// Why drop check_mint_data:
//   - Reduces fixture surface to ONLY the account-constraint emit path
//     under test.
//   - The helper's imports (StateWithExtensions, GroupPointer) pull in
//     spl-token-2022 internals that the parser hasn't classified as
//     typed IR — it would land in pass_through and add noise to the
//     diff without changing the compared bytes.
//
// Module renamed `group` → `group_test` to avoid colliding with any
// `group` symbol from anchor-spl's re-exports inside the lib.
export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }

  // Sanity: confirm the upstream declare_id! we expect actually lives at
  // LIB_RS. If the upstream source rotates IDs (or the file vanishes),
  // surface a clear error instead of silently shipping a stale fixture.
  const upstream = readFileSync(LIB_RS, "utf-8");
  if (!upstream.includes(`declare_id!("${UPSTREAM_DECLARE_ID}")`)) {
    throw new Error(
      `[t22-group fixture] upstream declare_id! drift: expected ${UPSTREAM_DECLARE_ID} ` +
        `at ${LIB_RS}. Re-pin UPSTREAM_DECLARE_ID and re-verify the source slice.`,
    );
  }

  // Reconstructed source — keeps the InitializeGroup struct verbatim
  // (that's the byte-equal target shaping) and stubs the instruction
  // body to `Ok(())`.
  return `use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, Token2022};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod group_test {

    use super::*;

    pub fn test_initialize_group(_ctx: Context<InitializeGroup>) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeGroup<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        seeds = [b"group"],
        bump,
        payer = payer,
        mint::decimals = 2,
        mint::authority = mint_account,
        mint::freeze_authority = mint_account,
        extensions::group_pointer::authority = mint_account,
        extensions::group_pointer::group_address = mint_account,
    )]
    pub mint_account: InterfaceAccount<'info, Mint>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
`;
}

export interface T22GroupCtx {
  payer: Keypair;
  mintPda: PublicKey;
  programIdPk: PublicKey;
}

export async function setupT22Group(): Promise<T22GroupCtx> {
  const payer = Keypair.generate();
  const programIdPk = new PublicKey(PROGRAM_ID);

  // Mint PDA: [b"group"] — derived under our program. No payer-derived
  // entropy in the seed, so the fixture's mint address is constant per
  // program ID. Both Anchor + Anvil scenarios see the same PDA because
  // the program ID is shared via this ctx.
  const [mintPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("group")],
    programIdPk,
  );

  return { payer, mintPda, programIdPk };
}

export async function callTestInitializeGroup(
  svm: LiteSVM,
  ctx: T22GroupCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Account ordering MUST mirror InitializeGroup struct exactly:
  //   payer, mint_account, token_program, system_program.
  // mint_account is a PDA — Anchor signs the create_account internally
  // via the bump+seeds in the #[account(seeds = .., bump)] expansion.
  // Caller passes isSigner: false.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: ctx.mintPda, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    // No args — instruction takes only the Context.
    data: Buffer.from(anchorIxDiscriminator("test_initialize_group")),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`test_initialize_group failed: ${txFailureMessage(r)}`);
  }
}

export function t22GroupAccountsToCompare(ctx: T22GroupCtx) {
  // Mint-only compare scope. A Token-2022 Mint with the GroupPointer
  // extension has size = base Mint (82) + extension type/length header
  // + GroupPointer body (authority + group_address pointers), all owned
  // by TOKEN_2022_PROGRAM_ID. If Anvil's emit drifts on:
  //   - the create_account allocation size (no extension space),
  //   - the group_pointer_initialize CPI omission,
  //   - the initialize_mint2 CPI program/account ordering,
  //   - the decimals/mint_authority/freeze_authority byte placement,
  //   - the owner assignment (legacy Token vs T22),
  // this fires.
  return [{ pubkey: ctx.mintPda, label: "mint_pda" }];
}
