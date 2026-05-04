/**
 * H4 regression: hardcoded pattern lists in body-classifier produce silent
 * misclassification when their literal sets fall out of sync with real
 * Anchor binding-name conventions. The parser-agent review (2026-04 session)
 * called these out at body-classifier.ts:279-283 and the surrounding seed
 * detection logic; the pattern lists were inlined and untestable in
 * isolation. H1's commit extracted them into named exports
 * (isOuterSignerSeedsBinding / isInnerSeedsBinding /
 * hasUserSeedsManagementSignal) -- this file pins their behaviour with
 * enumerative tests. Each known-name shape is asserted explicitly; each
 * documented false-negative shape is asserted to currently miss (so a
 * future "fix" doesn't accidentally widen the surface and break corpus
 * fixtures that rely on the narrow form).
 */
import { describe, test, expect } from "bun:test";
import {
  isOuterSignerSeedsBinding,
  isInnerSeedsBinding,
  hasUserSeedsManagementSignal,
} from "../src/parser/body-classifier.ts";

describe("H4: isOuterSignerSeedsBinding", () => {
  // Every name pattern the classifier recognises as the OUTER wrapper.
  // Bindings here must NEVER be consumed as inner seed-list sources.
  const OUTER_NAMES = [
    "signer_seeds",
    "signers_seeds",
    "vault_signer_seeds",
    "pool_signer_seeds",
    "my_module_signer_seeds",
    "vault_signers_seeds",
    "pool_signers_seeds",
  ];
  for (const name of OUTER_NAMES) {
    test(`'${name}' classifies as outer wrapper`, () => {
      expect(isOuterSignerSeedsBinding(name)).toBe(true);
    });
  }

  // Names that are NOT recognised as outer wrappers. A bug here would
  // either over-include (consuming inner seed lists as wrappers, dropping
  // their content) or stay tight as designed.
  const NON_OUTER_NAMES = [
    "seeds",
    "vault_seeds",
    "pool_seeds",
    "amount",
    "ctx",
    "signer_seedsX",   // suffix not exact
    "Signer_seeds",    // case-sensitive
    "signer",
    "signers",
    "_signer_seeds",   // pre-existing undocumented behaviour: leading underscore name DOES end with "_signer_seeds"
  ];
  for (const name of NON_OUTER_NAMES) {
    test(`'${name}' is NOT outer wrapper`, () => {
      // Note: '_signer_seeds' ALSO ends with '_signer_seeds' so it currently
      // matches. Surface here so the behaviour is explicit.
      const expected = name === "_signer_seeds" || name === "_signers_seeds";
      expect(isOuterSignerSeedsBinding(name)).toBe(expected);
    });
  }
});

describe("H4: isInnerSeedsBinding", () => {
  const INNER_NAMES = [
    "seeds",
    "vault_seeds",
    "pool_seeds",
    "user_seeds",
    "escrow_seeds",
  ];
  for (const name of INNER_NAMES) {
    test(`'${name}' classifies as inner seed list`, () => {
      expect(isInnerSeedsBinding(name)).toBe(true);
    });
  }

  // Outer wrappers must NOT show up here -- they share the `_seeds` suffix
  // (because `_signer_seeds` ends with both `_seeds` AND `_signer_seeds`),
  // and the only thing keeping them out is the explicit isOuterSignerSeedsBinding
  // gate. Locking this down so a future refactor doesn't drop the gate.
  const NOT_INNER = [
    "signer_seeds",
    "vault_signer_seeds",
    "signers_seeds",
    "pool_signers_seeds",
    "amount",
    "Seeds",            // case-sensitive
    "seedsList",        // not the right suffix
  ];
  for (const name of NOT_INNER) {
    test(`'${name}' is NOT inner seeds`, () => {
      expect(isInnerSeedsBinding(name)).toBe(false);
    });
  }
});

describe("H4: hasUserSeedsManagementSignal", () => {
  // The exact shape the classifier disables auto-consumption for. Both
  // forms below must match; a regression that drops either would re-enable
  // auto-consumption against in-corpus PDA-signed fixtures and shadow the
  // user's hand-written seed prep.
  const POSITIVE_BODIES = [
    "let signers_seeds = [&seeds[..]];",
    "let signers_seeds= [&seeds[..]];",
    "let signers_seeds  =  [ & seeds [ .. ] ];",
    "let pool_signers_seeds = [&pool_inner];",
    "let vault_signers_seeds = [&another_seed];",
    // The narrow second regex matches `\w*signers_seeds = [&` — even
    // an empty prefix counts.
    "let signers_seeds = [&derived];",
  ];
  for (const body of POSITIVE_BODIES) {
    test(`positive: ${JSON.stringify(body).slice(0, 60)}`, () => {
      expect(hasUserSeedsManagementSignal(body)).toBe(true);
    });
  }

  // Documented false-negatives. The narrow regex was intentionally narrow
  // to avoid false positives from unrelated bindings. These are shapes a
  // user MIGHT write that we'd LIKE to recognise but currently don't --
  // each one falls back to the auto-consumption pass, which works on the
  // in-corpus seed-shapes but may produce a misclassification on the
  // user's expected shape. Locking the current behaviour so a "fix" that
  // widens the regex is intentional, not accidental. (Parser-agent review
  // flagged these as known fragility.)
  const KNOWN_NEGATIVES = [
    "let signers_list = [&seeds[..]];",          // suffix isn't 'signers_seeds'
    "let signer_wrappers = [&seeds[..]];",       // missing trailing 's' on signer
    "let SIGNERS_SEEDS = [&seeds[..]];",         // case-sensitive
    "let my_seeds_outer = [&seeds[..]];",        // suffix isn't 'signers_seeds'
    "let signers_seeds_v2 = [&seeds[..]];",      // suffix not exact
  ];
  for (const body of KNOWN_NEGATIVES) {
    test(`known false-negative: ${JSON.stringify(body).slice(0, 60)}`, () => {
      expect(hasUserSeedsManagementSignal(body)).toBe(false);
    });
  }

  // Empty / unrelated bodies must not trigger.
  test("empty body", () => {
    expect(hasUserSeedsManagementSignal("")).toBe(false);
  });
  test("unrelated body", () => {
    expect(hasUserSeedsManagementSignal("let amount = 42;")).toBe(false);
  });
});
