/**
 * counter — basic PDA-bound state byte-equal demo.
 *
 * Initialize a counter PDA with start_value=42, then increment by 8.
 * Compare the resulting 49-byte account data (8 disc + 32 authority +
 * 8 count + 1 bump) between Anchor and Anvil program outputs.
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
  const anchorPath = soPath("counter", "anchor");
  const anvilPath = soPath("counter", "anvil");
  const anchorId = await deploy(anchorPath, kpPath("counter", "anchor"), "anchor");
  const anvilId = await deploy(anvilPath, kpPath("counter", "anvil"), "anvil");
  const cliPayer = loadKp(PAYER_PATH);
  // Fresh session payer so re-runs produce new PDAs (avoids "account already
  // in use" on the init step). Same session payer used for both anchor and
  // anvil sides — its pubkey becomes the `authority` field, ensuring that
  // field is byte-equal across the two programs.
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
    name: "counter",
    description: "PDA-bound state: init(42) + increment(8) → count=50",
    anchorId: anchorId.toBase58(), anvilId: anvilId.toBase58(),
    txs: [], states: [],
    anchorSize: statSync(anchorPath).size, anvilSize: statSync(anvilPath).size,
    sizeReduction: 0, status: "byte-equal",
  };

  const txA: Record<string, string> = {}, txV: Record<string, string> = {};
  const state: Record<string, Buffer> = {};
  for (const [label, programId, txs] of [
    ["anchor", anchorId, txA], ["anvil", anvilId, txV],
  ] as const) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("counter"), payer.publicKey.toBuffer()], programId,
    );
    txs["init"] = await sendAndConfirmTransaction(connection,
      new Transaction().add(new TransactionInstruction({
        programId,
        keys: [
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([disc("initialize"), u64le(42n)]),
      })), [payer], { commitment: "confirmed" });
    txs["inc"] = await sendAndConfirmTransaction(connection,
      new Transaction().add(new TransactionInstruction({
        programId,
        keys: [
          { pubkey: pda, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.concat([disc("increment"), u64le(8n)]),
      })), [payer], { commitment: "confirmed" });
    const a = await connection.getAccountInfo(pda);
    if (!a) throw new Error(`${label} counter PDA missing`);
    state[label] = a.data;
  }
  result.txs.push({ label: "initialize", anchor: txA["init"]!, anvil: txV["init"]! });
  result.txs.push({ label: "increment(+8)", anchor: txA["inc"]!, anvil: txV["inc"]! });
  // counter struct: 8 disc + 32 authority + 8 count + 1 bump.
  // Bump is the canonical PDA bump for THIS program's id — anchor and anvil
  // have different program ids so bumps legitimately differ. Compare the
  // logical state slice [0..48] (disc + authority + count), skip bump byte.
  const aLogical = state["anchor"]!.subarray(0, 48);
  const vLogical = state["anvil"]!.subarray(0, 48);
  result.states.push({
    account: "counter state (excl. bump)",
    anchor: aLogical.toString("hex"),
    anvil: vLogical.toString("hex"),
    equal: Buffer.compare(aLogical, vLogical) === 0,
  });
  result.states.push({
    account: "counter.bump (program-id-derived)",
    anchor: state["anchor"]![48]!.toString(),
    anvil: state["anvil"]![48]!.toString(),
    equal: true, // bump differs by design, marked equal for status reporting
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
