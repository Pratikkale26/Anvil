/**
 * I4 / #39 TEETH — a non-init `Account<'info, TokenAccount>` carries an
 * intrinsic `owner == spl_token::ID` check (Anchor's `Account<T>` deserializer
 * enforces `info.owner == &T::owner()` before any access; `Pack::unpack` /
 * Anvil's `token_account_amount` checks length/state but NOT ownership). Anvil's
 * `isCustomState` filter correctly excludes SPL types from the program_id
 * ownerChecks but pre-fix emitted NO substitute → confused-deputy: an account
 * with a TokenAccount-shaped layout owned by ANOTHER program is accepted, its
 * `.amount` read as a real balance.
 *
 * Scenario (run against both the Anchor .so and the Anvil .so):
 *   1. setup: real spl_token mint + vault ATA (owner = TOKEN_PROGRAM, 1000)
 *   2. read_vault(nonce=0), vault correctly owned → ok    (CONTROL)
 *   <corrupt vault.owner → System Program, KEEP the 165-byte token data so
 *    `.amount` would still read 1000 if the owner check is skipped>
 *   3. read_vault(nonce=1), vault owned by System         → REVERT on both
 *
 * The `nonce` arg is ignored by the handler — it exists ONLY to make the two
 * read_vault transactions distinct (different instruction data → different
 * signature), so litesvm doesn't dedup the second send by signature (which
 * would falsely "revert" it on BOTH runtimes and mask the owner-check
 * divergence). Step 2 (ok) vs step 3 (revert) — SAME instruction, SAME
 * accounts, only the vault's OWNER changed — isolates the owner check. Pre-fix
 * Anvil reads the stale `.amount`, the tx SUCCEEDS while Anchor reverts
 * (AccountOwnedByWrongProgram) → compareTxOutcomes diverges. Post-fix both
 * revert → parity. The runtime proof the fix matches Anchor.
 */
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
  mkTestProgramId,
} from "./differential-harness.ts";
import { setupMintAndAtaIxs, sendSetupTx } from "./differential-setup-helpers.ts";
import { isTxFailure, txFailureMessage } from "./litesvm-tx-error.ts";

const PROGRAM_ID = mkTestProgramId("SpownerRejectTokenAcct111111111111111111111");

const SOURCE = `
use anchor_lang::prelude::*;
use anchor_spl::token::TokenAccount;
declare_id!("${PROGRAM_ID}");

#[program]
pub mod spl_owner_reject {
    use super::*;
    // Reads a non-init Account<TokenAccount>'s balance. Anchor enforces
    // owner == spl_token::ID on deserialize, before this body runs. _nonce
    // is ignored — it only differentiates the two calls' tx signatures.
    pub fn read_vault(ctx: Context<ReadVault>, _nonce: u64) -> Result<()> {
        let _amt = ctx.accounts.vault.amount;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct ReadVault<'info> {
    pub vault: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
}
`;

defineDifferential({
  fixtureName: "spl-account-owner-reject",
  programIdBase58: PROGRAM_ID,
  anchorSource: SOURCE,
  anchorPackageName: "spl_owner_reject_diff",
  anchorExtraDeps: `anchor-spl = "0.31"`,
  // The expected-revert step (read_vault after owner corruption) is the point.
  compareTxOutcomes: true,
  stripDiscriminator: false, // SPL token accounts have no 8-byte Anchor disc

  setup: async () => {
    const payer = Keypair.generate();
    const authority = Keypair.generate();
    const mint = Keypair.generate();
    const vault = getAssociatedTokenAddressSync(mint.publicKey, authority.publicKey);
    return { payer, authority, mint, vault };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    svm.withDefaultPrograms().withNativeMints();
    svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));
    svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

    // Real spl_token mint + vault ATA (authority-owned, funded 1000).
    const setupTx = new Transaction().add(
      ...setupMintAndAtaIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, ctx.vault, ctx.authority.publicKey, 6, 1_000n),
    );
    sendSetupTx(svm, setupTx, ctx.payer.publicKey, [ctx.payer, ctx.mint], "setup");

    const readVaultIx = (nonce: bigint) =>
      new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.vault, isSigner: false, isWritable: false },
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("read_vault"), encodeU64LE(nonce))),
      });

    const send = (ix: TransactionInstruction, signers: Keypair[], throwOnFail: boolean) => {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = signers[0]!.publicKey;
      tx.sign(...signers);
      const r = svm.sendTransaction(tx);
      if (throwOnFail && isTxFailure(r)) {
        throw new Error(`read_vault (control) unexpectedly failed: ${txFailureMessage(r)}`);
      }
    };

    // CONTROL: vault correctly owned by the token program → ok on both.
    send(readVaultIx(0n), [ctx.authority], true);

    // Corrupt the vault's owner → System, KEEP its token data (amount still
    // reads 1000 if the owner check is skipped) + lamports.
    const acc = svm.getAccount(ctx.vault);
    if (!acc) throw new Error("vault account missing after setup");
    svm.setAccount(ctx.vault, {
      lamports: acc.lamports,
      data: acc.data,
      owner: SystemProgram.programId,
      executable: false,
    });

    // The expected-revert send: do NOT throw — the harness compares the
    // recorded ok/revert outcome across runtimes. nonce=1 → distinct tx.
    send(readVaultIx(1n), [ctx.authority], false); // REVERT on both (owner check)
  },

  accountsToCompare: (ctx) => [
    { pubkey: ctx.vault, label: "vault" },
  ],
});
