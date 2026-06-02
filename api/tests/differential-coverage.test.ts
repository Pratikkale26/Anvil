/**
 * M3 differential coverage gate.
 *
 * The "with proof" claim is load-bearing for Anvil: cargo-green is necessary
 * but not sufficient, and the differential corpus (LiteSVM byte-equal on
 * data + lamports + owner) is the actual correctness signal. Coverage gaps
 * are unverified claims.
 *
 * This test enforces the contract: every BodyStatement kind in
 * api/src/ir/schema.ts has at least one differential fixture exercising it
 * (transitively, via the demo program the fixture loads). Adding a kind to
 * the schema without adding a fixture will fail this test loudly with a
 * pointer to which kind is uncovered.
 *
 * Mechanism:
 *   1. Enumerate every BodyStatement kind from the Zod discriminated union.
 *   2. Maintain a hand-written FIXTURE_REGISTRY mapping fixtureName -> demo
 *      filename (since fixture files load demos dynamically, this is the
 *      stable seam for static analysis).
 *   3. For each fixture, parse its demo source and collect the kinds it
 *      produces.
 *   4. Assert every kind has >= 1 fixture covering it. Surface gaps with
 *      a per-kind hint.
 *
 * This test runs in the deterministic suite (no SBF toolchain required) —
 * it parses demos in-process and reads file contents only. The actual
 * differential .so build only fires when SBF is available; the coverage
 * gate fires unconditionally so a CI without SBF still catches schema
 * additions that lack a fixture.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { BodyStatementSchema } from "../src/ir/schema.ts";

/**
 * Hand-maintained mapping from differential fixture name (matches the
 * fixtureName used in defineDifferential) to the demo program it exercises.
 * Adding a fixture requires adding an entry here so the matrix knows what
 * kinds it covers.
 *
 * If you add a new fixture, also add its mapping here. The matrix test
 * fails noisily if a fixture file exists but isn't in the registry.
 */
