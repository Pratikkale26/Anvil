/**
 * Interface<TokenInterface> UNCHECKED CPI dispatched to LEGACY SPL Token
 * (hard-sweep F4, #24). `token_interface::mint_to` with the caller passing the
 * legacy Tokenkeg program id.
 *
 * Anchor's Interface<TokenInterface> + token_interface::mint_to routes the CPI
 * to WHATEVER token program the caller passes (runtime). Anvil HEAD parsed the
 * qualified unchecked `token_interface::mint_to` with tokenProgram="token_2022"
 * but NO tokenProgramArg, so BOTH emitters hardcoded the Token-2022 program id
 * for the invoke — losing Interface polymorphism. The account guard correctly
 * accepts both Tokenkeg and Token-2022, so a caller passing legacy Tokenkeg
 * (the normal case for a legacy-token program using the Interface) is accepted,
 * but the hardcoded-T22 invoke then reverts (T22 doesn't own Tokenkeg accounts).
 *
 * TEETH (compareTxOutcomes + `to` balance): go(100) mints to `to` via the
 * legacy Tokenkeg program.
 *   - Anchor: routes to Tokenkeg -> mint succeeds -> to = 100.
 *   - Anvil HEAD: invoke hardcoded Token-2022 -> reverts -> to = 0.
 *   - Anvil fix (tokenProgramArg captured): invoke reads token_program.key
 *     (Tokenkeg) -> mint succeeds -> to = 100.
 * So both Anvil targets diverge from Anchor on HEAD and match on the fix.
 */
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
  sendSetupTx,
} from "./differential-setup-helpers.ts";

const PROGRAM_ID = "2FiBGUeJ5R5zTgwuBfwrwyLpptkg9FCseicnQBq6jCQB";

const SRC = `use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, MintTo};

declare_id!("${PROGRAM_ID}");

#[program]
pub mod iface_legacy_mintto {
    use super::*;
    pub fn go(ctx: Context<Go>, amount: u64) -> Result<()> {
        token_interface::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Go<'info> {
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}
`;

function defineFixture(fixtureName: string, anvilTarget?: "native") {
  defineDifferential({
    fixtureName,
    anvilTarget,
    programIdBase58: PROGRAM_ID,
    anchorSource: SRC,
    anchorPackageName: anvilTarget === "native"
      ? "iface_legacy_mintto_native_diff"
      : "iface_legacy_mintto_anchor_diff",
    anchorExtraDeps: `anchor-spl = "0.31"`,
    compareTxOutcomes: true,

    setup: async () => ({
      payer: Keypair.generate(),
      authority: Keypair.generate(),
      mint: Keypair.generate(),
      to: Keypair.generate(),
    }),

    callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
      svm.withDefaultPrograms().withNativeMints();
      svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

      // Legacy Tokenkeg mint (authority = mint authority) + a Tokenkeg token
      // account `to`. createMintIxs/createTokenAccountIxs use TOKEN_PROGRAM_ID.
      const setupTx = new Transaction()
        .add(...createMintIxs(svm, ctx.payer.publicKey, ctx.mint.publicKey, 6, ctx.authority.publicKey, ctx.authority.publicKey))
        .add(...createTokenAccountIxs(svm, ctx.payer.publicKey, ctx.to.publicKey, ctx.mint.publicKey, ctx.payer.publicKey));
      sendSetupTx(svm, setupTx, ctx.payer.publicKey,
        [ctx.payer, ctx.mint, ctx.to],
        "setup");

      // go(100): mint via the Interface, passing the LEGACY Tokenkeg program.
      // Account order matches Go: mint, to, authority, token_program.
      const ix = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: ctx.mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.to.publicKey, isSigner: false, isWritable: true },
          { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(concatBytes(anchorIxDiscriminator("go"), encodeU64LE(100n))),
      });
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.payer.publicKey;
      tx.sign(ctx.payer, ctx.authority);
      svm.sendTransaction(tx); // tolerate failure — HEAD invoke (hardcoded T22) reverts
    },

    stripDiscriminator: false,
    accountsToCompare: (ctx) => [
      { pubkey: ctx.to.publicKey, label: "to" },
      { pubkey: ctx.mint.publicKey, label: "mint" },
    ],
  });
}

defineFixture("interface-legacy-mintto");
defineFixture("interface-legacy-mintto-native", "native");
