/**
 * PDA signer seed reads a FIELD of a DIFFERENT account than the bump owner
 * (hard-sweep F6, #24). The PDA `pool` is derived from `config.authority`
 * (another account's stored field); the signed CPI must reproduce that seed.
 *
 * Pinocchio HEAD silently rewrote the seed `config.authority` to the bump
 * owner's own field `pool.authority` (a single shared state var for the whole
 * seed list). When pool.authority != config.authority that derives the WRONG
 * PDA, so invoke_signed grants no signature and the transfer reverts —
 * Anchor-correct code, silently broken on Pinocchio. Native was always correct
 * (bare Account<T> names deref to the struct).
 *
 * TEETH: config.authority = K (the real seed), pool.authority = J != K (the
 * field the bug reads). The CPI transfer is authorized by the pool PDA.
 *   - Anchor / fixed-Anvil: seed reads config.authority = K -> derives pool ->
 *     valid signer -> transfer succeeds.
 *   - Pinocchio HEAD: seed reads pool.authority = J -> derives [b"pool", J] !=
 *     pool -> invoke_signed fails -> transfer reverts.
 * So on HEAD the Pinocchio fixture diverges (tx outcome ok->revert AND the
 * pool_ta / dest balances), and the fix makes it match Anchor. Native passes
 * on HEAD and on the fix (regression guard for the byte-identical path).
 */
import { createHash } from "node:crypto";
import {
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";
import {
  createMintIxs,
  createTokenAccountIxs,
  mintToIx,
  sendSetupTx,
} from "./differential-setup-helpers.ts";

const PROGRAM_ID = "5hssFGGQ65fCNfGvNdoZLvaZfFCoUmNjGERq2cn7BmBh";

const SRC = `use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod pda_seed_cross_account {
    use super::*;
    pub fn pay(ctx: Context<Pay>, amount: u64) -> Result<()> {
        let seeds = &[
            b"pool".as_ref(),
            ctx.accounts.config.authority.as_ref(),
            &[ctx.bumps.pool],
        ];
        let signer = &[&seeds[..]];
        let cpi_accounts = Transfer {
            from: ctx.accounts.pool_ta.to_account_info(),
            to: ctx.accounts.dest.to_account_info(),
            authority: ctx.accounts.pool.to_account_info(),
        };
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::transfer(cpi_ctx, amount)?;
        Ok(())
    }
}

#[account]
pub struct Config { pub authority: Pubkey, pub fee: u64 }

#[account]
pub struct Pool { pub authority: Pubkey, pub total: u64 }

#[derive(Accounts)]
pub struct Pay<'info> {
    pub config: Account<'info, Config>,
    #[account(seeds = [b"pool", config.authority.as_ref()], bump)]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub pool_ta: Account<'info, TokenAccount>,
    #[account(mut)]
    pub dest: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
`;

// Anchor account discriminator = sha256("account:<Name>")[..8].
function acctDisc(name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`account:${name}`).digest()).slice(0, 8);
}

function defineFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SRC,
    anchorPackageName: anvilTarget === "native"
      ? "pda_seed_cross_account_native_diff"
      : "pda_seed_cross_account_anchor_diff",
    anchorExtraDeps: `anchor-spl = "0.31"`,
    compareTxOutcomes: true,

    setup: async () => {
      const programId = new PublicKey(PROGRAM_ID);
      const configAuthority = Keypair.generate();          // K — the real seed
      const poolStoredAuthority = Keypair.generate();      // J — pool.authority (!= K)
      const [poolPda, poolBump] = PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), configAuthority.publicKey.toBuffer()],
        programId,
      );
      return {
        payer: Keypair.generate(),
        configAuthority,
        poolStoredAuthority,
        config: Keypair.generate(),
        poolPda,
        poolBump,
        mint: Keypair.generate(),
        poolTa: Keypair.generate(),
        dest: Keypair.generate(),
      };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.withDefaultPrograms().withNativeMints();
      svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

      // config: Account<Config> { authority = K, fee = 0 } owned by program.
      svm.setAccount(ctx.config.publicKey, {
        lamports: 10_000_000,
        data: Buffer.from(concatBytes(acctDisc("Config"), ctx.configAuthority.publicKey.toBytes(), encodeU64LE(0n))),
        owner: programId,
        executable: false,
      });
      // pool: Account<Pool> { authority = J (!= K), total = 0 } at the PDA,
      // owned by program. The stored authority is the field the bug misreads.
      svm.setAccount(ctx.poolPda, {
        lamports: 10_000_000,
        data: Buffer.from(concatBytes(acctDisc("Pool"), ctx.poolStoredAuthority.publicKey.toBytes(), encodeU64LE(0n))),
        owner: programId,
        executable: false,
      });

      // mint (6 dec), pool_ta owned by the pool PDA (so pool is its authority),
      // dest owned by the payer. Fund pool_ta.
      const setupTx = new Transaction()
        .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.payer.publicKey, ctx.payer.publicKey))
        .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.poolTa.publicKey, ctx.mint.publicKey, ctx.poolPda))
        .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.dest.publicKey, ctx.mint.publicKey, ctx.payer.publicKey))
        .add(mintToIx(ctx.mint.publicKey, ctx.poolTa.publicKey, ctx.payer.publicKey, 1_000_000n));
      sendSetupTx(svm, setupTx, ctx.payer.publicKey,
        [ctx.payer, ctx.mint, ctx.poolTa, ctx.dest],
        "setup");

      // pay(250_000): transfer pool_ta -> dest, signed by the pool PDA.
      // Account order matches Pay: config, pool, pool_ta, dest, token_program.
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.config.publicKey, isSigner: false, isWritable: false },
          { pubkey: ctx.poolPda, isSigner: false, isWritable: false },
          { pubkey: ctx.poolTa.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.dest.publicKey, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("pay"), encodeU64LE(250_000n))),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer);
      svm.sendTransaction(tx); // tolerate failure — HEAD-Pinocchio is expected to revert
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [
      { pubkey: ctx.poolTa.publicKey, label: "pool_ta" },
      { pubkey: ctx.dest.publicKey, label: "dest" },
    ],
  });
}

defineFixture("pda-seed-cross-account-field");
defineFixture("pda-seed-cross-account-field-native", "native");
