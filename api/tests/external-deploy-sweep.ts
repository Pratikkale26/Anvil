import { TEST_SCRATCH } from "./scratch-root.ts";
/**
 * External-repos deploy sweep — for each external program that built cleanly
 * via /build, also build Anchor reference + Anvil-Pinocchio + Anvil-Native
 * .so files, deploy ALL THREE to the localhost:8899 validator, and report
 * per-target deploy success.
 *
 * Programs: arjun-counterapp, arjun-pda, arjun-p-nft (the 3 that passed
 * /build for both Anvil targets in external-repos-sweep.json).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const API = process.env.ANVIL_API ?? "http://localhost:8080";
const RPC = process.env.ANVIL_RPC ?? "http://localhost:8899";
const PAYER_KP = process.env.ANVIL_PAYER_KP ?? `${process.env.HOME}/.config/solana/id.json`;
const SCRATCH = join(TEST_SCRATCH, "anvil-external-deploy");

const PROGRAMS = [
  {
    name: "arjun-counterapp",
    libPath: join(TEST_SCRATCH, "anvil-external-repos", "solana-programs-list/anchor-counterapp/programs/anchor-counterapp/src/lib.rs"),
    programName: "anchor_counterapp",
  },
  {
    name: "arjun-pda",
    libPath: join(TEST_SCRATCH, "anvil-external-repos", "solana-programs-list/anchor-pda/programs/anchor-pda/src/lib.rs"),
    programName: "anchor_pda",
  },
  {
    name: "arjun-p-nft",
    libPath: join(TEST_SCRATCH, "anvil-external-repos", "solana-programs-list/anchor-p-nft/programs/anchor-p-nft/src/lib.rs"),
    programName: "anchor_p_nft",
  },
];

mkdirSync(SCRATCH, { recursive: true });

async function postJson(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

interface BuildResult { ok: boolean; soPath?: string; error?: string }

async function buildAnvilSo(programName: string, source: string, target: "pinocchio" | "native"): Promise<BuildResult> {
  const parse = await postJson("/parse", { source });
  if (!parse.ir) return { ok: false, error: `parse: ${JSON.stringify(parse).slice(0, 200)}` };
  const emit = await postJson("/emit", { ir: parse.ir, target, multiFile: true });
  if (!emit.files) return { ok: false, error: `emit: ${JSON.stringify(emit).slice(0, 200)}` };
  // Write to a scratch project, run cargo-build-sbf
  const scratchDir = join(SCRATCH, `${programName}-${target}`);
  spawnSync("rm", ["-rf", scratchDir], { encoding: "utf8" });
  mkdirSync(scratchDir, { recursive: true });
  // Build the cargo project scaffold
  const scaffoldBody = { ir: parse.ir, target, multiFile: true, projectScaffold: true };
  const scaffold = await postJson("/emit", scaffoldBody);
  const files = scaffold.files ?? emit.files;
  for (const f of files) {
    const dest = join(scratchDir, f.path);
    mkdirSync(join(scratchDir, f.path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(dest, f.content);
  }
  // cargo-build-sbf
  const t0 = Date.now();
  const r = spawnSync("cargo-build-sbf", [], {
    cwd: scratchDir,
    encoding: "utf8",
    timeout: 600_000,
  });
  const took = Date.now() - t0;
  if (r.status !== 0) {
    return { ok: false, error: `cargo-build-sbf ${took}ms: ${(r.stderr ?? "").slice(-400)}` };
  }
  // Find the .so
  const targetDir = join(scratchDir, "target", "deploy");
  const soName = `${programName.replace(/-/g, "_")}.so`;
  const soPath = join(targetDir, soName);
  if (!existsSync(soPath)) {
    // try other names
    const alt = spawnSync("find", [targetDir, "-name", "*.so"], { encoding: "utf8" });
    const found = (alt.stdout ?? "").trim().split("\n").filter(Boolean);
    if (found.length === 0) return { ok: false, error: `no .so produced in ${targetDir}` };
    return { ok: true, soPath: found[0] };
  }
  return { ok: true, soPath };
}

async function buildAnchorSo(programName: string, source: string): Promise<BuildResult> {
  const scratchDir = join(SCRATCH, `${programName}-anchor`);
  spawnSync("rm", ["-rf", scratchDir], { encoding: "utf8" });
  const progDir = join(scratchDir, "programs", programName);
  mkdirSync(join(progDir, "src"), { recursive: true });
  writeFileSync(join(progDir, "src", "lib.rs"), source);
  writeFileSync(
    join(progDir, "Cargo.toml"),
    `[package]\nname = "${programName}"\nversion = "0.1.0"\nedition = "2021"\n[lib]\ncrate-type = ["cdylib", "lib"]\nname = "${programName.replace(/-/g, "_")}"\n[features]\ndefault = []\n[dependencies]\nanchor-lang = "0.31"\nanchor-spl = { version = "0.31", features = ["mpl-token-metadata"] }\nmpl-token-metadata = "5.1.0"\n`,
  );
  writeFileSync(
    join(scratchDir, "Cargo.toml"),
    `[workspace]\nresolver = "2"\nmembers = ["programs/${programName}"]\n`,
  );
  const t0 = Date.now();
  const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(progDir, "Cargo.toml")], {
    cwd: scratchDir,
    encoding: "utf8",
    timeout: 600_000,
  });
  const took = Date.now() - t0;
  if (r.status !== 0) {
    return { ok: false, error: `anchor cargo-build-sbf ${took}ms: ${(r.stderr ?? "").slice(-400)}` };
  }
  const soPath = join(scratchDir, "target", "deploy", `${programName.replace(/-/g, "_")}.so`);
  if (!existsSync(soPath)) {
    const find = spawnSync("find", [scratchDir, "-name", "*.so"], { encoding: "utf8" });
    const found = (find.stdout ?? "").trim().split("\n").filter(Boolean);
    if (found.length === 0) return { ok: false, error: "no .so produced" };
    return { ok: true, soPath: found[0] };
  }
  return { ok: true, soPath };
}

async function deploy(soPath: string, label: string): Promise<{ ok: boolean; programId?: string; error?: string }> {
  const programKp = Keypair.generate();
  const kpPath = join(SCRATCH, `kp-${label}-${programKp.publicKey.toBase58().slice(0, 8)}.json`);
  writeFileSync(kpPath, JSON.stringify(Array.from(programKp.secretKey)));
  const r = spawnSync("solana", [
    "program", "deploy",
    "--keypair", PAYER_KP,
    "--program-id", kpPath,
    "--url", RPC,
    soPath,
  ], { encoding: "utf8", timeout: 300_000 });
  if (r.status !== 0) return { ok: false, error: (r.stderr ?? "").slice(-300) };
  return { ok: true, programId: programKp.publicKey.toBase58() };
}

interface ProgramResult {
  name: string;
  anchor: { build: any; deploy?: any };
  pinocchio: { build: any; deploy?: any };
  native: { build: any; deploy?: any };
}

const results: ProgramResult[] = [];
for (const prog of PROGRAMS) {
  process.stderr.write(`\n[${prog.name}]\n`);
  const source = readFileSync(prog.libPath, "utf8");
  const r: ProgramResult = { name: prog.name, anchor: { build: null }, pinocchio: { build: null }, native: { build: null } };

  process.stderr.write("  anchor build ... ");
  const anchorBuild = await buildAnchorSo(prog.programName, source);
  r.anchor.build = anchorBuild;
  process.stderr.write(anchorBuild.ok ? `OK (${anchorBuild.soPath?.slice(-60)})\n` : `FAIL: ${anchorBuild.error?.slice(0, 100)}\n`);
  if (anchorBuild.ok) {
    process.stderr.write("  anchor deploy ... ");
    r.anchor.deploy = await deploy(anchorBuild.soPath!, `${prog.name}-anchor`);
    process.stderr.write(r.anchor.deploy.ok ? `${r.anchor.deploy.programId}\n` : `FAIL: ${r.anchor.deploy.error?.slice(0, 100)}\n`);
  }

  process.stderr.write("  pinocchio build ... ");
  const pinBuild = await buildAnvilSo(prog.programName, source, "pinocchio");
  r.pinocchio.build = pinBuild;
  process.stderr.write(pinBuild.ok ? `OK\n` : `FAIL: ${pinBuild.error?.slice(0, 100)}\n`);
  if (pinBuild.ok) {
    process.stderr.write("  pinocchio deploy ... ");
    r.pinocchio.deploy = await deploy(pinBuild.soPath!, `${prog.name}-pin`);
    process.stderr.write(r.pinocchio.deploy.ok ? `${r.pinocchio.deploy.programId}\n` : `FAIL: ${r.pinocchio.deploy.error?.slice(0, 100)}\n`);
  }

  process.stderr.write("  native build ... ");
  const natBuild = await buildAnvilSo(prog.programName, source, "native");
  r.native.build = natBuild;
  process.stderr.write(natBuild.ok ? `OK\n` : `FAIL: ${natBuild.error?.slice(0, 100)}\n`);
  if (natBuild.ok) {
    process.stderr.write("  native deploy ... ");
    r.native.deploy = await deploy(natBuild.soPath!, `${prog.name}-nat`);
    process.stderr.write(r.native.deploy.ok ? `${r.native.deploy.programId}\n` : `FAIL: ${r.native.deploy.error?.slice(0, 100)}\n`);
  }

  results.push(r);
}

// Repo root derived from this file's location (api/tests/) so the report
// lands under <checkout>/reports on any machine, not a hardcoded home dir.
const outPath = join(import.meta.dir, "..", "..", "reports", "external-deploy-sweep.json");
writeFileSync(outPath, JSON.stringify(results, null, 2));
process.stderr.write(`\n[external-deploy] report → ${outPath}\n`);