const FIXTURE_REGISTRY: Record<string, string> = {
  // fixture name → demo filename in src/demo-programs/
  counter: "counter.rs",
  vault: "vault.rs",
  escrow: "escrow.rs",
  staking: "staking.rs",
  vesting: "vesting.rs",
  multisig: "multisig.rs",
  // B2 gold-standard: read-only Account<T> owner-check revert-parity. Same demo;
  // kinds covered by "multisig" above. (Registered late — differential-* files are
  // excluded from test:fast, so the M3 matrix only catches this when run directly.)
  "multisig-readonly-owner-reject": "multisig.rs",
  "ata-mint": "ata-mint.rs",
  "set-authority": "set-authority.rs",
  "spl-transfer": "spl-transfer.rs",
  "spl-burn": "spl-burn.rs",
  "t22-transfer": "t22-transfer.rs",
  "close-account": "close-account.rs",
  "has-one": "has-one.rs",
  "init-if-needed": "init-if-needed.rs",
  "optional-state": "optional-state.rs",
  realloc: "realloc.rs",
  "realloc-grow": "realloc-grow.rs",
  "event-emit": "event-emit.rs",
  // M3 additions: parser-only kinds with new demos.
  "bumps-access": "bumps-access.rs",
  "sysvar-rent": "sysvar-rent.rs",
  "return-err": "return-err.rs",
  "cpi-memo": "cpi-memo.rs",
  "cpi-custom": "cpi-custom.rs",
  // #5 gold-standard generic-CPI gate (GATED behind CPI_CUSTOM_REAL_EMIT until the
  // Pinocchio slice lands). Demo produces cpi_custom — already covered above.
  "cpi-custom-goldstandard": "cpi-counter-caller.rs",
  // #5 Native generic-CPI byte-equal gate (real invoke_signed emit — GREEN). Same demo.
  "cpi-custom-native": "cpi-counter-caller.rs",
  // Perp-funding: hand-rolled differential gating initialize_market
  // byte-equal + auto-scenario stub.
  "perp-funding": "perp-funding.rs",
  // Auto-scenario differential corpus + Phase 2 fixtures (local).
  amm: "amm.rs",
  marketplace: "marketplace.rs",
  "msg-emit": "msg-emit.rs",
  "program-config": "program-config.rs",
  "return-data": "return-data.rs",
  "simple-staking": "simple-staking.rs",
  "tip-jar": "tip-jar.rs",
  // Token-2022 extension family fixtures (typed IR + structural emit).
  // Each demo exercises one extension's init + at least one manage CPI.
  "t22-default-account-state": "t22-default-account-state.rs",
  "t22-immutable-owner": "t22-immutable-owner.rs",
  "t22-interest-bearing": "t22-interest-bearing.rs",
  "t22-non-transferable": "t22-non-transferable.rs",
  "t22-token-metadata": "t22-token-metadata.rs",
  "t22-transfer-fee-init": "t22-transfer-fee-init.rs",
  // t22-transfer-fee-extras reuses the transfer-fee-init demo source
  // (per differential-t22-transfer-fee-extras.test.ts).
  "t22-transfer-fee-extras": "t22-transfer-fee-init.rs",
  // EM2 Session 1 — MintCloseAuthority + PermanentDelegate.
  "t22-mint-close-authority": "t22-mint-close-authority.rs",
  "t22-permanent-delegate": "t22-permanent-delegate.rs",
  // EM2 Session 2 — TransferHook (init + update) + MetadataPointer (init).
  "t22-transfer-hook": "t22-transfer-hook.rs",
  "t22-metadata-pointer": "t22-metadata-pointer.rs",
  // EM2 Session 3 — GroupPointer (init + update) + GroupMemberPointer (init + update).
  "t22-group-pointer": "t22-group-pointer.rs",
  "t22-group-member-pointer": "t22-group-member-pointer.rs",
  // Direct standalone initialize_mint2 CPI (#34 — covers cpi_t22_initialize_mint2,
  // byte-equal differential at differential-t22-init-mint2.test.ts).
  "t22-init-mint2": "t22-init-mint2.rs",
  // Zero-copy AccountLoader handle (zero_copy_load_init/_mut/_).
  "zero-copy-foo": "zero-copy-foo.rs",
  // LazyAccount whole-struct load_mut() Borsh byte-equal (#19).
  "lazy-counter": "lazy-counter.rs",
  // Conditional money-movement: if <cond> { system_program::transfer } (#13 1a).
  "conditional-transfer": "conditional-transfer.rs",
  // Control-flow byte-equal: for-loop + match dispatch, varied args (#4).
  "control-flow": "control-flow.rs",
  // realloc_if_needed mechanism: conditional rent transfer + account.realloc (#13 1b+1c).
  "realloc-with-rent": "realloc-with-rent.rs",
  // Metaplex Token Metadata byte-equal fixtures (2026-05-09 → 2026-05-19).
  // Each entry maps the fixtureName the .test.ts file declares to the demo
  // it loads (`api/src/demo-programs/mpl-*.rs`). The differential gate runs
  // mpl_token_metadata.so loaded into LiteSVM via svm.addProgram.
  "mpl-create-metadata": "mpl-create-metadata.rs",
  "mpl-verify-collection-direct": "mpl-verify-collection-direct.rs",
  "mpl-mint-new-edition": "mpl-mint-new-edition.rs",
  "mpl-approve-revoke": "mpl-approve-revoke.rs",
  "mpl-freeze-thaw": "mpl-freeze-thaw.rs",
  "mpl-collection-verify": "mpl-collection-verify.rs",
  "mpl-sign-metadata": "mpl-sign-metadata.rs",
  // MPL Core byte-equal fixtures (task #48 — 2026-05-19). The differential
  // gate runs mpl_core.so loaded into LiteSVM via svm.addProgram. All 10
  // slots have a demo + byte-equal differential.
  "mpl-core-create-v2": "mpl-core-create-v2.rs",
  "mpl-core-update-v2": "mpl-core-update-v2.rs",
  "mpl-core-transfer-v1": "mpl-core-transfer-v1.rs",
  "mpl-core-burn-v1": "mpl-core-burn-v1.rs",
  "mpl-core-create-collection-v2": "mpl-core-create-collection-v2.rs",
  "mpl-core-add-plugin-v1": "mpl-core-add-plugin-v1.rs",
  "mpl-core-remove-plugin-v1": "mpl-core-remove-plugin-v1.rs",
  "mpl-core-update-plugin-v1": "mpl-core-update-plugin-v1.rs",
  "mpl-core-approve-revoke-plugin-authority-v1": "mpl-core-approve-revoke-plugin-authority-v1.rs",
  // Vendored external real-world programs (src/demo-programs/external/) + a
  // return-err variant — real .rs files, parsed for coverage (#35).
  "arjun-counterapp-native": "external/arjun-counterapp.rs",
  "arjun-counterapp-pin": "external/arjun-counterapp.rs",
  "arjun-p-nft-native": "external/arjun-p-nft.rs",
  "arjun-p-nft-pin": "external/arjun-p-nft.rs",
  "arjun-pda-native": "external/arjun-pda.rs",
  "arjun-pda-pin": "external/arjun-pda.rs",
  "return-err-outcomes": "return-err.rs",
};

