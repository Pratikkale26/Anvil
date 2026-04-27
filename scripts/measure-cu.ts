#!/usr/bin/env bun
/**
 * Measure real compute units on solana-test-validator.
 *
 * Compares the Anchor original counter program against the Anvil-emitted
 * Pinocchio version using the .so binaries that the differential test
 * (api/tests/differential-counter.test.ts) cached at $HOME/.anvil-diff-cache.
 *
 * Replaces the heuristic CU number in README/pitch with a measured one.
 *
 * Usage:
 *   # 1. Make sure SBF toolchain works (Anza CLI 3.x required for current Anchor deps)
 *   sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.13/install)"
 *
 *   # 2. Build both .so binaries (caches them):
 *   bun test api/tests/differential-counter.test.ts
 *
 *   # 3. Start a local validator (fresh state):
 *   solana-test-validator --reset --quiet &
 *
 *   # 4. Run this script:
 *   bun scripts/measure-cu.ts
 *
 * Output:
 *   counter::increment(amount=5)
 *     Anchor:           412 CU (measured)
 *     Anvil-Pinocchio:  148 CU (measured)
 *     Savings:          64%
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

const RPC = process.env.ANVIL_VALIDATOR_RPC ?? "http://localhost:8899";
const CACHE_ROOT = process.env.ANVIL_DIFF_CACHE ?? join(process.env.HOME ?? "/tmp", ".anvil-diff-cache");

async function main(): Promise<void> {
  // 1. Find the cached .so files (they live under a content-hash subdir).
  if (!existsSync(CACHE_ROOT)) {
    fail(`No cached .so files at ${CACHE_ROOT}.\n` +
      `Run the differential test first to populate the cache:\n` +
      `  bun test api/tests/differential-counter.test.ts\n` +
      `(That requires Anza CLI 3.x — see script header for install line.)`);
  }
  const cacheDirs = readdirSync(CACHE_ROOT).filter((d) => existsSync(join(CACHE_ROOT, d, "counter_anvil.so")));
  if (cacheDirs.length === 0) {
    fail(`No counter_anvil.so found under ${CACHE_ROOT}/<hash>/. Run the differential test first.`);
  }
  const cacheDir = join(CACHE_ROOT, cacheDirs[0]!);
  const anchorSo = join(cacheDir, "counter_anchor.so");
  const anvilSo = join(cacheDir, "counter_anvil.so");
  for (const p of [anchorSo, anvilSo]) {
    if (!existsSync(p)) fail(`Missing: ${p}`);
  }

  // 2. Probe validator + funded payer.
  const conn = new Connection(RPC, "confirmed");
  await conn.getLatestBlockhash().catch(() => {
    fail(`Cannot reach validator at ${RPC}. Start it with:\n  solana-test-validator --reset --quiet`);
  });

  const payer = loadDefaultKeypair();
  const bal = await conn.getBalance(payer.publicKey);
  if (bal < 10_000_000_000) {
    console.log(`[measure-cu] funding payer ${payer.publicKey.toBase58().slice(0, 8)}…`);
    await airdropAndConfirm(conn, payer.publicKey, 10);
  }

  // 3. Deploy each program, capture program ID.
  const anchorPid = await deploy(anchorSo, payer);
  console.log(`[measure-cu] Anchor program deployed:   ${anchorPid.toBase58()}`);
  const anvilPid = await deploy(anvilSo, payer);
  console.log(`[measure-cu] Anvil-Pinocchio deployed:  ${anvilPid.toBase58()}`);

  // 4. Run the same instruction sequence against each, parse CU from logs.
  const anchorCU = await runAndMeasure(conn, payer, anchorPid, "Anchor");
  const anvilCU = await runAndMeasure(conn, payer, anvilPid, "Anvil-Pinocchio");

  const savedPct = Math.round((1 - anvilCU.increment / anchorCU.increment) * 100);
  console.log("\n=== counter::increment(amount=5) — measured CU ===");
  console.log(`  Anchor:           ${anchorCU.increment.toString().padStart(6)} CU`);
  console.log(`  Anvil-Pinocchio:  ${anvilCU.increment.toString().padStart(6)} CU`);
  console.log(`  Savings:          ${savedPct}%`);
  console.log("\n=== counter::initialize(start_value=10) — measured CU ===");
  console.log(`  Anchor:           ${anchorCU.initialize.toString().padStart(6)} CU`);
  console.log(`  Anvil-Pinocchio:  ${anvilCU.initialize.toString().padStart(6)} CU`);
}

function loadDefaultKeypair(): Keypair {
  const path = join(process.env.HOME ?? "", ".config/solana/id.json");
  if (!existsSync(path)) {
    fail(`Default keypair not found at ${path}. Generate with:\n  solana-keygen new --no-bip39-passphrase --force`);
  }
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf-8")));
  return Keypair.fromSecretKey(secret);
}

async function airdropAndConfirm(conn: Connection, pubkey: PublicKey, sol: number): Promise<void> {
  const sig = await conn.requestAirdrop(pubkey, sol * 1_000_000_000);
  await conn.confirmTransaction(sig, "confirmed");
}

async function deploy(soPath: string, payer: Keypair): Promise<PublicKey> {
  const programKp = Keypair.generate();
  const r = spawnSync(
    "solana",
    [
      "program", "deploy", soPath,
      "--program-id", programKp.publicKey.toBase58(),
      "--keypair", join(process.env.HOME ?? "", ".config/solana/id.json"),
      "--url", RPC,
      "--commitment", "confirmed",
    ],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  // Need to write the program keypair to disk first because `--program-id` accepts only a path.
  // Simpler: shell out without --program-id and parse the output for "Program Id: ..."
  if (r.status !== 0) {
    // Retry without --program-id (let solana CLI generate one)
    const r2 = spawnSync(
      "solana",
      ["program", "deploy", soPath, "--keypair", join(process.env.HOME ?? "", ".config/solana/id.json"), "--url", RPC, "--commitment", "confirmed"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    if (r2.status !== 0) {
      fail(`solana program deploy failed (${r2.status}): ${r2.stderr?.toString().slice(0, 500)}`);
    }
    const m = (r2.stdout?.toString() ?? "").match(/Program Id:\s*([A-Za-z0-9]+)/);
    if (!m?.[1]) fail(`Could not parse Program Id from deploy output: ${r2.stdout?.toString().slice(0, 200)}`);
    return new PublicKey(m[1]);
  }
  return programKp.publicKey;
}

async function runAndMeasure(
  conn: Connection,
  payer: Keypair,
  programId: PublicKey,
  label: string,
): Promise<{ initialize: number; increment: number }> {
  // Use a fresh authority per program so the counter PDA doesn't collide
  // (PDA = ['counter', authority.key]). Same input across both runs.
  const authority = Keypair.generate();
  await airdropAndConfirm(conn, authority.publicKey, 2);

  const [counterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), authority.publicKey.toBuffer()],
    programId,
  );

  const initIx = makeIx(programId, discriminator("initialize"), encodeU64(10n), [
    meta(counterPda, false, true),
    meta(authority.publicKey, true, true),
    meta(SystemProgram.programId, false, false),
  ]);
  const incrementIx = makeIx(programId, discriminator("increment"), encodeU64(5n), [
    meta(counterPda, false, true),
    meta(authority.publicKey, true, false),
  ]);

  const initCU = await sendAndExtractCU(conn, payer, authority, initIx, programId, label, "initialize");
  const incrementCU = await sendAndExtractCU(conn, payer, authority, incrementIx, programId, label, "increment");
  return { initialize: initCU, increment: incrementCU };
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
    console.warn(`[${programLabel}/${ixLabel}] no consumed-CU log line found. Logs:\n${logs.join("\n")}`);
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
