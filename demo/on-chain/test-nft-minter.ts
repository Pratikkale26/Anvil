/**
 * Byte-equal demo: nft-minter (Metaplex NFT).
 *
 * Single instruction `mint_nft(name, symbol, uri)` exercises three CPIs:
 *   - SPL Token mint_to (1 unit)
 *   - Metaplex create_metadata_accounts_v3
 *   - Metaplex create_master_edition_v3
 *
 * Comparison strategy:
 *   - Mint account data (82 bytes) — no mint pubkey embedded inside, fully byte-equal.
 *   - Metadata account — skip update_authority+mint header, compare name/symbol/uri
 *     fixed-size slices (Metaplex pads strings to MAX_LEN with nulls).
 *   - Master edition — small account, edition_type + max_supply option byte-equal.
 *   - ATA — token amount slice (offset 64, 8 bytes) — should be 1.
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
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram,
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

const disc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

function u32le(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v, 0);
  return b;
}

function strBorsh(s: string): Buffer {
  const bytes = Buffer.from(s, "utf-8");
  return Buffer.concat([u32le(bytes.length), bytes]);
}

async function deploy(soPath: string, kpPath: string, label: string): Promise<PublicKey> {
  const kp = loadKp(kpPath);
  const info = await connection.getAccountInfo(kp.publicKey);
  if (info?.executable) return kp.publicKey;
  if (!existsSync(soPath)) throw new Error(`missing .so: ${soPath}`);
  const r = spawnSync(
    "solana",
    [
      "--url",
      RPC,
      "program",
      "deploy",
      "--program-id",
      kpPath,
      "--upgrade-authority",
      PAYER_PATH,
      soPath,
    ],
    { encoding: "utf-8", timeout: 180_000 },
  );
  if (r.status !== 0) throw new Error(`deploy ${label} failed: ${r.stderr.slice(0, 400)}`);
  return kp.publicKey;
}

async function fileSize(p: string): Promise<number> {
  if (!existsSync(p)) return 0;
  return statSync(p).size;
}

/**
 * Derive Metaplex PDAs and standard ATA.
 */
function deriveMetadata(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METADATA_PROGRAM.toBuffer(), mint.toBuffer()],
    METADATA_PROGRAM,
  )[0];
}

function deriveMasterEdition(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM.toBuffer(),
      mint.toBuffer(),
      Buffer.from("edition"),
    ],
    METADATA_PROGRAM,
  )[0];
}

function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

/**
 * Run mint_nft against one program. Generates a fresh mint keypair, derives
 * all PDAs, builds the instruction, sends it, returns relevant on-chain state.
 */
async function runMintNft(
  programId: PublicKey,
  payer: Keypair,
  name: string,
  symbol: string,
  uri: string,
): Promise<{
  sig: string;
  mint: PublicKey;
  mintData: Buffer;
  metadata: PublicKey;
  metadataData: Buffer;
  masterEdition: PublicKey;
  masterEditionData: Buffer;
  ata: PublicKey;
  ataData: Buffer;
}> {
  const mint = Keypair.generate();
  const metadata = deriveMetadata(mint.publicKey);
  const masterEdition = deriveMasterEdition(mint.publicKey);
  const ata = deriveAta(payer.publicKey, mint.publicKey);

  // Instruction data: [8-byte global:mint_nft disc, 3 Borsh strings]
  const data = Buffer.concat([
    disc("mint_nft"),
    strBorsh(name),
    strBorsh(symbol),
    strBorsh(uri),
  ]);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: masterEdition, isSigner: false, isWritable: true },
      { pubkey: mint.publicKey, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: METADATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });

  // Metaplex CPIs are CU-heavy — bump the limit so neither side runs out.
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });

  const tx = new Transaction().add(cuLimit).add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, mint], {
    commitment: "confirmed",
  });

  const [mintAcct, metadataAcct, editionAcct, ataAcct] = await Promise.all([
    connection.getAccountInfo(mint.publicKey),
    connection.getAccountInfo(metadata),
    connection.getAccountInfo(masterEdition),
    connection.getAccountInfo(ata),
  ]);
  if (!mintAcct) throw new Error("mint account missing after tx");
  if (!metadataAcct) throw new Error("metadata account missing after tx");
  if (!editionAcct) throw new Error("master edition account missing after tx");
  if (!ataAcct) throw new Error("ata missing after tx");

  return {
    sig,
    mint: mint.publicKey,
    mintData: mintAcct.data,
    metadata,
    metadataData: metadataAcct.data,
    masterEdition,
    masterEditionData: editionAcct.data,
    ata,
    ataData: ataAcct.data,
  };
}