/**
 * Differential fixtures whose source lives OUTSIDE src/demo-programs/ —
 * they load Anchor source from cached external repos via fixture
 * loaders (account-data-fixture.ts, etc.). The coverage matrix treats
 * these as registered but doesn't parse their source for kind coverage
 * (each external fixture's IR kinds are also covered by an in-tree
 * demo, so they don't add unique coverage requirements).
 *
 * Mark new external fixtures here so the FIXTURE_REGISTRY-points-at-
 * existing-file check passes.
 */
const EXTERNAL_FIXTURES = new Set<string>([
  "account-data",
  "anchor-escrow-2025-make-offer",
  "anchor-escrow-2025-make-offer-tracked",
  "coral-events",
  "favorites",
  "page-visits",
  "pda-rent-payer",
  // #35 — repo-clone + inline-source differential fixtures (no local demo
  // file; kinds covered by in-tree demos). Catalogued so the coverage
  // matrix accounts for every differential-*.test.ts.
  "coral-callee-initialize",
  "coral-chat-create-user",
  "coral-composite-update",
  "coral-cpi-returns-malicious-spoof",
  "coral-duplicate-mutable-init",
  "coral-escrow-initialize",
  "coral-floats-create-update",
  "coral-idl-docs-test-idl-doc-parse",
  "coral-init-if-needed-second",
  "coral-interface-new-init-another",
  "coral-interface-old-init",
  "coral-multiple-errors-test",
  "coral-multisig-create",
  "coral-overflow-checks-init",
  "coral-pda-derivation-init-base",
  "coral-realloc-init",
  "coral-relations-derivation-init-base",
  "coral-safety-checks-initialize",
  "coral-spl-token-custom-coder-empty-mod",
  "coral-system-accounts-initialize",
  "coral-sysvars-sysvars",
  "coral-test-instruction-validation-no-params",
  "coral-tutorial-basic-1-initialize",
  "coral-tutorial-basic-2-create",
  "coral-tutorial-basic-3-puppet",
  "coral-tutorial-basic-4-initialize",
  "coral-tutorial-basic-5-create-walk-jump",
  "crowdfunding-solana-create",
  "custom-instruction-disc",
  "helium-circuit-breaker-init",
  "option-account",
  "option-account-multi",
  "program-examples-account-data",
  "program-examples-anchor-realloc",
  "program-examples-carnival",
  "program-examples-checking-accounts",
  "program-examples-close-account",
  "program-examples-counter",
  "program-examples-cpi-lever",
  "program-examples-create-account",
  "program-examples-create-token",
  "program-examples-escrow",
  "program-examples-favorites-set-favorites",
  "program-examples-hello-solana",
  "program-examples-nft-minter",
  "program-examples-nft-operations",
  "program-examples-pda",
  "program-examples-pda-mint-authority",
  "program-examples-processing-instructions",
  "program-examples-realloc",
  "program-examples-rent",
  "program-examples-spl-token-minter",
  "program-examples-t22-basics",
  "program-examples-t22-group",
  "program-examples-token-fundraiser",
  "program-examples-token-swap-create-amm",
  "program-examples-transfer-sol",
  "program-examples-transfer-tokens",
]);

/**
 * Kinds that don't appear in any handler body (return_ok is the implicit
 * end of every successful handler — every demo trivially covers it).
 * Whitelisted so the matrix doesn't false-fail on them.
 */
const IMPLICIT_KINDS = new Set<string>(["return_ok"]);

