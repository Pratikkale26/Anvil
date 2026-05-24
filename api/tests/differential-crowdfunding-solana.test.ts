/**
 * crowdfunding-solana differential — external real-world byte-equal TARGET.
 *
 * Exercises: PDA init with seeds [b"CAMPAIGN_DEMO", user.key()],
 * String field borsh encoding, admin Pubkey write, u64 zero-init.
 * System program CPI for account creation.
 *
 * STATUS: FAIL — Anvil's init-account emit path doesn't produce the
 * create_program_account CPI for PDA-derived init accounts in pass_through
 * code. The campaign account is never created on the Anvil side.
 * This test documents the gap for future fix tracking.
 *
 * Source: github.com/kodmanyagha/crowdfunding-solana
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCreateCampaign,
  callCreateCampaign,
  campaignAccountsToCompare,
} from "./fixtures/crowdfunding-solana-fixture.ts";
import { existsSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-crowdfunding-solana] SKIPPED — ${LIB_RS} missing.`,
  );
} else {
  defineDifferential({
    fixtureName: "crowdfunding-solana-create",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "crowdfunding",

    setup: async () => {
      const programId = new PublicKey(PROGRAM_ID);
      return setupCreateCampaign(programId);
    },
    callScript: async (svm, ctx, programId) => {
      await callCreateCampaign(svm, ctx, programId);
    },
    accountsToCompare: campaignAccountsToCompare,
  });
}