/**
 * Metaplex Metadata account layout (relevant prefix):
 *   offset 0     : key (1 byte)
 *   offset 1     : update_authority (32)
 *   offset 33    : mint (32)               <- DIFFERS per run, skip
 *   offset 65    : name (4 + 32 padded)    <- compare
 *   offset 101   : symbol (4 + 10 padded)  <- compare
 *   offset 115   : uri (4 + 200 padded)    <- compare
 *   ...
 *
 * We return the user-data slice [offset 65 .. offset 65+250] which is fully
 * deterministic across runs (no pubkey embedded).
 */
function metadataUserSlice(data: Buffer): Buffer {
  // name(36) + symbol(14) + uri(204) = 254 bytes
  return data.subarray(65, 65 + 36 + 14 + 204);
}

/**
 * ATA (SPL Token classic) layout, first 72 bytes:
 *   0..32  mint
 *   32..64 owner
 *   64..72 amount (u64 LE)
 *
 * Owner (payer) is constant across runs, so we compare the [32..165] tail.
 * (Skip mint at the head since the mint keypair is fresh per run.)
 */
function ataComparableSlice(data: Buffer): Buffer {
  return data.subarray(32);
}

export async function runDemo(): Promise<DemoResult> {
  const anchorPath = soPath("nft-minter", "anchor");
  const anvilPath = soPath("nft-minter", "anvil");
  const anchorId = await deploy(anchorPath, kpPath("nft-minter", "anchor"), "anchor");
  const anvilId = await deploy(anvilPath, kpPath("nft-minter", "anvil"), "anvil");
  const payer = loadKp(PAYER_PATH);

  const result: DemoResult = {
    name: "nft-minter",
    description:
      "Metaplex NFT mint: mint_nft(name,symbol,uri) -> mint(1) + metadata + master_edition",
    anchorId: anchorId.toBase58(),
    anvilId: anvilId.toBase58(),
    txs: [],
    states: [],
    anchorSize: await fileSize(anchorPath),
    anvilSize: await fileSize(anvilPath),
    sizeReduction: 0,
    status: "byte-equal",
  };

  const NFT_NAME = "Anvil NFT";
  const NFT_SYMBOL = "ANV";
  const NFT_URI = "https://anvilsol.xyz/nft.json";

  try {
    const a = await runMintNft(anchorId, payer, NFT_NAME, NFT_SYMBOL, NFT_URI);
    const v = await runMintNft(anvilId, payer, NFT_NAME, NFT_SYMBOL, NFT_URI);

    result.txs.push({ label: "mint_nft", anchor: a.sig, anvil: v.sig });

    // SPL Mint layout (82 bytes):
    //   0..4    mintAuthorityOption     (= 1)
    //   4..36   mintAuthority           <- master_edition PDA, mint-derived -> DIFFERS per run
    //   36..44  supply                  (= 1)
    //   44      decimals                (= 0)
    //   45      isInitialized           (= 1)
    //   46..50  freezeAuthorityOption   (= 1)
    //   50..82  freezeAuthority         <- master_edition PDA -> DIFFERS per run
    //
    // create_master_edition_v3 reassigns both authorities to the (mint-derived)
    // master_edition PDA, so the embedded pubkeys differ. The deterministic
    // slice is bytes [0..4) ++ [36..50) — option flags + supply + decimals
    // + isInitialized.
    const mintDet = (d: Buffer): Buffer =>
      Buffer.concat([d.subarray(0, 4), d.subarray(36, 50)]);
    const aMint = mintDet(a.mintData);
    const vMint = mintDet(v.mintData);
    result.states.push({
      account: "mint (supply+decimals+flags)",
      anchor: aMint.toString("hex"),
      anvil: vMint.toString("hex"),
      equal: Buffer.compare(aMint, vMint) === 0,
    });

    // Metadata account — compare user-data slice (skip mint+update_auth header).
    const aMeta = metadataUserSlice(a.metadataData);
    const vMeta = metadataUserSlice(v.metadataData);
    result.states.push({
      account: "metadata (name+symbol+uri)",
      anchor: aMeta.toString("hex"),
      anvil: vMeta.toString("hex"),
      equal: Buffer.compare(aMeta, vMeta) === 0,
    });

    // Master edition — small, deterministic account.
    result.states.push({
      account: "master edition",
      anchor: a.masterEditionData.toString("hex"),
      anvil: v.masterEditionData.toString("hex"),
      equal: Buffer.compare(a.masterEditionData, v.masterEditionData) === 0,
    });

    // ATA — skip mint header, compare owner+amount+rest.
    const aAta = ataComparableSlice(a.ataData);
    const vAta = ataComparableSlice(v.ataData);
    result.states.push({
      account: "ata (owner+amount+state)",
      anchor: aAta.toString("hex"),
      anvil: vAta.toString("hex"),
      equal: Buffer.compare(aAta, vAta) === 0,
    });

    if (result.states.some((s) => !s.equal)) result.status = "failed";
  } catch (e) {
    result.status = "failed";
    result.failure = (e as Error).message?.slice(0, 400);
  }

  result.sizeReduction =
    result.anchorSize > 0 ? (1 - result.anvilSize / result.anchorSize) * 100 : 0;
  return result;
}

