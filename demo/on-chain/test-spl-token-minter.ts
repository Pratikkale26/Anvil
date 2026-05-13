/**
 * Byte-equal demo: spl-token-minter (Anchor) vs anvil-transpiled.
 *
 * Runs create_token + mint_token on each, then compares:
 *   - mint supply (u64 LE @ offset 36..44)
 *   - Metaplex metadata user data (slice from offset 65 — skips marker + update_auth + mint pubkey)
 *   - ATA token balance (string amount via getTokenAccountBalance)
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { soPath, kpPath, PAYER_PATH, RPC } from "./paths.ts";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

// RPC imported from ./paths.ts
const connection = new Connection(RPC, "confirmed");
const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

type StateCompare = { account: string; anchor: string; anvil: string; equal: boolean };
type TxRecord = { label: string; anchor: string; anvil: string };

interface DemoResult {
  name: string;
  description: string;
  anchorId: string;
  anvilId: string;
  txs: TxRecord[];
  states: StateCompare[];
  anchorSize: number;
  anvilSize: number;
  sizeReduction: number;
  status: "byte-equal" | "deployed-only" | "failed";
  failure?: string;
}

function loadKp(p: string): Keypair {
  return Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(p, "utf-8"))));
}

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function u64le(v: bigint): Buffer {
  return Buffer.from(new BigUint64Array([v]).buffer);
}

function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}

function strBorsh(s: string): Buffer {
  return Buffer.concat([u32le(s.length), Buffer.from(s, "utf-8")]);
}

function fileSize(p: string): number {
  if (!existsSync(p)) return 0;
  return statSync(p).size;
}

async function deploy(soPath: string, kpPath: string, label: string): Promise<PublicKey> {
  const kp = loadKp(kpPath);
  const info = await connection.getAccountInfo(kp.publicKey);
  if (info?.executable) return kp.publicKey;
  if (!existsSync(soPath)) throw new Error(`missing .so: ${soPath}`);
  const r = spawnSync(
    "solana",
    [
      "--url", RPC, "program", "deploy",
      "--program-id", kpPath,
      "--upgrade-authority", PAYER_PATH,
      soPath,
    ],
    { encoding: "utf-8", timeout: 180_000 },
  );
  if (r.status !== 0) throw new Error(`deploy ${label} failed: ${r.stderr?.slice(0, 300)}`);
  return kp.publicKey;
}

function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

function findMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM,
  )[0];
}

export async function runDemo(): Promise<DemoResult> {
  const anchorPath = soPath("spl-token-minter", "anchor");
  const anvilPath = soPath("spl-token-minter", "anvil");
  const anchorKpPath = kpPath("spl-token-minter", "anchor");
  const anvilKpPath = kpPath("spl-token-minter", "anvil");

  const result: DemoResult = {
    name: "spl-token-minter",
    description:
      "SPL Token + Metaplex metadata: create_token(name,symbol,uri) + mint_token(amount) — compare supply, metadata, ATA balance",
    anchorId: "",
    anvilId: "",
    txs: [],
    states: [],
    anchorSize: fileSize(anchorPath),
    anvilSize: fileSize(anvilPath),
    sizeReduction: 0,
    status: "byte-equal",
  };

  try {
    const anchorId = await deploy(anchorPath, anchorKpPath, "anchor");
    const anvilId = await deploy(anvilPath, anvilKpPath, "anvil");
    result.anchorId = anchorId.toBase58();
    result.anvilId = anvilId.toBase58();

    const payer = loadKp(PAYER_PATH);
    // Single stable recipient so the ATA's owner field is identical across runs.
    const recipient = Keypair.generate().publicKey;

    const tokenName = "Anvil Test Token";
    const tokenSymbol = "ANV";
    const tokenUri = "https://anvilsol.xyz/test-token.json";
    const mintAmount = 100n; // program multiplies by 10^9 → 100_000_000_000 raw

    const txA: Record<string, string> = {};
    const txV: Record<string, string> = {};
    const mintData: Record<string, Buffer> = {};
    const metadataData: Record<string, Buffer> = {};
    const ataAmount: Record<string, string> = {};

    for (const [label, programId, txs] of [
      ["anchor", anchorId, txA],
      ["anvil", anvilId, txV],
    ] as const) {
      const mint = Keypair.generate();
      const metadataPda = findMetadataPda(mint.publicKey);
      const ata = findAta(recipient, mint.publicKey);

      // ───────────── create_token ─────────────
      const createData = Buffer.concat([
        disc("create_token"),
        strBorsh(tokenName),
        strBorsh(tokenSymbol),
        strBorsh(tokenUri),
      ]);
      const createIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: mint.publicKey, isSigner: true, isWritable: true },
          { pubkey: metadataPda, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: METADATA_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
        ],
        data: createData,
      });
      const createTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(createIx);
      txs["create_token"] = await sendAndConfirmTransaction(
        connection, createTx, [payer, mint], { commitment: "confirmed" },
      );

      // ───────────── mint_token ─────────────
      const mintIxData = Buffer.concat([disc("mint_token"), u64le(mintAmount)]);
      const mintIx = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // mint_authority
          { pubkey: recipient, isSigner: false, isWritable: false },
          { pubkey: mint.publicKey, isSigner: false, isWritable: true },
          { pubkey: ata, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: mintIxData,
      });
      const mintTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(mintIx);
      txs["mint_token"] = await sendAndConfirmTransaction(
        connection, mintTx, [payer], { commitment: "confirmed" },
      );

      // Read state
      const mintAcct = await connection.getAccountInfo(mint.publicKey);
      if (!mintAcct) throw new Error(`${label} mint account missing`);
      mintData[label] = mintAcct.data;

      const metaAcct = await connection.getAccountInfo(metadataPda);
      if (!metaAcct) throw new Error(`${label} metadata account missing`);
      metadataData[label] = metaAcct.data;

      const bal = await connection.getTokenAccountBalance(ata, "confirmed");
      ataAmount[label] = bal.value.amount;
    }

    result.txs.push({ label: "create_token", anchor: txA["create_token"]!, anvil: txV["create_token"]! });
    result.txs.push({ label: "mint_token(100)", anchor: txA["mint_token"]!, anvil: txV["mint_token"]! });

    // Mint supply: u64 LE at offset 36..44 (Mint layout: mint_authority(36) + supply(8) + decimals(1) + ...)
    const supplyA = mintData["anchor"]!.subarray(36, 44);
    const supplyV = mintData["anvil"]!.subarray(36, 44);
    result.states.push({
      account: "mint supply (u64 LE)",
      anchor: supplyA.toString("hex"),
      anvil: supplyV.toString("hex"),
      equal: Buffer.compare(supplyA, supplyV) === 0,
    });

    // Metaplex metadata: compare bytes 65..325 — the user-provided fields
    // (name, symbol, uri padded, seller_fee, has_creators). Skip:
    //   - 0..65  → key + update_auth + mint pubkey (mint pubkey differs
    //              between runs since each program creates a fresh mint)
    //   - 325+   → edition_nonce (canonical PDA bump for master_edition
    //              against the fresh mint pubkey — differs by design)
    const metaA = metadataData["anchor"]!.subarray(65, 325);
    const metaV = metadataData["anvil"]!.subarray(65, 325);
    result.states.push({
      account: "metadata user fields (name+symbol+uri)",
      anchor: metaA.toString("hex").slice(0, 200),
      anvil: metaV.toString("hex").slice(0, 200),
      equal: Buffer.compare(metaA, metaV) === 0,
    });

    // ATA balance
    result.states.push({
      account: "ATA balance",
      anchor: ataAmount["anchor"]!,
      anvil: ataAmount["anvil"]!,
      equal: ataAmount["anchor"] === ataAmount["anvil"],
    });

    result.sizeReduction = (1 - result.anvilSize / result.anchorSize) * 100;
    if (!result.states.every((s) => s.equal)) result.status = "failed";
    return result;
  } catch (e) {
    result.status = "failed";
    result.failure = (e as Error).message?.slice(0, 400);
    result.sizeReduction =
      result.anchorSize > 0 ? (1 - result.anvilSize / result.anchorSize) * 100 : 0;
    return result;
  }
}

if (import.meta.main) {
  runDemo().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    console.log("\n=== summary ===");
    console.log(`status: ${r.status}`);
    for (const s of r.states) {
      console.log(`  ${s.account.padEnd(40)} ${s.equal ? "BYTE-EQUAL" : "DIVERGED"}`);
    }
    if (r.failure) console.log(`failure: ${r.failure}`);
    process.exit(r.status === "byte-equal" ? 0 : 1);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
