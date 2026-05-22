/**
 * coral-idl-docs differential — external real-world byte-equal target.
 *
 * Source: github.com/coral-xyz/anchor — tests/idl/programs/docs. Upstream
 * uses this single-file program purely as a doc-comment IDL-extraction
 * fixture. The handler is `Ok(())`.
 *
 * Scope: byte-equal on the lone declared account (`act: Account<'info,
 * DataWithDoc>`) post-test_idl_doc_parse. The account is pre-seeded with
 * the canonical Anchor disc (sha256("account:DataWithDoc")[..8]) plus a
 * distinctive u16 payload and marked program-owned, so Anchor's typed
 * deserialiser accepts it. The handler body is `Ok(())` and the struct
 * field is non-mut — so any drift in Anvil's emit on a no-op typed
 * handler (zeroing, reallocating, reassigning, lamport mutation) is
 * caught by the post-state byte-compare.
 *
 * Why this matters: validates Anvil's empty-handler emit + typed
 * Account<'info, T> binding plumbing. A class of regressions that
 * compileable but-stateful test programs can mask (the noise of the
 * intended state-write hides any incidental mutation of "innocent"
 * neighbouring fields).
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
  setupIdlDocs,
  callIdlDocs,
  idlDocsAccountsToCompare,
} from "./fixtures/coral-idl-docs-fixture.ts";
import { existsSync } from "node:fs";

ensureRepoCloned();

if (!existsSync(LIB_RS)) {
  console.warn(
    `[differential-coral-idl-docs] SKIPPED — ${LIB_RS} missing. ensureRepoCloned tried to clone github.com/coral-xyz/anchor.`,
  );
} else {
  defineDifferential({
    fixtureName: "coral-idl-docs-test-idl-doc-parse",
    programIdBase58: PROGRAM_ID,
    anchorSource: loadAnchorSource(),
    // Unique cargo package name — must not collide with other coral fixtures.
    anchorPackageName: "coral_idl_docs_diff",
    // Upstream Cargo.toml path-deps anchor-lang from `../../../../lang`,
    // a workspace-relative dep that wouldn't resolve from a scratch lib.rs.
    // anchorReferenceCrateDir lets cargo build the upstream crate verbatim.
    anchorReferenceCrateDir: CRATE_DIR,

    setup: setupIdlDocs,
    callScript: callIdlDocs,
    accountsToCompare: idlDocsAccountsToCompare,
  });
}
