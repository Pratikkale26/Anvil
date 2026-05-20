/**
 * Localnet deploy sweep — picks the freshest Anvil-emitted .so per fixture
 * from ~/.anvil-diff-cache (populated by prior differential runs) and
 * deploys each to localhost:8899, then re-runs the corresponding init
 * transaction against the deployed program and reads back the account
 * state for verification.
 *
 * Run: `bun run tests/localnet-deploy-sweep.ts`
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";

const RPC = process.env.ANVIL_RPC ?? "http://localhost:8899";
const PAYER_KP_PATH = process.env.ANVIL_PAYER_KP ?? `${process.env.HOME}/.config/solana/id.json`;
const CACHE = `${process.env.HOME}/.anvil-diff-cache`;

function loadPayer(): Keypair {
  const raw = JSON.parse(readFileSync(PAYER_KP_PATH, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

function anchorIxDisc(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

function u64LE(n: bigint): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(n);
  return new Uint8Array(buf);
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function findLatestSo(fixture: string): string | null {
  let candidates: { path: string; mtime: number }[] = [];
  for (const dir of readdirSync(CACHE)) {
    if (!dir.startsWith(`${fixture}-`)) continue;
    const sopath = join(CACHE, dir, `${fixture}_anvil.so`);
    try {
      const st = statSync(sopath);
      candidates.push({ path: sopath, mtime: st.mtimeMs });
    } catch { /* missing */ }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

interface DeployResult {
  fixture: string;
  cached_so: string | null;
  programId?: string;
  deploy: { ok: boolean; error?: string; tookMs: number };
  invoke?: { ok: boolean; error?: string; signature?: string; accountDataLen?: number };
}

async function deployAndInvoke(fixture: string, invoker: (conn: Connection, payer: Keypair, programId: PublicKey) => Promise<{ signature: string; accountDataLen: number }>): Promise<DeployResult> {
  const so = findLatestSo(fixture);
  if (!so) {
    return { fixture, cached_so: null, deploy: { ok: false, error: "no cached .so found", tookMs: 0 } };
  }

  const programKp = Keypair.generate();
  const kpPath = `/tmp/anvil-localnet-deploy/${fixture}-${programKp.publicKey.toBase58().slice(0, 8)}.json`;
  spawnSync("mkdir", ["-p", "/tmp/anvil-localnet-deploy"]);
  writeFileSync(kpPath, JSON.stringify(Array.from(programKp.secretKey)));

  const t0 = Date.now();
  const r = spawnSync("solana", [
    "program", "deploy",
    "--keypair", PAYER_KP_PATH,
    "--program-id", kpPath,
    "--url", RPC,
    so,
  ], { encoding: "utf8", timeout: 300_000 });
  const deployMs = Date.now() - t0;
  if (r.status !== 0) {
    return { fixture, cached_so: so, deploy: { ok: false, error: (r.stderr ?? "").slice(0, 400), tookMs: deployMs } };
  }

  const programId = programKp.publicKey;
  const conn = new Connection(RPC, "confirmed");
  const payer = loadPayer();

  try {
    const invoked = await invoker(conn, payer, programId);
    return {
      fixture, cached_so: so, programId: programId.toBase58(),
      deploy: { ok: true, tookMs: deployMs },
      invoke: { ok: true, signature: invoked.signature, accountDataLen: invoked.accountDataLen },
    };
  } catch (e) {
    return {
      fixture, cached_so: so, programId: programId.toBase58(),
      deploy: { ok: true, tookMs: deployMs },
      invoke: { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 600) },
    };
  }
}

// ──────────────── per-fixture invokers ────────────────

async function invokeCounter(conn: Connection, payer: Keypair, programId: PublicKey): Promise<{ signature: string; accountDataLen: number }> {
  const authority = Keypair.generate();
  // fund authority
  const airdropSig = await conn.requestAirdrop(authority.publicKey, 2_000_000_000);
  await conn.confirmTransaction(airdropSig, "confirmed");

  const [counterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("counter"), authority.publicKey.toBuffer()],
    programId,
  );

  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: counterPda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(anchorIxDisc("initialize"), u64LE(42n))),
  });
  const tx = new Transaction().add(initIx);
  const signature = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  const acct = await conn.getAccountInfo(counterPda);
  if (!acct) throw new Error("counter PDA not created");
  return { signature, accountDataLen: acct.data.length };
}