async function main(): Promise<void> {
  console.log("=".repeat(80));
  console.log("  nft-minter byte-equal demo (Metaplex NFT)");
  console.log("=".repeat(80));

  const ver = await connection.getVersion();
  console.log(`RPC:      ${RPC}`);
  console.log(`Agave:    ${ver["solana-core"]}`);

  const payer = loadKp(PAYER_PATH);
  console.log(`Payer:    ${payer.publicKey.toBase58()}`);

  const mplInfo = await connection.getAccountInfo(METADATA_PROGRAM);
  console.log(
    `Metaplex: ${mplInfo?.executable ? `loaded (${(mplInfo.data.length / 1024).toFixed(0)}KB)` : "NOT loaded"}`,
  );

  const r = await runDemo();

  console.log("");
  console.log(`anchor program: ${r.anchorId}`);
  console.log(`anvil program:  ${r.anvilId}`);
  console.log("");
  if (r.txs.length > 0) {
    console.log("transactions:");
    for (const t of r.txs) {
      console.log(`  ${t.label.padEnd(14)} anchor=${t.anchor.slice(0, 20)}...`);
      console.log(`  ${" ".repeat(14)} anvil =${t.anvil.slice(0, 20)}...`);
    }
    console.log("");
  }
  console.log("on-chain state byte-comparison:");
  for (const s of r.states) {
    const mark = s.equal ? "BYTE-EQUAL" : "DIVERGED";
    console.log(`  ${s.account.padEnd(28)} ${mark}`);
    if (!s.equal) {
      console.log(`    anchor: ${s.anchor.slice(0, 120)}`);
      console.log(`    anvil:  ${s.anvil.slice(0, 120)}`);
    }
  }
  console.log("");
  console.log(
    `binary size:  Anchor ${(r.anchorSize / 1024).toFixed(0)}KB  ->  Anvil ${(r.anvilSize / 1024).toFixed(0)}KB  (${r.sizeReduction.toFixed(1)}% smaller)`,
  );
  console.log("");
  console.log(`status: ${r.status}${r.failure ? ` -- ${r.failure}` : ""}`);
}

// Run when invoked directly.
if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
