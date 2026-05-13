/**
 * vault — PDA-as-vault byte-equal demo.
 *
 * Initialize a vault PDA (system_account), deposit 0.1 SOL into it via
 * signer-seeded system_transfer. Compare vault lamport balance.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { soPath, kpPath, PAYER_PATH, RPC } from "./paths.ts";

type StateCompare = { account: string; anchor: string; anvil: string; equal: boolean };
type TxRecord = { label: string; anchor: string; anvil: string };
export interface DemoResult {
  name: string; description: string; anchorId: string; anvilId: string;
  txs: TxRecord[]; states: StateCompare[];
  anchorSize: number; anvilSize: number; sizeReduction: number;
  status: "byte-equal" | "deployed-only" | "failed";
  failure?: string;
}

const connection = new Connection(RPC, "confirmed");

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(p, "utf-8"))));
}
function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}
function u64le(v: bigint): Buffer {
  return Buffer.from(new BigUint64Array([v]).buffer);
}
async function deploy(so: string, kp: string, label: string): Promise<PublicKey> {
  const k = loadKp(kp);
  const info = await connection.getAccountInfo(k.publicKey);
  if (info?.executable) return k.publicKey;
  const r = spawnSync("solana", [
    "--url", RPC, "program", "deploy",
    "--program-id", kp,
    "--upgrade-authority", PAYER_PATH,
    so,
  ], { encoding: "utf-8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`deploy ${label} failed: ${r.stderr.slice(0, 300)}`);
  return k.publicKey;
}

export async function runDemo(): Promise<DemoResult> {
  const anchorPath = soPath("vault", "anchor");
  const anvilPath = soPath("vault", "anvil");
  const anchorId = await deploy(anchorPath, kpPath("vault", "anchor"), "anchor");
  const anvilId = await deploy(anvilPath, kpPath("vault", "anvil"), "anvil");
  const cliPayer = loadKp(PAYER_PATH);
  // Fresh session payer so re-runs produce new PDAs.
  const payer = Keypair.generate();
  await sendAndConfirmTransaction(connection,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: cliPayer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 2 * LAMPORTS_PER_SOL,
    })),
    [cliPayer],
    { commitment: "confirmed" },
  );

  const result: DemoResult = {
    name: "vault",
    description: "PDA-as-vault: initialize + deposit(0.1 SOL) → 100_000_000 lamports",
    anchorId: anchorId.toBase58(), anvilId: anvilId.toBase58(),
    txs: [], states: [],
    anchorSize: statSync(anchorPath).size, anvilSize: statSync(anvilPath).size,
    sizeReduction: 0, status: "byte-equal",
  };

  const txA: Record<string, string> = {}, txV: Record<string, string> = {};
  const lamports: Record<string, bigint> = {};
  for (const [label, programId, txs] of [["anchor", anchorId, txA], ["anvil", anvilId, txV]] as const) {
    const [statePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_state"), payer.publicKey.toBuffer()], programId);
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), payer.publicKey.toBuffer()], programId);
    txs["init"] = await sendAndConfirmTransaction(connection,
      new Transaction().add(new TransactionInstruction({
        programId,
        keys: [
          { pubkey: statePda, isSigner: false, isWritable: true },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: disc("initialize"),
      })), [payer], { commitment: "confirmed" });
    txs["dep"] = await sendAndConfirmTransaction(connection,
      new Transaction().add(new TransactionInstruction({
        programId,
        keys: [
          { pubkey: statePda, isSigner: false, isWritable: true },
          { pubkey: vaultPda, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("deposit"), u64le(100_000_000n)]),
      })), [payer], { commitment: "confirmed" });
    const a = await connection.getAccountInfo(vaultPda);
    if (!a) throw new Error(`${label} vault PDA missing`);
    lamports[label] = BigInt(a.lamports);
  }
  result.txs.push({ label: "initialize", anchor: txA["init"]!, anvil: txV["init"]! });
  result.txs.push({ label: "deposit(0.1 SOL)", anchor: txA["dep"]!, anvil: txV["dep"]! });
  result.states.push({
    account: "vault lamports",
    anchor: lamports["anchor"]!.toString(),
    anvil: lamports["anvil"]!.toString(),
    equal: lamports["anchor"] === lamports["anvil"],
  });
  result.sizeReduction = (1 - result.anvilSize / result.anchorSize) * 100;
  if (!result.states[0]!.equal) result.status = "failed";
  return result;
}

if (import.meta.main) {
  runDemo().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status === "byte-equal" ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
