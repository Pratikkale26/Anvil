import { TEST_SCRATCH } from "../scratch-root.ts";
import { join } from "node:path";
/**
 * Shared fixture pieces for solana-developers/program-examples'
 * tokens/token-2022/basics Anchor program.
 *
 * Re-used by:
 *   - differential-program-examples-t22-basics.test.ts — asserts byte-equal
 *     on the mint PDA post-create_token (a Token-2022 Mint with no
 *     extensions, owned by TOKEN_2022_PROGRAM_ID).
 *
 * The program exercises:
 *   - Interface<'info, TokenInterface> + InterfaceAccount<'info, Mint> —
 *     caller picks Token vs Token-2022 via the token_program key. We pass
 *     TOKEN_2022_PROGRAM_ID, so the create_account + initialize_mint CPI
 *     pair runs against the T22 program. This validates Anvil's T22 IR
 *     end-to-end at the byte level.
 *   - #[account(init, mint::decimals, mint::authority, seeds, bump)] — the
 *     mint is a PDA; Anchor's expansion derives the address and signs the
 *     system::create_account internally via signer_seeds (no extra signer
 *     keypair on the tx).
 *
 * Target instruction: `create_token(_token_name: String)`. Args are unused
 * in the handler body but bind the seed (`token_name.as_bytes()`) — must be
 * passed in both the seed-derivation and the borsh-encoded ix data, and
 * the bytes MUST match.
 *
 * Counts toward grant A1 (byte-equal external Anchor programs).
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { isTxFailure, txFailureMessage } from "../litesvm-tx-error.ts";
import { existsSync, readFileSync } from "node:fs";

// Upstream path. tokens/token-2022/basics is the canonical "T22 first
// program" example in the solana-developers repo.
export const LIB_RS =
  join(TEST_SCRATCH, "program-examples", "tokens/token-2022/basics/anchor/programs/basics/src/lib.rs");

// Deterministic test program ID. Upstream declare_id! is
// 6qNqxkRF791FXFeQwqYQLEzAbGiqDULC5SSHVsfRoG89 — pin our own so the fixture
// stays isolated from any other test that might reuse the upstream ID.
// Base58 alphabet excludes 0/O/I/l.
export const PROGRAM_ID = "T22BscsExmps1111111111111111111111111111111";

const UPSTREAM_DECLARE_ID = "6qNqxkRF791FXFeQwqYQLEzAbGiqDULC5SSHVsfRoG89";

// The upstream program defines five instructions: create_token,
// create_token_account, create_associated_token_account, transfer_token,
// mint_token. We byte-equal target the FIRST one (the Mint PDA post-init);
// the sibling instructions are dropped from the source we hand to BOTH
// the reference Anchor build AND the Anvil emit:
//
//   - Honest scope. Comparing one instruction's output is a sharper
//     correctness claim than including instructions we don't exercise.
//   - The transfer_token + mint_token sources reference accounts named
//     `receiver`/`signer`/`from`/`to_ata` whose Anvil CPI emit currently
//     hits an account-name resolution edge in the spl-token-2022
//     transfer_checked/mint_to families. Including them would either
//     mask that emit bug behind a different test or block this fixture
//     on an unrelated emitter change. Out of scope per the task brief
//     (do NOT modify the emitter).
//
// We slice down to the lib.rs header (use + declare_id! + #[program]
// module containing only create_token + super::*) and the CreateToken
// accounts struct. This is the same approach the broader corpus takes
// when an external program has scope wider than the byte-equal target.
//
// Module renamed `anchor` → `basics` because the upstream module name
// `anchor` collides with the anchor_lang crate path inside the lib.
export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) {
    return "// MISSING: program-examples not cloned. Differential will skip.";
  }
  // Reconstruct a minimal source containing only the create_token
  // instruction + the CreateToken accounts struct. Field-shape pulled
  // verbatim from upstream so the byte layout / discriminator / seed
  // bytes match what a developer building this program would actually
  // get from the official examples repo.
  const src = `use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod basics {

    use super::*;

    pub fn create_token(_ctx: Context<CreateToken>, _token_name: String) -> Result<()> {
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(token_name: String)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(
        init,
        payer = signer,
        mint::decimals = 6,
        mint::authority = signer.key(),
        seeds = [b"token-2022-token", signer.key().as_ref(), token_name.as_bytes()],
        bump,
    )]
    pub mint: InterfaceAccount<'info, Mint>,
    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}
`;

  // Sanity: confirm the upstream declare_id! we expect actually lives at
  // LIB_RS. If the upstream source rotates IDs (or the file vanishes),
  // surface a clear error instead of silently shipping a stale fixture.
  const upstream = readFileSync(LIB_RS, "utf-8");
  if (!upstream.includes(`declare_id!("${UPSTREAM_DECLARE_ID}")`)) {
    throw new Error(
      `[t22-basics fixture] upstream declare_id! drift: expected ${UPSTREAM_DECLARE_ID} ` +
        `at ${LIB_RS}. Re-pin UPSTREAM_DECLARE_ID and re-verify the source slice.`,
    );
  }

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

export interface T22BasicsCtx {
  payer: Keypair;
  mintPda: PublicKey;
  tokenName: string;
  programIdPk: PublicKey;
}

export async function setupT22Basics(): Promise<T22BasicsCtx> {
  const payer = Keypair.generate();
  const tokenName = "AnvilT22";
  const programIdPk = new PublicKey(PROGRAM_ID);

  // Mint PDA: ["token-2022-token", payer, token_name] — derived under our
  // program. Both Anchor + Anvil scenarios see the same PDA because the
  // payer keypair + token name are shared via this ctx. The bump is
  // re-derived inside the program at handler time; not threaded here.
  const [mintPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("token-2022-token"),
      payer.publicKey.toBuffer(),
      Buffer.from(tokenName),
    ],
    programIdPk,
  );

  return {
    payer,
    mintPda,
    tokenName,
    programIdPk,
  };
}

export async function callCreateToken(
  svm: LiteSVM,
  ctx: T22BasicsCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Account ordering MUST mirror CreateToken struct exactly:
  //   signer, mint, system_program, token_program.
  // token_program = TOKEN_2022_PROGRAM_ID — this is the call that routes
  // the init through the Token-2022 program, which is the whole point of
  // this fixture: validate Anvil's T22 IR vs the real T22 runtime.
  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      // Mint is a PDA — Anchor signs the create_account internally via
      // the bump+seeds in the #[account(seeds = .., bump)] expansion.
      // Caller passes isSigner: false.
      { pubkey: ctx.mintPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    // Args: borsh String token_name. Bytes MUST match the seed exactly so
    // Anchor's PDA-derivation inside the handler resolves to the same
    // address we passed in keys[1].
    data: Buffer.from(
      concatBytes(
        anchorIxDiscriminator("create_token"),
        borshString(ctx.tokenName),
      ),
    ),
  });

  const tx = new Transaction().add(ix);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer);
  const r = svm.sendTransaction(tx);
  if (isTxFailure(r)) {
    throw new Error(`create_token failed: ${txFailureMessage(r)}`);
  }
}

export function t22BasicsAccountsToCompare(ctx: T22BasicsCtx) {
  // Mint-only compare scope. A Token-2022 Mint with no extensions is
  // 82 bytes (legacy Mint layout) owned by TOKEN_2022_PROGRAM_ID. If
  // Anvil's emit drifts on:
  //   - the create_account allocation size,
  //   - the initialize_mint CPI program/account ordering,
  //   - the decimals/mint_authority byte placement,
  //   - the owner assignment (legacy Token vs T22),
  // this fires.
  return [{ pubkey: ctx.mintPda, label: "mint_pda" }];
}
