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
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseAnchor } from "../api/src/parser/anchor-parser.js";
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.js";
import { buildProjectScaffold } from "../api/src/emitter/project-scaffold.js";

const RPC = process.env.ANVIL_VALIDATOR_RPC ?? "http://localhost:8899";
const COUNTER_SRC = "/home/pk/Anvil/api/src/demo-programs/counter.rs";
const ESCROW_SRC = "/home/pk/Anvil/api/src/demo-programs/simple-escrow.rs";
const SOLANA_ID_PATH = join(process.env.HOME ?? "", ".config/solana/id.json");
// Subset selector: comma-separated "counter,escrow" or unset = all.
const FIXTURES = (process.env.ANVIL_CU_FIXTURES ?? "counter,escrow")
  .split(",").map((s) => s.trim()).filter(Boolean);

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

  const tmpRoot = mkdtempSync(join(tmpdir(), "anvil-cu-measure-"));
  // Each entry is one row in the final table.
  const rows: Array<{ ix: string; anchor: number; anvil: number }> = [];
  try {
    if (FIXTURES.includes("counter")) {
      console.log("\n══ counter ════════════════════════════════════════════════");
      const counterSource = readFileSync(COUNTER_SRC, "utf-8");
      const { soPath: anchorSo, programId: anchorPid } =
        await buildAnchorCounter(counterSource, join(tmpRoot, "counter-anchor"));
      const { soPath: anvilSo, programId: anvilPid } =
        await buildAnvilWithFreshId(counterSource, join(tmpRoot, "counter-anvil"));
      console.log(`[counter] Anchor:           ${anchorPid.toBase58()}`);
      console.log(`[counter] Anvil-Pinocchio:  ${anvilPid.toBase58()}`);
      console.log("[counter] Deploying both…");
      await deploySo(anchorSo, anchorPid, payer);
      await deploySo(anvilSo, anvilPid, payer);
      console.log("[counter] Measuring (best of 5 trials)…");
      const anchorCU = await runAndMeasureCounter(conn, payer, anchorPid, "Anchor");
      const anvilCU = await runAndMeasureCounter(conn, payer, anvilPid, "Anvil-Pinocchio");
      rows.push({ ix: "counter::initialize(start_value=10)", anchor: anchorCU.initialize, anvil: anvilCU.initialize });
      rows.push({ ix: "counter::increment(amount=5)",        anchor: anchorCU.increment,  anvil: anvilCU.increment  });
    }

    if (FIXTURES.includes("escrow")) {
      console.log("\n══ escrow ═════════════════════════════════════════════════");
      const escrowSource = readFileSync(ESCROW_SRC, "utf-8");
      const { soPath: anchorSo, programId: anchorPid } =
        await buildAnchorEscrow(escrowSource, join(tmpRoot, "escrow-anchor"));
      const { soPath: anvilSo, programId: anvilPid } =
        await buildAnvilWithFreshId(escrowSource, join(tmpRoot, "escrow-anvil"));
      console.log(`[escrow] Anchor:           ${anchorPid.toBase58()}`);
      console.log(`[escrow] Anvil-Pinocchio:  ${anvilPid.toBase58()}`);
      console.log("[escrow] Deploying both…");
      await deploySo(anchorSo, anchorPid, payer);
      await deploySo(anvilSo, anvilPid, payer);
      console.log("[escrow] Measuring create_escrow (best of 5 trials)…");
      const anchorEscrowCU = await runAndMeasureEscrow(conn, payer, anchorPid, "Anchor");
      const anvilEscrowCU  = await runAndMeasureEscrow(conn, payer, anvilPid,  "Anvil-Pinocchio");
      rows.push({
        ix: "escrow::create_escrow(seed=42, amount=250000)",
        anchor: anchorEscrowCU.createEscrow,
        anvil: anvilEscrowCU.createEscrow,
      });
    }

    if (rows.length === 0) {
      console.warn(`[measure-cu] no fixtures matched ANVIL_CU_FIXTURES=${process.env.ANVIL_CU_FIXTURES}`);
      return;
    }

    // ── Final table.
    const ixWidth = Math.max(...rows.map((r) => r.ix.length), 28) + 2;
    const sep = "─".repeat(ixWidth + 35);
    console.log(`\n┌${sep}┐`);
    console.log(`│  ${"Instruction".padEnd(ixWidth - 2)} ${"Anchor".padStart(8)}  ${"Anvil".padStart(8)}  ${"Saved".padStart(7)}  │`);
    console.log(`├${sep}┤`);
    for (const r of rows) {
      const saved = pct(r.anchor, r.anvil);
      console.log(`│  ${r.ix.padEnd(ixWidth - 2)} ${r.anchor.toString().padStart(8)}  ${r.anvil.toString().padStart(8)}  ${saved.padStart(7)}  │`);
    }
    console.log(`└${sep}┘`);
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

async function buildAnchorCounter(
  source: string,
  scratchDir: string,
): Promise<{ soPath: string; programId: PublicKey }> {
  return buildAnchorScratch(source, scratchDir, "counter_anchor_cu", "");
}

async function buildAnchorEscrow(
  source: string,
  scratchDir: string,
): Promise<{ soPath: string; programId: PublicKey }> {
  // anchor-spl's `associated_token` feature gates the constraint expansion
  // for `init associated_token::*`. Without it, the macro emits broken code.
  return buildAnchorScratch(
    source,
    scratchDir,
    "simple_escrow_anchor_cu",
    `anchor-spl = { version = "0.31", features = ["associated_token"] }`,
  );
}

async function buildAnchorScratch(
  source: string,
  scratchDir: string,
  cratename: string,
  extraDeps: string,
): Promise<{ soPath: string; programId: PublicKey }> {
  const programKp = Keypair.generate();
  const patchedSource = patchDeclareId(source, programKp.publicKey.toBase58());

  mkdirSync(join(scratchDir, "src"), { recursive: true });
  writeFileSync(join(scratchDir, "Cargo.toml"), `[package]
name = "${cratename}"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
name = "${cratename}"
[features]
no-entrypoint = []
no-idl = []
no-log-ix-name = []
cpi = ["no-entrypoint"]
default = []
[dependencies]
anchor-lang = "0.31"
${extraDeps}
`);
  writeFileSync(join(scratchDir, "src/lib.rs"), patchedSource);

  const r = spawnSync("cargo-build-sbf", ["--manifest-path", join(scratchDir, "Cargo.toml")], {
    stdio: "inherit",
    timeout: 600_000,
    env: { ...process.env, RUSTFLAGS: "" },
  });
  if (r.status !== 0) fail(`cargo build-sbf (Anchor ${cratename}) failed with status ${r.status}`);

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

async function runAndMeasureCounter(
  conn: Connection,
  payer: Keypair,
  programId: PublicKey,
  label: string,
): Promise<{ initialize: number; increment: number }> {
  // Multi-trial: PDAs derived from a random authority can have any bump
  // 255 → ~250 with `find_program_address` iterating from 255 downward
  // — each iteration costs ~1500 CU. Single-trial numbers swing ±3000-
  // 6000 CU on the same program. Running N independent authorities and
  // taking the minimum CU value approximates the bump=255 "best case"
  // (the Anchor / Anvil emitter's actual cost without the find-bump
  // noise).
  const TRIALS = 5;
  let bestInit = Infinity;
  let bestInc = Infinity;
  for (let i = 0; i < TRIALS; i++) {
    const authority = Keypair.generate();
    await airdrop(conn, authority.publicKey, 2);
    const r = await runCounterTrial(conn, payer, programId, authority, label);
    if (r.initialize > 0 && r.initialize < bestInit) bestInit = r.initialize;
    if (r.increment > 0 && r.increment < bestInc) bestInc = r.increment;
  }
  return {
    initialize: bestInit === Infinity ? 0 : bestInit,
    increment: bestInc === Infinity ? 0 : bestInc,
  };
}

async function runCounterTrial(
  conn: Connection,
  payer: Keypair,
  programId: PublicKey,
  authority: Keypair,
  label: string,
): Promise<{ initialize: number; increment: number }> {

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

async function runAndMeasureEscrow(
  conn: Connection,
  payer: Keypair,
  programId: PublicKey,
  label: string,
): Promise<{ createEscrow: number }> {
  // Same multi-trial best-case approach as counter — the escrow PDA bump
  // varies per maker keypair, so single-trial CU swings on each run.
  const TRIALS = 5;
  let best = Infinity;
  for (let i = 0; i < TRIALS; i++) {
    const cu = await runEscrowTrial(conn, payer, programId, label);
    if (cu > 0 && cu < best) best = cu;
  }
  return { createEscrow: best === Infinity ? 0 : best };
}

async function runEscrowTrial(
  conn: Connection,
  payer: Keypair,
  programId: PublicKey,
  label: string,
): Promise<number> {
  const maker = Keypair.generate();
  const mint = Keypair.generate();
  const seed = 42n;

  // Fund the maker so it can pay rent for escrow + vault ATA.
  await airdrop(conn, maker.publicKey, 2);

  // Derive escrow PDA + maker_ata + vault ATA.
  const seedBytes = Buffer.alloc(8);
  seedBytes.writeBigUInt64LE(seed);
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), maker.publicKey.toBuffer(), seedBytes],
    programId,
  );
  const makerAta = getAssociatedTokenAddressSync(mint.publicKey, maker.publicKey);
  // vault is owned by escrow PDA; allowOwnerOffCurve=true.
  const vault = getAssociatedTokenAddressSync(mint.publicKey, escrowPda, true);

  // ── Setup tx: create+initialize mint, create maker_ata, mint 1M.
  const lamportsForMint = await conn.getMinimumBalanceForRentExemption(MINT_SIZE);
  const setupTx = new Transaction()
    .add(SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      lamports: lamportsForMint,
      space: MINT_SIZE,
      programId: TOKEN_PROGRAM_ID,
    }))
    .add(createInitializeMintInstruction(
      mint.publicKey, 6, payer.publicKey, payer.publicKey,
    ))
    .add(createAssociatedTokenAccountInstruction(
      payer.publicKey, makerAta, maker.publicKey, mint.publicKey,
    ))
    .add(createMintToInstruction(
      mint.publicKey, makerAta, payer.publicKey, 1_000_000n,
    ));
  const { blockhash: bh1 } = await conn.getLatestBlockhash();
  setupTx.recentBlockhash = bh1;
  setupTx.feePayer = payer.publicKey;
  setupTx.sign(payer, mint);
  const setupSig = await conn.sendRawTransaction(setupTx.serialize());
  await conn.confirmTransaction(setupSig, "confirmed");

  // ── Measured tx: create_escrow(seed, deposit_amount).
  const data = new Uint8Array(8 + 8 + 8);
  data.set(discriminator("create_escrow"), 0);
  data.set(encodeU64(seed), 8);
  data.set(encodeU64(250_000n), 16);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      meta(maker.publicKey, true, true),
      meta(mint.publicKey, false, false),
      meta(makerAta, false, true),
      meta(escrowPda, false, true),
      meta(vault, false, true),
      meta(SystemProgram.programId, false, false),
      meta(TOKEN_PROGRAM_ID, false, false),
      meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    ],
    data: Buffer.from(data),
  });
  const tx = new Transaction().add(ix);
  const { blockhash: bh2 } = await conn.getLatestBlockhash();
  tx.recentBlockhash = bh2;
  tx.feePayer = maker.publicKey;
  tx.sign(maker);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");

  const txInfo = await conn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = txInfo?.meta?.logMessages ?? [];
  const cuLine = logs.find((l) =>
    l.includes(`Program ${programId.toBase58()}`) && l.includes("consumed"),
  );
  if (!cuLine) {
    console.warn(`[${label}/create_escrow] no consumed-CU log line. Logs:\n${logs.join("\n")}`);
    return 0;
  }
  const m = cuLine.match(/consumed (\d+) of/);
  return m?.[1] ? parseInt(m[1], 10) : 0;
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