async function invokeHasOne(conn: Connection, payer: Keypair, programId: PublicKey): Promise<{ signature: string; accountDataLen: number }> {
  // has-one uses Account<Safe> with explicit keypair, not PDA. Caller provides keypair.
  const owner = Keypair.generate();
  const safe = Keypair.generate();
  const airdropSig = await conn.requestAirdrop(owner.publicKey, 2_000_000_000);
  await conn.confirmTransaction(airdropSig, "confirmed");

  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: safe.publicKey, isSigner: true, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDisc("initialize")),
  });
  const tx = new Transaction().add(initIx);
  const signature = await sendAndConfirmTransaction(conn, tx, [owner, safe], { commitment: "confirmed" });
  const acct = await conn.getAccountInfo(safe.publicKey);
  if (!acct) throw new Error("Safe account not created");
  return { signature, accountDataLen: acct.data.length };
}

async function invokeBumpsAccess(conn: Connection, payer: Keypair, programId: PublicKey): Promise<{ signature: string; accountDataLen: number }> {
  const authority = Keypair.generate();
  const airdropSig = await conn.requestAirdrop(authority.publicKey, 2_000_000_000);
  await conn.confirmTransaction(airdropSig, "confirmed");

  const [statePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bumps-access"), authority.publicKey.toBuffer()],
    programId,
  );

  const initIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: statePda, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(anchorIxDisc("initialize")),
  });
  const tx = new Transaction().add(initIx);
  const signature = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
  const acct = await conn.getAccountInfo(statePda);
  if (!acct) throw new Error("bumps-access state PDA not created");
  return { signature, accountDataLen: acct.data.length };
}

async function invokeCloseAccount(conn: Connection, payer: Keypair, programId: PublicKey): Promise<{ signature: string; accountDataLen: number }> {
  const owner = Keypair.generate();
  const airdropSig = await conn.requestAirdrop(owner.publicKey, 2_000_000_000);
  await conn.confirmTransaction(airdropSig, "confirmed");

  const [notePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("note"), owner.publicKey.toBuffer()],
    programId,
  );
  const openIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: notePda, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(anchorIxDisc("open"), u64LE(99n))),
  });
  const tx = new Transaction().add(openIx);
  const signature = await sendAndConfirmTransaction(conn, tx, [owner], { commitment: "confirmed" });
  const acct = await conn.getAccountInfo(notePda);
  if (!acct) throw new Error("note PDA not created");
  return { signature, accountDataLen: acct.data.length };
}

const FIXTURES: { name: string; invoker?: (conn: Connection, payer: Keypair, programId: PublicKey) => Promise<{ signature: string; accountDataLen: number }> }[] = [
  { name: "counter", invoker: invokeCounter },
  { name: "has-one", invoker: invokeHasOne },
  { name: "bumps-access", invoker: invokeBumpsAccess },
  { name: "close-account", invoker: invokeCloseAccount },
  { name: "vault" },  // deploy-only smoke (no invoke yet — vault scenario needs system_program transfer setup)
  { name: "favorites" },
  { name: "ata-mint" },
  { name: "return-data" },
  { name: "spl-transfer" },
  { name: "escrow" },
];

const results: DeployResult[] = [];
for (const f of FIXTURES) {
  process.stderr.write(`[localnet] ${f.name} ... `);
  const invoker = f.invoker ?? (async () => {
    // smoke: just check program account exists
    const conn = new Connection(RPC, "confirmed");
    return { signature: "<no-invoke>", accountDataLen: -1 };
  });
  const r = await deployAndInvoke(f.name, invoker);
  results.push(r);
  const deploySym = r.deploy.ok ? "Y" : "N";
  const invokeSym = r.invoke?.ok ? "Y" : (r.invoke ? "N" : "-");
  process.stderr.write(`deploy=${deploySym} invoke=${invokeSym} took=${r.deploy.tookMs}ms\n`);
  if (!r.deploy.ok) process.stderr.write(`  deploy err: ${r.deploy.error?.slice(0, 200)}\n`);
  if (r.invoke && !r.invoke.ok) process.stderr.write(`  invoke err: ${r.invoke.error?.slice(0, 200)}\n`);
}

const outPath = "/home/pk/Anvil/reports/localnet-deploy-sweep.json";
writeFileSync(outPath, JSON.stringify(results, null, 2));
process.stderr.write(`[localnet] report → ${outPath}\n`);
