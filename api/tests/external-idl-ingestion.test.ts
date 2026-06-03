/**
 * #2 / S4 #8 — production IDL ingestion. The declare_program! CPI rewrite only
 * fires when ParseOptions.externalIdls is supplied; these tests prove the /parse
 * ingestion paths collect idls/<crate>.json and deliver it, so real users'
 * declare_program! programs transpile (not just the differential fixture).
 *   - collectExternalIdls: scans a file set for idls/<crate>.json (skips non-idl
 *     JSON + malformed), keyed by crate.
 *   - end-to-end via resolveLocalSource: a project dir with idls/external.json →
 *     the caller's external::cpi::update is rewritten; WITHOUT idls/ it stays
 *     loud-refused (fail-closed).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectExternalIdls } from "../src/parser/external-cpi.ts";
import { resolveLocalSource } from "../src/parser/local-source.ts";
import { parseAnchor } from "../src/parser/anchor-parser.ts";

const EXT_IDL = {
  address: "Externa111111111111111111111111111111111111",
  metadata: { name: "external" },
  instructions: [
    {
      name: "update",
      discriminator: [219, 200, 88, 176, 158, 63, 253, 127],
      accounts: [{ name: "authority", signer: true }, { name: "my_account", writable: true }],
      args: [{ name: "value", type: "u32" }],
    },
  ],
};

const CALLER = `use anchor_lang::prelude::*;
declare_id!("Dec1areProgram11111111111111111111111111111");
declare_program!(external);
use external::program::External;
#[program] pub mod cpi_caller {
  use super::*;
  pub fn do_update(ctx: Context<DoUpdate>, value: u32) -> Result<()> {
    let cpi_ctx = CpiContext::new(ctx.accounts.external_program.key(),
      external::cpi::accounts::Update { authority: ctx.accounts.authority.to_account_info(), my_account: ctx.accounts.my_account.to_account_info() });
    external::cpi::update(cpi_ctx, value)?;
    Ok(())
  }
}
#[derive(Accounts)] pub struct DoUpdate<'info> {
  pub authority: Signer<'info>,
  #[account(mut)] pub my_account: Account<'info, external::accounts::MyAccount>,
  pub external_program: Program<'info, External>,
}`;

describe("#8 — collectExternalIdls", () => {
  test("collects idls/<crate>.json keyed by crate; skips non-idl + malformed", () => {
    const got = collectExternalIdls([
      { path: "idls/lever.json", content: '{"metadata":{"name":"lever"}}' },
      { path: "programs/x/idls/oracle.json", content: '{"metadata":{"name":"oracle"}}' },
      { path: "src/lib.rs", content: "fn main(){}" },
      { path: "config.json", content: "{}" }, // not under idls/ → ignored
      { path: "idls/broken.json", content: "{not json" }, // malformed → skipped
    ]);
    expect(Object.keys(got).sort()).toEqual(["lever", "oracle"]);
  });
});

describe("#8 — end-to-end ingestion via resolveLocalSource", () => {
  const dirs: string[] = [];
  const mkProject = (withIdl: boolean): string => {
    const root = mkdtempSync(join(tmpdir(), "anvil-idl-ingest-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/lib.rs"), CALLER);
    writeFileSync(join(root, "Cargo.toml"), `[package]\nname="cpi_caller"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nanchor-lang="1.0.0"\n`);
    if (withIdl) {
      mkdirSync(join(root, "idls"), { recursive: true });
      writeFileSync(join(root, "idls/external.json"), JSON.stringify(EXT_IDL));
    }
    return join(root, "src/lib.rs");
  };
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  test("project with idls/external.json → CPI rewritten (canonical present)", async () => {
    const entry = mkProject(true);
    const resolved = resolveLocalSource(entry);
    expect(resolved.externalIdls && Object.keys(resolved.externalIdls)).toEqual(["external"]);
    const r = await parseAnchor(resolved.source, { externalIdls: resolved.externalIdls });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cpi = r.ir.instructions[0]!.body.find((s: { kind: string }) => s.kind === "cpi_custom") as
      | { canonical?: { instruction?: unknown } }
      | undefined;
    expect(cpi?.canonical?.instruction).toBeTruthy();
  });

  test("project WITHOUT idls/ → no externalIdls → loud-refused (fail-closed)", async () => {
    const entry = mkProject(false);
    const resolved = resolveLocalSource(entry);
    expect(resolved.externalIdls).toBeUndefined();
    const r = await parseAnchor(resolved.source, { externalIdls: resolved.externalIdls });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cpi = r.ir.instructions[0]!.body.find((s: { kind: string }) => s.kind === "cpi_custom") as
      | { canonical?: { instruction?: unknown } }
      | undefined;
    expect(cpi?.canonical?.instruction).toBeFalsy();
  });
});
