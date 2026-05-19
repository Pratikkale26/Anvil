/**
 * Phase C — real validator deploy + differential test on :8899.
 *
 * Builds both the Anchor reference .so AND the Anvil-Pinocchio emit .so
 * from a single source, deploys both to the local solana-test-validator,
 * sends a parallel instruction sequence to each, and byte-compares the
 * resulting account state via RPC.
 *
 * This is the "real validator" leg of the diff-arc: LiteSVM in-process
 * tests (existing differential-harness) verify byte-equal under a fake
 * runtime; this script proves the bytecode + emit hold up against the
 * actual SBF runtime + RPC.
 *
 * Steps:
 *   1. Pre-flight: solana RPC reachable + payer has SOL
 *   2. Compile Anchor reference via `anchor build` (or `cargo build-sbf`)
 *   3. Compile Anvil emit via runBuild("pinocchio", ...) build-sbf mode
 *   4. Deploy each .so under a fresh keypair → record program IDs
 *   5. Patch declare_id! in BOTH sources (Anchor on-disk; Anvil at parse-time)
 *      so PDA derivation aligns with the actual program ID for each side
 *   6. Run the scenario steps in parallel-keyed-namespace (each side has
 *      its own accounts derived from its program ID)
 *   7. byte-compare account data after each step
 *
 * Initial slate: composite + counter-style basic. Expand as time permits.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { parseAnchor } from "../api/src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.ts";
import { runBuild } from "../api/src/build/build-runner.ts";

const RPC = process.env.ANVIL_RPC ?? "http://localhost:8899";
const PAYER_KEYPAIR = process.env.ANVIL_PAYER_KEYPAIR
  ?? `${process.env.HOME}/.config/solana/id.json`;
const OUT_DIR = "/home/pk/Anvil/reports/diff-arc-2026-05-19";

interface DeployResult {
  programId: PublicKey;
  soPath: string;
}

function loadPayer(): Keypair {
  const raw = JSON.parse(readFileSync(PAYER_KEYPAIR, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function ensureRpc(conn: Connection): Promise<void> {
  const health = await conn.getHealth();
  if (health !== "ok") throw new Error(`RPC unhealthy: ${health}`);
}

function solanaCli(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("solana", args, { cwd, encoding: "utf8", timeout: 120_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function buildAnchorSo(name: string, source: string, scratchDir: string): string {
  // Write source to a minimal scaffold + `anchor build`. Pre-existing
  // differential-harness builds Anchor refs this way; mirror the pattern.
  mkdirSync(`${scratchDir}/programs/${name}/src`, { recursive: true });
  writeFileSync(`${scratchDir}/programs/${name}/src/lib.rs`, source);
  writeFileSync(
    `${scratchDir}/programs/${name}/Cargo.toml`,
    `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\nname = "${name.replace(/-/g, "_")}"\n[dependencies]\nanchor-lang = "0.31"\n`,
  );
  writeFileSync(
    `${scratchDir}/Cargo.toml`,
    `[workspace]\nresolver = "2"\nmembers = ["programs/${name}"]\n`,
  );
  writeFileSync(
    `${scratchDir}/Anchor.toml`,
    `[programs.localnet]\n${name.replace(/-/g, "_")} = "11111111111111111111111111111111"\n[provider]\ncluster = "localnet"\nwallet = "${PAYER_KEYPAIR}"\n[scripts]\ntest = "echo test"\n`,
  );
  const build = spawnSync("anchor", ["build"], {
    cwd: scratchDir,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (build.status !== 0) {
    console.error("anchor build failed:");
    console.error(build.stdout);
    console.error(build.stderr);
    throw new Error("anchor build failed for " + name);
  }
  const soPath = `${scratchDir}/target/deploy/${name.replace(/-/g, "_")}.so`;
  if (!existsSync(soPath)) throw new Error(`anchor .so not produced at ${soPath}`);
  return soPath;
}

async function buildAnvilSo(name: string, source: string, scratchDir: string): Promise<string> {
  const parsed = await parseAnchor(source);
  if (!parsed.ok) throw new Error(`anvil parse failed: ${parsed.error}`);
  const emit = emitPinocchioFull(parsed.ir);
  const scaffold = buildProjectScaffold(parsed.ir, "pinocchio");
  const programFiles: { path: string; content: string }[] = [
    { path: "src/lib.rs", content: emit.code },
  ];
  if (emit.files) {
    for (const f of emit.files) {
      if (f.path === "src/lib.rs") continue;
      programFiles.push({ path: f.path, content: f.content });
    }
  }
  const allFiles = [...scaffold, ...programFiles];
  // Write to scratch dir for visibility
  mkdirSync(scratchDir, { recursive: true });
  for (const f of allFiles) {
    const fullPath = join(scratchDir, f.path);
    mkdirSync(join(scratchDir, f.path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(fullPath, f.content);
  }
  // runBuild handles its own scratch dir cache, but we want the .so back.
  const buildResult = await runBuild("pinocchio", allFiles, parsed.ir.programName ?? name, "build-sbf", {});
  if (!buildResult.ok) {
    throw new Error(`anvil build-sbf failed (${buildResult.errors.length} errors): ${buildResult.errors.slice(0, 3).map((e) => e.message).join(" | ")}`);
  }
  // runBuild's own scratch is under ~/.anvil-diff-cache; the .so lands at
  // target/sbpf-solana-solana/release/anvil-build.so. Locate it.
  // Find the most recent matching .so under the anvil cache.
  const cache = `${process.env.HOME}/.anvil-diff-cache`;
  const find = spawnSync("find", [cache, "-name", "anvil-build.so", "-newer", `${cache}/.`], { encoding: "utf8" });
  const candidates = (find.stdout ?? "").split("\n").filter((s) => s.length > 0);
  if (candidates.length === 0) throw new Error("anvil .so not found in cache");
  // Newest first
  candidates.sort((a, b) => {
    const sa = spawnSync("stat", ["-c", "%Y", a], { encoding: "utf8" }).stdout.trim();
    const sb = spawnSync("stat", ["-c", "%Y", b], { encoding: "utf8" }).stdout.trim();
    return Number(sb) - Number(sa);
  });
  return candidates[0]!;
}

async function deploy(soPath: string, payer: Keypair, conn: Connection): Promise<DeployResult> {
  const programKp = Keypair.generate();
  // solana program deploy --keypair <payer> --program-id <programKp> <so>
  const programKpPath = `/tmp/anvil-diff-arc/kp-${programKp.publicKey.toBase58().slice(0, 8)}.json`;
  writeFileSync(programKpPath, JSON.stringify(Array.from(programKp.secretKey)));
  const r = solanaCli([
    "program", "deploy",
    "--keypair", PAYER_KEYPAIR,
    "--program-id", programKpPath,
    "--url", RPC,
    soPath,
  ]);
  if (!r.ok) {
    console.error("solana program deploy failed:");
    console.error(r.stdout);
    console.error(r.stderr);
    throw new Error("deploy failed: " + soPath);
  }
  // Confirm
  const acct = await conn.getAccountInfo(programKp.publicKey);
  if (!acct) throw new Error("deployed account not found: " + programKp.publicKey.toBase58());
  return { programId: programKp.publicKey, soPath };
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  await ensureRpc(conn);
  const payer = loadPayer();
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`payer ${payer.publicKey.toBase58()} balance: ${bal / 1e9} SOL`);
  if (bal < 1e9) throw new Error("payer has < 1 SOL; airdrop first");

  // Target: composite — H1 unblock proof
  const COMPOSITE_SRC = readFileSync(
    "/tmp/anvil-diff-arc/repos/anchor-org/tests/composite/programs/composite/src/lib.rs",
    "utf8",
  );

  const ANCHOR_SCRATCH = "/tmp/anvil-diff-arc/scratch-anchor-composite";
  const ANVIL_SCRATCH = "/tmp/anvil-diff-arc/scratch-anvil-composite";

  console.log("\n=== Building Anchor reference .so ===");
  let anchorSo: string;
  try {
    anchorSo = buildAnchorSo("composite", COMPOSITE_SRC, ANCHOR_SCRATCH);
    console.log("  Anchor .so:", anchorSo);
  } catch (e) {
    console.error("  Anchor build FAILED:", e);
    writeFileSync(join(OUT_DIR, "PHASE-C-RESULT.md"), `# Phase C — composite\n\nFAILED at Anchor build:\n\n${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }

  console.log("\n=== Building Anvil emit .so ===");
  let anvilSo: string;
  try {
    anvilSo = await buildAnvilSo("composite", COMPOSITE_SRC, ANVIL_SCRATCH);
    console.log("  Anvil .so:", anvilSo);
  } catch (e) {
    console.error("  Anvil build FAILED:", e);
    writeFileSync(join(OUT_DIR, "PHASE-C-RESULT.md"), `# Phase C — composite\n\nFAILED at Anvil build:\n\n${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }

  console.log("\n=== Deploying both to :8899 ===");
  const anchor = await deploy(anchorSo, payer, conn);
  console.log("  Anchor programId:", anchor.programId.toBase58());
  const anvil = await deploy(anvilSo, payer, conn);
  console.log("  Anvil  programId:", anvil.programId.toBase58());

  // For composite the instructions are:
  //   initialize() — zero-init two #[account(zero)] accounts (caller-supplied keys)
  //   composite_update(dummy_a: u64, dummy_b: u64)
  //
  // The differential test needs to know how to call these.  For a smoke
  // test, we just confirm both deploys succeeded; the comprehensive
  // tx-level differential test is a follow-up that needs per-program
  // scenario synth (re-use api/src/build/auto-scenario.ts here).
  console.log("\n=== Smoke OK — both programs deployed on :8899 ===");
  writeFileSync(
    join(OUT_DIR, "PHASE-C-RESULT.md"),
    [
      "# Phase C — composite (real :8899 deploy)",
      "",
      "**Source:** Anchor org composite example (post-H1).",
      "",
      "**Result:** SMOKE_OK — both .so files compiled + deployed to localhost:8899.",
      "",
      `**Anchor programId:** \`${anchor.programId.toBase58()}\``,
      `**Anvil  programId:** \`${anvil.programId.toBase58()}\``,
      `**Anchor .so:** \`${anchorSo}\``,
      `**Anvil  .so:** \`${anvilSo}\``,
      "",
      "## What's proven",
      "- H1 composite-Accounts flatten produces SBF bytecode the real runtime accepts.",
      "- Anvil's emit + buildProjectScaffold deploys cleanly to localhost:8899 (no LiteSVM).",
      "- Two programs co-exist on the same validator with distinct program IDs.",
      "",
      "## What's NOT yet proven",
      "- Transaction-level differential equality on instruction execution.",
      "- The scenario-runner harness (currently LiteSVM-only) needs porting",
      "  to send via @solana/web3.js for full Phase C coverage. This is a",
      "  follow-up.",
      "",
      "## Reproduce",
      "```",
      "bun run scripts/phase-c-deploy-verify.ts",
      "```",
    ].join("\n") + "\n",
  );
}

main().catch((err) => {
  console.error("Phase C FATAL:", err);
  writeFileSync(
    join(OUT_DIR, "PHASE-C-RESULT.md"),
    `# Phase C — FATAL\n\n${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
