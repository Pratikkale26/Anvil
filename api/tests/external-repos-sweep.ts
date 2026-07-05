import { TEST_SCRATCH } from "./scratch-root.ts";
/**
 * External-repos sweep — hits the live API (port 8080) for the 17 Arjun
 * (aarjn/solana-programs-list) demos + attempts the 3 big multi-file
 * programs (drift, klend, raydium-clmm) via projectPath where possible.
 *
 * For each: POST /parse, POST /emit (pin+native), POST /build (pin+native).
 * Records pass/fail per step per target.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const API = process.env.ANVIL_API ?? "http://localhost:8080";
const REPO_ROOT = join(TEST_SCRATCH, "anvil-external-repos");

interface Fixture {
  name: string;
  category: string;
  libPath: string;
  projectPath?: string;
  source?: string;
  programName: string;
}

const ARJUN_PROGRAMS: Fixture[] = [
  // 17 small/medium Arjun demos
  { name: "arjun-nft-metaplex", category: "arjun-mpl", libPath: `${REPO_ROOT}/solana-programs-list/anchor-nft-metaplex/programs/anchor-nft-metaplex/src/lib.rs`, programName: "anchor_nft_metaplex" },
  { name: "arjun-cpi", category: "arjun-cpi", libPath: `${REPO_ROOT}/solana-programs-list/anchor-cpi/programs/cpi/src/lib.rs`, programName: "cpi" },
  { name: "arjun-vault-blueshift", category: "arjun-defi", libPath: `${REPO_ROOT}/solana-programs-list/anchor-vault-blueshift/programs/vault/src/lib.rs`, programName: "vault" },
  { name: "arjun-merkle-tree-incremental", category: "arjun-merkle", libPath: `${REPO_ROOT}/solana-programs-list/anchor-merkle-tree-incremental/programs/anchor/src/lib.rs`, programName: "anchor_merkle_inc" },
  { name: "arjun-escrow-blueshift", category: "arjun-defi", libPath: `${REPO_ROOT}/solana-programs-list/anchor-escrow-blueshift/programs/blueshift_anchor_escrow/src/lib.rs`, programName: "blueshift_anchor_escrow" },
  { name: "arjun-p-nft", category: "arjun-mpl", libPath: `${REPO_ROOT}/solana-programs-list/anchor-p-nft/programs/anchor-p-nft/src/lib.rs`, programName: "anchor_p_nft" },
  { name: "arjun-merkle-tree", category: "arjun-merkle", libPath: `${REPO_ROOT}/solana-programs-list/anchor-merkle-tree/programs/anchor-merkle-tree/src/lib.rs`, programName: "anchor_merkle_tree" },
  { name: "arjun-tic-tac-toe", category: "arjun-game", libPath: `${REPO_ROOT}/solana-programs-list/anchor-tic-tac-toe/programs/anchor-tic-tac-toe/src/lib.rs`, programName: "anchor_tic_tac_toe" },
  { name: "arjun-pda-crud", category: "arjun-pda", libPath: `${REPO_ROOT}/solana-programs-list/anchor-pda-crud/programs/anchor-pda-crud/src/lib.rs`, programName: "anchor_pda_crud" },
  { name: "arjun-arcium-hello-world", category: "arjun-arcium", libPath: `${REPO_ROOT}/solana-programs-list/anchor-arcium-hello-world/programs/hello_world/src/lib.rs`, programName: "hello_world" },
  { name: "arjun-pda", category: "arjun-pda", libPath: `${REPO_ROOT}/solana-programs-list/anchor-pda/programs/anchor-pda/src/lib.rs`, programName: "anchor_pda" },
  { name: "arjun-spl-token", category: "arjun-spl", libPath: `${REPO_ROOT}/solana-programs-list/anchor-spl-token/programs/spl-token/src/lib.rs`, programName: "spl_token_demo" },
  { name: "arjun-collateral-stablecoin", category: "arjun-defi", libPath: `${REPO_ROOT}/solana-programs-list/anchor-collateral-stablecoin/programs/stablecoin/src/lib.rs`, programName: "stablecoin" },
  { name: "arjun-sol-vault", category: "arjun-defi", libPath: `${REPO_ROOT}/solana-programs-list/anchor-sol-vault/programs/anchor-sol-vault/src/lib.rs`, programName: "anchor_sol_vault" },
  { name: "arjun-escrow", category: "arjun-defi", libPath: `${REPO_ROOT}/solana-programs-list/anchor-escrow/programs/escrow/src/lib.rs`, programName: "escrow" },
  { name: "arjun-counterapp", category: "arjun-basic", libPath: `${REPO_ROOT}/solana-programs-list/anchor-counterapp/programs/anchor-counterapp/src/lib.rs`, programName: "anchor_counterapp" },
  { name: "arjun-vault-manager", category: "arjun-defi", libPath: `${REPO_ROOT}/solana-programs-list/anchor-vault-manager/programs/vault-manager/src/lib.rs`, programName: "vault_manager" },
];

const BIG_PROGRAMS: Fixture[] = [
  // Big multi-file Anchor programs — attempt via projectPath
  { name: "drift-protocol", category: "drift", libPath: `${REPO_ROOT}/drift-protocol/programs/drift/src/lib.rs`, projectPath: `${REPO_ROOT}/drift-protocol/programs/drift`, programName: "drift" },
  { name: "kamino-klend", category: "kamino", libPath: `${REPO_ROOT}/kamino-lending/programs/klend/src/lib.rs`, projectPath: `${REPO_ROOT}/kamino-lending/programs/klend`, programName: "kamino_lending" },
  { name: "raydium-clmm", category: "raydium", libPath: `${REPO_ROOT}/raydium-clmm/programs/amm/src/lib.rs`, projectPath: `${REPO_ROOT}/raydium-clmm/programs/amm`, programName: "amm_v3" },
  { name: "openbook-v2", category: "dex", libPath: `${REPO_ROOT}/openbook-v2/programs/openbook-v2/src/lib.rs`, projectPath: `${REPO_ROOT}/openbook-v2/programs/openbook-v2`, programName: "openbook_v2" },
  { name: "marginfi-v2", category: "lending", libPath: `${REPO_ROOT}/marginfi-v2/programs/marginfi/src/lib.rs`, projectPath: `${REPO_ROOT}/marginfi-v2/programs/marginfi`, programName: "marginfi" },
  { name: "marinade", category: "staking", libPath: `${REPO_ROOT}/marinade/programs/marinade-finance/src/lib.rs`, projectPath: `${REPO_ROOT}/marinade/programs/marinade-finance`, programName: "marinade_finance" },
];

type StepResult = { ok: boolean; latencyMs: number; error?: string; size?: number };
type FixtureResult = {
  name: string;
  category: string;
  parse: StepResult;
  emitPin: StepResult;
  emitNative: StepResult;
  buildPin: StepResult;
  buildNative: StepResult;
};

async function post(path: string, body: unknown, attempt = 0): Promise<{ ok: boolean; status: number; json: any; latencyMs: number; errorText?: string }> {
  const start = Date.now();
  try {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - start;
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (res.status === 429 && attempt < 3) {
      await new Promise(r => setTimeout(r, 10_000 * (attempt + 1)));
      return post(path, body, attempt + 1);
    }
    return { ok: res.ok, status: res.status, json, latencyMs, errorText: res.ok ? undefined : text };
  } catch (e) {
    return { ok: false, status: 0, json: null, latencyMs: Date.now() - start, errorText: String(e) };
  }
}

async function runFixture(f: Fixture): Promise<FixtureResult> {
  let source: string | undefined;
  try {
    if (existsSync(f.libPath)) source = readFileSync(f.libPath, "utf8");
  } catch (e) {
    const failed: StepResult = { ok: false, latencyMs: 0, error: `read fail: ${String(e).slice(0, 200)}` };
    return { name: f.name, category: f.category, parse: failed, emitPin: failed, emitNative: failed, buildPin: failed, buildNative: failed };
  }

  // Always try the multi-file path. If a fixture lib.rs sits at
  // `programs/X/src/lib.rs`, the parent of src/ (programs/X) is the
  // project root that contains Cargo.toml and the full module graph.
  // For an explicit projectPath override (the big-3 programs), honor
  // that. For everything else, derive from libPath. The parser falls
  // back to single-file behavior automatically when no mod-decls are
  // present in lib.rs.
  let projectPathToUse = f.projectPath;
  if (!projectPathToUse && f.libPath) {
    // libPath = .../programs/X/src/lib.rs → projectPath = .../programs/X
    const srcDir = f.libPath.replace(/\/src\/lib\.rs$/, "");
    projectPathToUse = srcDir;
  }
  const parseBody = projectPathToUse
    ? { projectPath: projectPathToUse, programName: f.programName }
    : { source };
  const parsed = await post("/parse", parseBody);
  const failedStep: StepResult = { ok: false, latencyMs: 0 };
  if (!parsed.ok || !parsed.json?.ir) {
    return {
      name: f.name, category: f.category,
      parse: { ok: false, latencyMs: parsed.latencyMs, error: parsed.errorText?.slice(0, 400) ?? "parse failed" },
      emitPin: failedStep, emitNative: failedStep, buildPin: failedStep, buildNative: failedStep,
    };
  }
  const ir = parsed.json.ir;
  const parseResult: StepResult = { ok: true, latencyMs: parsed.latencyMs, size: source?.length };

  // /emit pinocchio
  const emitPin = await post("/emit", { ir, target: "pinocchio", multiFile: true });
  const emitPinResult: StepResult = emitPin.ok && emitPin.json?.files
    ? { ok: true, latencyMs: emitPin.latencyMs }
    : { ok: false, latencyMs: emitPin.latencyMs, error: emitPin.errorText?.slice(0, 400) ?? "emit failed" };

  // /emit native
  const emitNat = await post("/emit", { ir, target: "native", multiFile: true });
  const emitNatResult: StepResult = emitNat.ok && emitNat.json?.files
    ? { ok: true, latencyMs: emitNat.latencyMs }
    : { ok: false, latencyMs: emitNat.latencyMs, error: emitNat.errorText?.slice(0, 400) ?? "emit failed" };

  // /build pinocchio
  let buildPinResult: StepResult = { ok: false, latencyMs: 0, error: "skipped — emit failed" };
  if (emitPin.ok && emitPin.json?.files) {
    const buildBody = { target: "pinocchio", files: emitPin.json.files, programName: f.programName };
    const bld = await post("/build", buildBody);
    buildPinResult = bld.ok && bld.json?.ok
      ? { ok: true, latencyMs: bld.latencyMs }
      : { ok: false, latencyMs: bld.latencyMs, error: bld.json?.errors?.[0]?.message?.slice(0, 200) ?? bld.json?.stderrTail?.slice(0, 200) ?? bld.errorText?.slice(0, 200) };
  }

  // /build native
  let buildNatResult: StepResult = { ok: false, latencyMs: 0, error: "skipped — emit failed" };
  if (emitNat.ok && emitNat.json?.files) {
    const buildBody = { target: "native", files: emitNat.json.files, programName: f.programName };
    const bld = await post("/build", buildBody);
    buildNatResult = bld.ok && bld.json?.ok
      ? { ok: true, latencyMs: bld.latencyMs }
      : { ok: false, latencyMs: bld.latencyMs, error: bld.json?.errors?.[0]?.message?.slice(0, 200) ?? bld.json?.stderrTail?.slice(0, 200) ?? bld.errorText?.slice(0, 200) };
  }

  return {
    name: f.name, category: f.category,
    parse: parseResult, emitPin: emitPinResult, emitNative: emitNatResult,
    buildPin: buildPinResult, buildNative: buildNatResult,
  };
}

const ALL = [...ARJUN_PROGRAMS, ...BIG_PROGRAMS];
const results: FixtureResult[] = [];
for (let i = 0; i < ALL.length; i++) {
  const f = ALL[i];
  process.stderr.write(`[external ${i+1}/${ALL.length}] ${f.category}/${f.name} ... `);
  const r = await runFixture(f);
  results.push(r);
  const sym = (s: StepResult) => s.ok ? "Y" : "N";
  process.stderr.write(`parse=${sym(r.parse)} emitPin=${sym(r.emitPin)} emitNat=${sym(r.emitNative)} buildPin=${sym(r.buildPin)} buildNat=${sym(r.buildNative)}\n`);
  if (i < ALL.length - 1) await new Promise(r => setTimeout(r, 2500));
}

writeFileSync("/home/pk/Anvil/reports/external-repos-sweep.json", JSON.stringify(results, null, 2));
process.stderr.write(`[external] report → /home/pk/Anvil/reports/external-repos-sweep.json\n`);
