/**
 * coral-chat differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/chat/programs/chat.
 *
 * Scope: byte-equal on `user` PDA post-create_user. Validates Anvil's
 * PDA-init emit with seeds = [authority.key().as_ref()], plus the body
 * writes for a struct with a Borsh String + Pubkey + u8 layout.
 *
 * Counts toward grant A1 (10 byte-equal external Anchor programs).
 */
import { defineDifferential } from "./differential-harness.ts";
import {
  LIB_RS,
  CRATE_DIR,
  PROGRAM_ID,
  ensureRepoCloned,
  loadAnchorSource,
  setupCreateUser,
  callCreateUser,
  userAccountsToCompare,
} from "./fixtures/coral-chat-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-chat] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-chat-create-user",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    anchorPackageName: "coral_chat_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`
    // AND adds bytemuck — anchorReferenceCrateDir is the only path that
    // resolves both.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupCreateUser,
    callScript: callCreateUser,
    accountsToCompare: userAccountsToCompare,
  });
}
