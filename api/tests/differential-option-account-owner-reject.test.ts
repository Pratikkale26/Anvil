/**
 * GOLD-STANDARD — bare `Option<Account<T>>` intrinsic owner check REJECTS at
 * runtime, with revert-parity against Anchor. The optional companion to
 * differential-multisig-readonly-owner-reject (which covers non-optional B2).
 *
 * Anchor's `Account<T>::try_from` enforces `owner == program_id` even on a
 * bare `Option<Account<'info, T>>` when the account is present (zero
 * constraints needed). Anvil's preamble owner checks skip optionals
 * (`!a.isOptional`); the body walker injects the check INSIDE the Some-branch,
 * before `T::from_account_info`. Without it, a present wrong-owner account with
 * a valid discriminator would deserialize and its `admin` field be read for
 * authorization — accepted by Anvil, rejected by Anchor.
 *
 * Scenario (run against both the Anchor .so and the Anvil .so):
 *   1. init_config(admin = authority)              — ok
 *   2. gate, config present, owner = program       — ok   (CONTROL: passes when owner is correct)
 *   <corrupt config.owner → SystemProgram, keep data so admin still == authority>
 *   3. gate, config present, owner = System         — REVERT on BOTH (the owner check fires)
 *
 * The contrast between step 2 (ok) and step 3 (revert) — SAME instruction,
 * SAME accounts, only the config's OWNER changed — isolates the owner check as
 * the sole cause. The corrupted data keeps `admin == authority`, so the
 * downstream `require_keys_eq!` auth read would SUCCEED if reached: pre-fix,
 * Anvil's `from_account_info` accepts the valid discriminator, the auth read
 * passes, and Anvil's tx SUCCEEDS while Anchor reverts (ConstraintOwner) →
 * compareTxOutcomes diverges. Post-fix both revert → parity. This is the
 * runtime proof the fix matches Anchor (not just that it compiles).
 */
import { readFileSync } from "node:fs";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  Keypair,
  PublicKey,
  LiteSVM,
  mkTestProgramId,
} from "./differential-harness.ts";

const PROGRAM_ID = mkTestProgramId("optReject1111111111111111111111111111111111");

const SOURCE = `
use anchor_lang::prelude::*;
declare_id!("${PROGRAM_ID}");

#[program]
pub mod opt_owner_reject {
    use super::*;
    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        ctx.accounts.config.admin = ctx.accounts.authority.key();
        Ok(())
    }
    // Bare Option<Account<Config>> read for authorization. The detector
    // un-gates this (Axis A/B/C/D all hold) so it emits real code — the path
    // the owner check must guard.
    pub fn gate(ctx: Context<Gate>) -> Result<()> {
        if let Some(cfg) = &ctx.accounts.config {
            require_keys_eq!(cfg.admin, ctx.accounts.authority.key());
        }
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = authority, space = 40, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Gate<'info> {
    pub authority: Signer<'info>,
    pub config: Option<Account<'info, Config>>,
}

#[account]
pub struct Config { pub admin: Pubkey }
`;

defineDifferential({
  fixtureName: "option-account-owner-reject",
  programIdBase58: PROGRAM_ID,
  anchorSource: SOURCE,
  anchorPackageName: "opt_owner_reject_diff",
  // The expected-revert step (gate after owner corruption) is the point — compare
  // the per-tx ok/revert sequence across runtimes.
  compareTxOutcomes: true,

  setup: async () => {
    const programId = new PublicKey(PROGRAM_ID);
    const authority = Keypair.generate();
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      programId,
    );
    return { authority, configPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.configPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("init_config")),
    });

    // Gate: authority (required signer) + config (trailing optional, present).
    const gateIx = () =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: ctx.configPda, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(anchorIxDiscriminator("gate")),
      });

    // Setup sends MUST succeed — throw loudly if they don't (a broken setup
    // would otherwise masquerade as revert-parity).
    const sendOk = (ix: TransactionInstruction, signers: Keypair[]) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = signers[0]!.publicKey;
      tx.sign(...signers);
      const r = svm.sendTransaction(tx);
      if (r?.constructor?.name === "FailedTransactionMetadata") {
        const f = r as unknown as { err: () => { toString(): string }; meta: () => { logs: () => string[] } };
        throw new Error(`setup tx unexpectedly failed: ${f.err().toString()}\n${f.meta().logs().join("\n")}`);
      }
    };
    // The expected-revert send: do NOT throw — the harness compares the
    // recorded outcome across runtimes.
    const send = (ix: TransactionInstruction, signers: Keypair[]) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = signers[0]!.publicKey;
      tx.sign(...signers);
      svm.sendTransaction(tx);
    };

    sendOk(initIx, [ctx.authority]);          // ok — config created, owned by program
    sendOk(gateIx(), [ctx.authority]);        // ok — CONTROL: present + correct owner

    // Corrupt the optional config: keep its data (admin still == authority, so
    // the downstream auth read would SUCCEED) + lamports; flip owner to System.
    const acc = svm.getAccount(ctx.configPda);
    if (!acc) throw new Error("config account missing after init");
    svm.setAccount(ctx.configPda, {
      lamports: acc.lamports,
      data: acc.data,
      owner: SystemProgram.programId,
      executable: false,
    });

    send(gateIx(), [ctx.authority]);          // REVERT on both (owner check)
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.configPda, label: "config_pda" },
  ],
});