/**
 * Kinds whose differential fixtures are explicitly deferred with a design
 * note. Each entry MUST link to a tracking task or design doc explaining
 * why the fixture is deferred and when it'll land. Adding to this set is
 * a deliberate decision -- the matrix should still surface the gap, just
 * not as a build-breaking failure.
 *
 * Currently:
 *   - cpi_mpl_*: Metaplex catalog work is grant-M3 / Tier 2.2 in
 *     project-roadmap-todos.md. The IR slots + real CPI emit
 *     (Pinocchio + Native) landed across 2026-05-13 → 2026-05-18 for
 *     all 12 catalog instructions. Live-program differential gates
 *     require mpl-token-metadata loaded into LiteSVM AND a real
 *     external-program scenario harness — that is task #51 (N1), a
 *     separate arc from the emit work.
 *   - cpi_t22_metadata_pointer_update: emit landed via E1 (commit
 *     6b4ed1f). The differential gate is E2 (task #37) — currently
 *     blocked on SBF-toolchain session.
 */
const DEFERRED_WITH_DESIGN_NOTE = new Set<string>([
  // Pre-existing entries from the M3 IR slot landing (#29).
  "cpi_mpl_create_metadata_v3",
  "cpi_mpl_create_master_edition_v3",
  // Catalog slots 3–7 (verify_collection family + sign_metadata).
  "cpi_mpl_update_metadata_accounts_v2",
  "cpi_mpl_verify_collection",
  "cpi_mpl_sign_metadata",
  "cpi_mpl_unverify_collection",
  "cpi_mpl_set_and_verify_collection",
  // Catalog slots 8–9 (approve/revoke collection authority).
  "cpi_mpl_approve_collection_authority",
  "cpi_mpl_revoke_collection_authority",
  // Catalog slots 10–12 (editions + freeze/thaw).
  "cpi_mpl_mint_new_edition_from_master",
  "cpi_mpl_freeze_delegated",
  "cpi_mpl_thaw_delegated",
  // T22 MetadataPointer update — see E2 (task #37).
  "cpi_t22_metadata_pointer_update",
  // M2a — legacy Pyth read. Session-1 IR + parser + visitor stub
  // landed (this commit); structural emit + byte-equal gate land in
  // M2b / Session-3 of the M2 arc (posts/plan-pyth-m2.md).
  "cpi_pyth_read_price_legacy",
  // N5 — modern Pyth read (receiver-sdk PriceUpdateV2). IR + parser +
  // per-target emit shipped; differential byte-equal against the
  // cloned Pyth Receiver validator is queued for M2c.
  "cpi_pyth_read_price_modern",
  // N5b — inline-parsed feed-id helper. Pure compile-time-literal
  // expansion; no runtime CPI, so a differential fixture would just
  // verify byte-for-byte equality of the inlined array. Deferred.
  "pyth_feed_id_literal",
  // Switchboard On-Demand reader. IR + parser + emit landed (task #47);
  // byte-equal differential gate deferred until a switchboard .so
  // fixture lands. cargo-build is the available correctness signal.
  "cpi_switchboard_read_feed",
  // (MPL Core slots S1-S10 ALL promoted out of deferred list 2026-05-19
  // — byte-equal differentials green against real mpl_core.so loaded into
  // LiteSVM. Tests at differential-mpl-core-*.test.ts.)
  // Confidential T22 init slots (task #49) — IR + parser + emit + cargo-check
  // shipped; byte-equal differential against spl_token_2022.so deferred
  // because the setup needs an existing mint allocated with the
  // ConfidentialTransferMint extension via the T22 extension-init flow,
  // which is its own scenario harness work. cargo-check is the available
  // signal until that wiring lands. Future arc: pair with a real auditor
  // ElGamal pubkey + verify post-init mint extension state byte-equal.
  "cpi_t22_confidential_transfer_initialize_mint",
  "cpi_t22_confidential_transfer_fee_init",
  "cpi_t22_confidential_mint_burn_initialize_mint",
  // (cpi_t22_initialize_mint2 promoted OUT of deferred 2026-05-31 — now has a
  // real byte-equal fixture: t22-init-mint2 / differential-t22-init-mint2.test.ts, #34.)
]);

function listBodyStatementKinds(): string[] {
  // Zod's discriminated union exposes its options; each option is a z.object
  // whose shape.kind is a z.literal carrying the kind value.
  const options = (BodyStatementSchema as unknown as {
    options: Array<{ shape: { kind: { value: string } } }>;
  }).options;
  return options.map((o) => o.shape.kind.value).sort();
}

