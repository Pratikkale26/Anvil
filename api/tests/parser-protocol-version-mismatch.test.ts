import { test, expect } from "bun:test";
import { detectProtocolVersionMismatches } from "../src/parser/type-parser.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

// B3 pin-and-assert. The pure detector is the verifiable core (warnings aren't
// asserted by test:fast, so we exercise the function directly + one wiring check).

test("flags a major.minor mismatch (mpl-token-metadata 4.x vs pinned 5.1)", () => {
  expect(detectProtocolVersionMismatches(`mpl-token-metadata = "4.1.2"`)).toEqual([
    { crate: "mpl-token-metadata", found: "4.1.2", pinned: "5.1" },
  ]);
});

test("same major.minor (different patch) is NOT a mismatch", () => {
  expect(detectProtocolVersionMismatches(`mpl-token-metadata = "5.1.9"`)).toEqual([]);
});

test("extended `{ version = ... }` form detected; anchor-spl 0.30 != 0.31", () => {
  expect(
    detectProtocolVersionMismatches(`anchor-spl = { version = "0.30", features = ["metadata"] }`),
  ).toEqual([{ crate: "anchor-spl", found: "0.30", pinned: "0.31" }]);
});

test("=/^ version prefixes are normalized before comparing", () => {
  expect(detectProtocolVersionMismatches(`pyth-sdk-solana = "=0.10.4"`)).toEqual([]);
  expect(detectProtocolVersionMismatches(`pyth-sdk-solana = "^0.11"`)).toEqual([
    { crate: "pyth-sdk-solana", found: "^0.11", pinned: "0.10" },
  ]);
});

test("no pinned protocol dep in source → no findings (anchor-lang is handled separately)", () => {
  expect(detectProtocolVersionMismatches(`anchor-lang = "0.31"\nsolana-program = "1.18"`)).toEqual([]);
});

test("parseAnchor raises protocol_version_mismatch when the source carries a mismatched dep", async () => {
  const src = `
// Cargo.toml deps (carried in the flattened source):
// mpl-token-metadata = "4.1.0"
use anchor_lang::prelude::*;
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
#[program]
pub mod p { use super::*; pub fn go(ctx: Context<Go>) -> Result<()> { Ok(()) } }
#[derive(Accounts)]
pub struct Go<'info> { pub signer: Signer<'info> }
`;
  const r = await parseAnchor(src);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const w = (r.ir.warnings ?? []).find((x) => x.code === "protocol_version_mismatch");
  expect(w).toBeDefined();
  expect(w?.message).toContain("mpl-token-metadata");
});
