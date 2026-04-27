#!/usr/bin/env bun
/**
 * Measure real compute units on solana-test-validator.
 *
 * Compares the Anchor original counter program against the Anvil-emitted
 * Pinocchio version. Unlike the differential test (which uses litesvm
 * with a fixed PROGRAM_ID === declare_id!()), this script deploys to
 * solana-test-validator which assigns program IDs from a keypair file —
 * so we have to patch declare_id!() in the source to match the keypair
 * before building each .so. Without that patch, Anchor's runtime check
 * raises DeclaredProgramIdMismatch (error 0x1004 / 4100).
 *
 * Usage:
 *   solana-test-validator --reset --quiet &     # Terminal 1
 *   bun scripts/measure-cu.ts                    # Terminal 2
 *
 * Output:
 *   counter::increment(amount=5) — measured CU
 *     Anchor:           412 CU
 *     Anvil-Pinocchio:  148 CU
 *     Savings:          64%
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  type AccountMeta,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseAnchor } from "../api/src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.js";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.js";

const RPC = process.env.ANVIL_VALIDATOR_RPC ?? "http://localhost:8899";
const COUNTER_SRC = "/home/pk/Anvil/api/src/demo-programs/counter.rs";
const SOLANA_ID_PATH = join(process.env.HOME ?? "", ".config/solana/id.json");

async function main(): Promise<void> {
  if (!existsSync(SOLANA_ID_PATH)) {
    fail(`Default keypair not found at ${SOLANA_ID_PATH}. Generate with:\n  solana-keygen new --no-bip39-passphrase --force`);
  }
  const payer = loadKeypair(SOLANA_ID_PATH);

  const conn = new Connection(RPC, "confirmed");
  await conn.getLatestBlockhash().catch(() => {
    fail(`Cannot reach validator at ${RPC}. Start with:\n  solana-test-validator --reset --quiet`);
  });

  if ((await conn.getBalance(payer.publicKey)) < 100_000_000_000) {
    console.log(`[measure-cu] funding payer ${payer.publicKey.toBase58().slice(0, 8)}…`);
    await airdrop(conn, payer.publicKey, 100);
  }

  const counterSource = readFileSync(COUNTER_SRC, "utf-8");

  // Build + deploy each side with a freshly-generated program keypair so
  // Anchor's declare_id!() check passes against the actual deploy ID.
  const tmpRoot = mkdtempSync(join(tmpdir(), "anvil-cu-measure-"));
  try {
    console.log("[measure-cu] Building Anchor .so with patched declare_id!()…");
    const { soPath: anchorSo, programId: anchorPid } = await buildAnchorWithFreshId(counterSource, join(tmpRoot, "anchor"));
    console.log(`[measure-cu] Anchor program ID:  ${anchorPid.toBase58()}`);

    console.log("[measure-cu] Building Anvil-Pinocchio .so with patched declare_id!()…");
    const { soPath: anvilSo, programId: anvilPid } = await buildAnvilWithFreshId(counterSource, join(tmpRoot, "anvil"));
    console.log(`[measure-cu] Anvil-Pinocchio ID:  ${anvilPid.toBase58()}`);

    console.log("[measure-cu] Deploying both…");
    await deploySo(anchorSo, anchorPid, payer);
    await deploySo(anvilSo, anvilPid, payer);

    console.log("[measure-cu] Running scenario against each…\n");
    const anchorCU = await runAndMeasure(conn, payer, anchorPid, "Anchor");
    const anvilCU = await runAndMeasure(conn, payer, anvilPid, "Anvil-Pinocchio");

    const initSaved = pct(anchorCU.initialize, anvilCU.initialize);
    const incSaved = pct(anchorCU.increment, anvilCU.increment);

    console.log("\n┌─────────────────────────────────────────────────────────┐");
    console.log("│  counter::initialize(start_value=10) — measured CU      │");
    console.log("├─────────────────────────────────────────────────────────┤");
    console.log(`│  Anchor:           ${anchorCU.initialize.toString().padStart(6)} CU                       │`);
    console.log(`│  Anvil-Pinocchio:  ${anvilCU.initialize.toString().padStart(6)} CU  (${initSaved.padStart(5)} saved)         │`);
    console.log("├─────────────────────────────────────────────────────────┤");
    console.log("│  counter::increment(amount=5) — measured CU             │");
    console.log("├─────────────────────────────────────────────────────────┤");
    console.log(`│  Anchor:           ${anchorCU.increment.toString().padStart(6)} CU                       │`);
    console.log(`│  Anvil-Pinocchio:  ${anvilCU.increment.toString().padStart(6)} CU  (${incSaved.padStart(5)} saved)         │`);
    console.log("└─────────────────────────────────────────────────────────┘");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function pct(anchor: number, anvil: number): string {
  if (anchor === 0) return "n/a";
  return `${Math.round((1 - anvil / anchor) * 100)}%`;
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf-8"))));
}

async function airdrop(conn: Connection, pubkey: PublicKey, sol: number): Promise<void> {
  const sig = await conn.requestAirdrop(pubkey, sol * 1_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
}

function patchDeclareId(source: string, newPubkey: string): string {
  const re = /declare_id!\s*\(\s*"[^"]+"\s*\)/;
  if (!re.test(source)) {
    fail(`Could not find declare_id!("...") in source.`);
  }
  return source.replace(re, `declare_id!("${newPubkey}")`);
}

async function buildAnchorWithFreshId(
  source: string,
  scratchDir: string,
): Promise<{ soPath: string; programId: PublicKey }> {
  const programKp = Keypair.generate();
  const patchedSource = patchDeclareId(source, programKp.publicKey.toBase58());

  mkdirSync(join(scratchDir, "src"), { recursive: true });
  writeFileSync(join(scratchDir, "Cargo.toml"), `[package]
name = "counter_anchor_cu"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "counter_anchor_cu"
[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
[dependencies]
anchor-lang = "0.31"
`);
  writeFileSync(join(scratchDir, "src/lib.rs"), patchedSource);

  const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(scratchDir, "Cargo.toml")], {
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env, RUSTFLAGS: "" },
  });
  if (r.status !== 0) fail(`cargo build-sbf (Anchor) failed with status ${r.status}`);

  const so = readSoFromDir(join(scratchDir, "target/deploy"));
  // Persist the keypair so deploySo can use it.
  const kpPath = join(scratchDir, "program-keypair.json");
  writeFileSync(kpPath, JSON.stringify(Array.from(programKp.secretKey)));
  return { soPath: so, programId: programKp.publicKey };
}

async function buildAnvilWithFreshId(
  source: string,
  scratchDir: string,
): Promise<{ soPath: string; programId: PublicKey }> {
  const programKp = Keypair.generate();
  const patchedSource = patchDeclareId(source, programKp.publicKey.toBase58());

  const parsed = await parseAnchor(patchedSource);
  if (!parsed.ok) fail(`parseAnchor failed: ${parsed.error}`);
  const out = emitPinocchioFull(parsed.ir);
  const scaffoldMeta = buildProjectScaffold(parsed.ir, "pinocchio");

  mkdirSync(scratchDir, { recursive: true });
  for (const f of scaffoldMeta) {
    const p = join(scratchDir, f.path);
    mkdirSync(dirOf(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }
  for (const f of out.files) {
    const p = join(scratchDir, "src", f.path);
    mkdirSync(dirOf(p), { recursive: true });
    writeFileSync(p, f.content, "utf-8");
  }

  const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(scratchDir, "Cargo.toml")], {
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env, RUSTFLAGS: "" },
  });
  if (r.status !== 0) fail(`cargo build-sbf (Anvil) failed with status ${r.status}`);

  const so = readSoFromDir(join(scratchDir, "target/deploy"));
  const kpPath = join(scratchDir, "program-keypair.json");
  writeFileSync(kpPath, JSON.stringify(Array.from(programKp.secretKey)));
  return { soPath: so, programId: programKp.publicKey };
}

function readSoFromDir(dir: string): string {
  const entries = readdirSync(dir).filter((f) => f.endsWith(".so"));
  if (entries.length === 0) fail(`no .so found in ${dir}`);
  return join(dir, entries[0]!);
}

function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf("/"));
}

async function deploySo(soPath: string, programId: PublicKey, _payer: Keypair): Promise<void> {
  // The program-keypair.json sits next to the .so (in scratchDir, not target/deploy).
  // It's two dirs up from the .so: target/deploy/X.so → scratchDir/program-keypair.json
  const programKpPath = join(soPath.replace(/target\/deploy\/[^/]+\.so$/, ""), "program-keypair.json");
  const r = spawnSync(
    "solana",
    [
      "program", "deploy", soPath,
      "--program-id", programKpPath,
      "--keypair", SOLANA_ID_PATH,
      "--url", RPC,
      "--commitment", "confirmed",
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 },
  );
  if (r.status !== 0) {
    const out = (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
    fail(`solana program deploy failed for ${programId.toBase58().slice(0, 8)}: ${out.slice(-500)}`);
  }
}

async function runAndMeasure(
  conn: Connection,
  payer: Keypair,
  programId: PublicKey,
  label: string,
): Promise<{ initialize: number; increment: number }> {
  const authority = Keypair.generate();
  await airdrop(conn, authority.publicKey, 2);

  const [counterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), authority.publicKey.toBuffer()],
    programId,
  );

  const initIx = makeIx(programId, discriminator("initialize"), encodeU64(10n), [
    meta(counterPda, false, true),
    meta(authority.publicKey, true, true),
    meta(SystemProgram.programId, false, false),
  ]);
  const incIx = makeIx(programId, discriminator("increment"), encodeU64(5n), [
    meta(counterPda, false, true),
    meta(authority.publicKey, true, false),
  ]);

  const initCU = await sendAndExtractCU(conn, payer, authority, initIx, programId, label, "initialize");
  const incCU = await sendAndExtractCU(conn, payer, authority, incIx, programId, label, "increment");
  return { initialize: initCU, increment: incCU };
}

async function sendAndExtractCU(
  conn: Connection,
  payer: Keypair,
  authority: Keypair,
  ix: TransactionInstruction,
  programId: PublicKey,
  programLabel: string,
  ixLabel: string,
): Promise<number> {
  const tx = new Transaction().add(ix);
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, authority);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");
  const txInfo = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const logs = txInfo?.meta?.logMessages ?? [];
  const cuLine = logs.find((l) => l.includes(`Program ${programId.toBase58()}`) && l.includes("consumed"));
  if (!cuLine) {
    console.warn(`[${programLabel}/${ixLabel}] no consumed-CU log line. Logs:\n${logs.join("\n")}`);
    return 0;
  }
  const m = cuLine.match(/consumed (\d+) of/);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

function discriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}
function encodeU64(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn);
  return out;
}
function makeIx(programId: PublicKey, disc: Uint8Array, data: Uint8Array, accounts: AccountMeta[]): TransactionInstruction {
  const buf = new Uint8Array(disc.length + data.length);
  buf.set(disc, 0);
  buf.set(data, disc.length);
  return new TransactionInstruction({ programId, keys: accounts, data: Buffer.from(buf) });
}
function meta(pubkey: PublicKey, isSigner: boolean, isWritable: boolean): AccountMeta {
  return { pubkey, isSigner, isWritable };
}
function fail(msg: string): never {
  console.error(`[measure-cu] ${msg}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
