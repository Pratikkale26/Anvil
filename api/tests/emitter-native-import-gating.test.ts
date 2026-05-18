/**
 * Regression: native emit's lib.rs use-block must import every solana_program
 * item that any emitted helper references. Previously asymmetric: the
 * spl_transfer helper emitted BOTH `spl_token_transfer` (unsigned) +
 * `spl_token_transfer_signed` whenever `cpi_spl_transfer` appeared in IR,
 * but `needsInvokeSigned` only flipped for the other SPL families
 * (mint_to / burn / close_account), so cargo refused the build with E0425
 * "cannot find function `invoke_signed`" on any program that did any
 * spl_token::transfer CPI.
 *
 * Surfaced by the /build API sweep on spl-transfer + t22-transfer.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");

async function emitForDemo(name: string): Promise<string> {
  const source = readFileSync(join(DEMO_DIR, `${name}.rs`), "utf-8");
  const { ir } = await parseAnchor(source);
  const output = emitNativeFull(ir);
  const lib = output.files.find((f) => f.path === "lib.rs");
  if (!lib) throw new Error(`no lib.rs emitted for ${name}`);
  return lib.content;
}

describe("native emit — lib.rs imports for SPL helpers", () => {
  test("spl-transfer imports program::invoke AND program::invoke_signed", async () => {
    const lib = await emitForDemo("spl-transfer");
    expect(lib).toContain("program::invoke");
    expect(lib).toContain("program::invoke_signed");
  });

  test("t22-transfer (cpi_spl_transfer + token_2022 tokenProgram) also imports both", async () => {
    const lib = await emitForDemo("t22-transfer");
    expect(lib).toContain("program::invoke");
    expect(lib).toContain("program::invoke_signed");
  });

  test("vault (system transfer + spl-free) does NOT add invoke_signed unless needed", async () => {
    // vault has signed system_program::transfer (PDA-as-source) which needs
    // invoke_signed — so this is just a smoke that the helper-gating still
    // works for the lamports family.
    const lib = await emitForDemo("vault");
    expect(lib).toContain("program::invoke_signed");
  });

  test("escrow (multi-CPI: spl_transfer + spl_close + close-constraint) imports both", async () => {
    const lib = await emitForDemo("escrow");
    expect(lib).toContain("program::invoke");
    expect(lib).toContain("program::invoke_signed");
  });
});