function listDifferentialFixtureFiles(): string[] {
  const dir = import.meta.dir;
  return readdirSync(dir)
    .filter((f) => f.startsWith("differential-") && f.endsWith(".test.ts"))
    .filter((f) => f !== "differential-with-ai.test.ts" && f !== "differential-coverage.test.ts");
}

/** Extract `fixtureName: "..."` from a differential test file. */
function extractFixtureName(filePath: string): string | null {
  const src = readFileSync(filePath, "utf-8");
  const m = src.match(/fixtureName:\s*"([^"]+)"/);
  return m?.[1] ?? null;
}

async function kindsProducedBy(demoPath: string): Promise<Set<string>> {
  const src = readFileSync(demoPath, "utf-8");
  const r = await parseAnchor(src);
  if (!r.ok) {
    throw new Error(`Could not parse ${demoPath}: ${r.error}`);
  }
  const kinds = new Set<string>();
  for (const ix of r.ir.instructions) {
    for (const stmt of ix.body) kinds.add(stmt.kind);
  }
  return kinds;
}

describe("M3: differential coverage matrix", () => {
  test("FIXTURE_REGISTRY entries point at existing demo files", () => {
    const missing: string[] = [];
    for (const [fixture, demo] of Object.entries(FIXTURE_REGISTRY)) {
      const path = join(import.meta.dir, "..", "src", "demo-programs", demo);
      if (!existsSync(path)) missing.push(`${fixture} → ${demo}`);
    }
    expect(missing).toEqual([]);
  });

  test("every differential-*.test.ts is in FIXTURE_REGISTRY or EXTERNAL_FIXTURES", () => {
    const found: string[] = [];
    for (const file of listDifferentialFixtureFiles()) {
      const name = extractFixtureName(join(import.meta.dir, file));
      if (name && !(name in FIXTURE_REGISTRY) && !EXTERNAL_FIXTURES.has(name)) {
        found.push(`${file} (fixtureName='${name}')`);
      }
    }
    expect(found).toEqual([]);
  });

  test("every BodyStatement kind has at least one fixture covering it", async () => {
    const allKinds = listBodyStatementKinds();
    const coveredByFixture = new Map<string, string[]>();
    for (const [fixture, demo] of Object.entries(FIXTURE_REGISTRY)) {
      const path = join(import.meta.dir, "..", "src", "demo-programs", demo);
      if (!existsSync(path)) continue;
      const kinds = await kindsProducedBy(path);
      for (const k of kinds) {
        if (!coveredByFixture.has(k)) coveredByFixture.set(k, []);
        coveredByFixture.get(k)!.push(fixture);
      }
    }
    const uncovered: string[] = [];
    const deferred: string[] = [];
    for (const kind of allKinds) {
      if (IMPLICIT_KINDS.has(kind)) continue;
      const fixtures = coveredByFixture.get(kind) ?? [];
      if (fixtures.length === 0) {
        if (DEFERRED_WITH_DESIGN_NOTE.has(kind)) {
          deferred.push(kind);
          continue;
        }
        uncovered.push(
          `  - '${kind}': no differential fixture exercises this kind. Add a demo in src/demo-programs/ that produces '${kind}', wire it into a tests/differential-<X>.test.ts via defineDifferential, and add the fixture to FIXTURE_REGISTRY in this file.`,
        );
      }
    }
    if (deferred.length > 0) {
      // Surface but don't fail. The deferred set is a deliberate gap with
      // a tracking design note; the visibility here keeps it from being
      // forgotten between sessions.
      console.warn(
        `\n[M3 coverage] ${deferred.length} kind(s) intentionally deferred (see DEFERRED_WITH_DESIGN_NOTE in this file):\n  ${deferred.join("\n  ")}\n`,
      );
    }
    if (uncovered.length > 0) {
      throw new Error(
        `M3 coverage gate: ${uncovered.length} BodyStatement kind(s) have no fixture:\n${uncovered.join("\n")}\n\n` +
        `Implicit kinds (whitelisted, every handler trivially exercises them): ${[...IMPLICIT_KINDS].join(", ")}\n` +
        `Deferred-with-design-note: ${[...DEFERRED_WITH_DESIGN_NOTE].join(", ") || "(none)"}`,
      );
    }
  });
});
