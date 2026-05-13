/**
 * t22-non-transferable — Token-2022 NonTransferable extension byte-equal.
 *
 * Pre-allocate a fresh mint with extension space, call
 * make_non_transferable() which CPIs into Token-2022's
 * non_transferable_mint_initialize. Compare resulting mint data.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { soPath, kpPath, PAYER_PATH, RPC } from "./paths.ts";

const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

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
  const anchorPath = soPath("t22-non-transferable", "anchor");
  const anvilPath = soPath("t22-non-transferable", "anvil");
  const anchorId = await deploy(anchorPath, kpPath("t22-non-transferable", "anchor"), "anchor");
  const anvilId = await deploy(anvilPath, kpPath("t22-non-transferable", "anvil"), "anvil");
  const payer = loadKp(PAYER_PATH);

  const result: DemoResult = {
    name: "t22-non-transferable",
    description: "Token-2022 NonTransferable extension init — pre-allocate mint, call extension, compare bytes",
    anchorId: anchorId.toBase58(), anvilId: anvilId.toBase58(),
    txs: [], states: [],
    anchorSize: statSync(anchorPath).size, anvilSize: statSync(anvilPath).size,
    sizeReduction: 0, status: "byte-equal",
  };

  const txA: Record<string, string> = {}, txV: Record<string, string> = {};
  const data: Record<string, Buffer> = {};
  for (const [label, programId, txs] of [["anchor", anchorId, txA], ["anvil", anvilId, txV]] as const) {
    const mint = Keypair.generate();
    const space = 234;
    const rent = await connection.getMinimumBalanceForRentExemption(space);
    const createIx = SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: rent, space, programId: TOKEN_2022_PROGRAM,
    });
    const makeIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: mint.publicKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_2022_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: disc("make_non_transferable"),
    });
    txs["x"] = await sendAndConfirmTransaction(connection,
      new Transaction().add(createIx).add(makeIx),
      [payer, mint], { commitment: "confirmed" });
    const a = await connection.getAccountInfo(mint.publicKey);
    if (!a) throw new Error(`${label} mint missing`);
    data[label] = a.data;
  }
  result.txs.push({ label: "create_account + make_non_transferable", anchor: txA["x"]!, anvil: txV["x"]! });
  result.states.push({
    account: "mint data (T22)",
    anchor: data["anchor"]!.toString("hex").slice(0, 200),
    anvil: data["anvil"]!.toString("hex").slice(0, 200),
    equal: Buffer.compare(data["anchor"]!, data["anvil"]!) === 0,
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
