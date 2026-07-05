/**
 * #2 / S4 #10 — declare_program! CPI signed by a PDA via invoke_signed,
 * BYTE-EQUAL gated. The caller CPIs vault_program::withdraw using
 * CpiContext::new_with_signer with its own PDA (seeds [b"vault"]) as the signer.
 * The callee enforces `vault_authority: Signer`, so the signer seeds are
 * LOAD-BEARING — a dropped/mangled seed makes the callee's signer check fail
 * and the tx reverts (≠ Anchor), which the differential catches.
 *
 * The seeds-prep uses the same scalar-bump + inline `&[bump]` form the SPL-CPI-
 * with-signer demos (escrow/vesting) already emit byte-equal; the rewrite
 * captures the 3rd new_with_signer arg as the invoke_signed signer seeds.
 *
 * Self-contained: caller source + IDL committed/embedded, vault_program.so the
 * committed callee. Skips (loud) without the SBF toolchain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_SCRATCH } from "./scratch-root.ts";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const VAULT_ID = "8Qywaw98v25g5sBQbyUU1jdxoCTnqpTPW9PFKUGWsPy5";
const CALLER_ID = "6t8yEDJXoQ47Q6tTjxLG1HWmTgoTT76qMLdfbRMGTpVE";

const CALLER_SRC = `use anchor_lang::prelude::*;
declare_id!("${CALLER_ID}");
declare_program!(vault_program);
use vault_program::program::VaultProgram;
#[program]
pub mod vault_caller {
    use super::*;
    pub fn proxy_withdraw(ctx: Context<ProxyWithdraw>, amount: u64) -> Result<()> {
        let bump = ctx.bumps.vault_authority;
        let seeds: &[&[u8]] = &[b"vault", &[bump]];
        let signer_seeds: &[&[&[u8]]] = &[seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.vault_program.key(),
            vault_program::cpi::accounts::Withdraw {
                vault_authority: ctx.accounts.vault_authority.to_account_info(),
                vault_state: ctx.accounts.vault_state.to_account_info(),
            },
            signer_seeds,
        );
        vault_program::cpi::withdraw(cpi_ctx, amount)?;
        Ok(())
    }
}
#[derive(Accounts)]
pub struct ProxyWithdraw<'info> {
    /// CHECK: PDA authority that signs the CPI via invoke_signed
    #[account(seeds = [b"vault"], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub vault_state: Account<'info, vault_program::accounts::VaultState>,
    pub vault_program: Program<'info, VaultProgram>,
}
`;

const CALLER_CARGO = `[package]
name = "vault_caller"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "vault_caller"
[features]
no-entrypoint = []
default = []
[dependencies]
anchor-lang = "1.0.0"
[profile.release]
overflow-checks = true
`;

const idl = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "vault-program-idl.json"), "utf-8"));
const calleePresent = existsSync(join(import.meta.dir, "fixtures", "programs", "vault_program.so"));

function prepareCallerCrate(): string {
  const dir = join(TEST_SCRATCH, "anvil-vault-caller");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "idls"), { recursive: true });
  writeFileSync(join(dir, "src/lib.rs"), CALLER_SRC);
  writeFileSync(join(dir, "idls/vault_program.json"), JSON.stringify(idl));
  writeFileSync(join(dir, "Cargo.toml"), CALLER_CARGO);
  return dir;
}

if (!calleePresent) {
  console.warn("[differential-declare-program-vault-signed] SKIPPED — vault_program.so fixture missing.");
} else {
  const crateDir = prepareCallerCrate();

  defineDifferential({
    fixtureName: "declare-program-vault-signed",
    programIdBase58: CALLER_ID,
    anchorSource: CALLER_SRC,
    anchorPackageName: "vault_caller",
    anchorReferenceCrateDir: crateDir,
    externalIdls: { vault_program: idl },
    auxiliaryPrograms: [{ programId: VAULT_ID, soFilename: "vault_program.so" }],
    compareTxOutcomes: true,

    setup: async () => {
      const [vaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault")],
        new PublicKey(CALLER_ID),
      );
      return { payer: Keypair.generate(), vaultState: Keypair.generate(), vaultAuthority, amount: 99n };
    },

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      const vaultId = new PublicKey(VAULT_ID);
      svm.airdrop(ctx.payer.publicKey, BigInt(2_000_000_000));

      // init vault_state directly via vault_program (vault_state + payer sign).
      const initIx = new TransactionInstruction({
        programId: vaultId,
        keys: [
          { pubkey: ctx.vaultState.publicKey, isSigner: true, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("init_vault")),
      });
      {
        const tx = new Transaction().add(initIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer, ctx.vaultState);
        svm.sendTransaction(tx);
      }

      // proxy_withdraw via the caller → CPIs withdraw, signing vault_authority
      // (PDA) via invoke_signed. vault_authority is NOT a tx signer — the
      // make-or-break: it signs ONLY through the emitted invoke_signed.
      const doIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.vaultAuthority, isSigner: false, isWritable: false },
          { pubkey: ctx.vaultState.publicKey, isSigner: false, isWritable: true },
          { pubkey: vaultId, isSigner: false, isWritable: false },
        ],
        data: Buffer.from([...anchorIxDiscriminator("proxy_withdraw"), ...encodeU64LE(ctx.amount)]),
      });
      {
        const tx = new Transaction().add(doIx);
        tx.recentBlockhash = svm.latestBlockhash();
        tx.feePayer = ctx.payer.publicKey;
        tx.sign(ctx.payer);
        svm.sendTransaction(tx);
      }
    },

    accountsToCompare: (ctx) => [{ pubkey: ctx.vaultState.publicKey, label: "vault_state" }],
  });
}
