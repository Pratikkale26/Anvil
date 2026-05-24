/**
 * crowdfunding-solana differential fixture — create campaign instruction.
 *
 * Exercises: PDA init with seeds [b"CAMPAIGN_DEMO", user.key()], String field
 * writes (name + description), u64 scalar write (amount_donated = 0),
 * Pubkey write (admin = user.key). System program CPI for account creation.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  concatBytes,
  Keypair,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildProjectSource } from "../../src/parser/project-source.ts";
import { collectProjectFilesFromEntry, getProjectEntryPath } from "../../src/parser/project-source.ts";

export const REPO_PATH = "/tmp/crowdfunding-solana";
export const LIB_RS = `${REPO_PATH}/programs/crowdfunding/src/lib.rs`;
export const PROGRAM_ID = "4Mhozxxdm44cTcC22gpCpiQiHEtaaPCkdDG2ULrPrCVy";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    ["clone", "--depth=1", "https://github.com/kodmanyagha/crowdfunding-solana", REPO_PATH],
    { stdio: "inherit", timeout: 60_000 },
  );
  if (r.status !== 0) {
    console.warn("[crowdfunding-solana-fixture] clone failed");
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) return "// MISSING";
  const files = collectProjectFilesFromEntry(LIB_RS);
  return buildProjectSource(getProjectEntryPath(LIB_RS), files);
}

export interface CreateCampaignCtx {
  payer: Keypair;
  campaign: PublicKey;
  campaignBump: number;
  name: string;
  description: string;
}

export async function setupCreateCampaign(programId: PublicKey): Promise<CreateCampaignCtx> {
  const payer = Keypair.generate();
  const name = "TestCampaign";
  const description = "A test campaign for byte-equal";

  const [campaign, campaignBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("CAMPAIGN_DEMO"), payer.publicKey.toBuffer()],
    programId,
  );

  return { payer, campaign, campaignBump, name, description };
}

export async function callCreateCampaign(
  svm: LiteSVM,
  ctx: CreateCampaignCtx,
  programId: PublicKey,
): Promise<void> {
  svm.airdrop(ctx.payer.publicKey, BigInt(10_000_000_000));

  // Anchor borsh encoding for create(name: String, description: String):
  //   discriminator: 8 bytes (sha256("global:create")[..8])
  //   name: u32 len LE + utf8 bytes
  //   description: u32 len LE + utf8 bytes
  const disc = anchorIxDiscriminator("create");
  const nameBytes = Buffer.from(ctx.name, "utf-8");
  const nameLen = Buffer.alloc(4);
  nameLen.writeUInt32LE(nameBytes.length);
  const descBytes = Buffer.from(ctx.description, "utf-8");
  const descLen = Buffer.alloc(4);
  descLen.writeUInt32LE(descBytes.length);

  const data = concatBytes(disc, nameLen, nameBytes, descLen, descBytes);

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: ctx.campaign, isSigner: false, isWritable: true },
      { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const tx = new Transaction().add(ix);
  tx.feePayer = ctx.payer.publicKey;
  const bh = svm.latestBlockhash();
  tx.recentBlockhash = bh;
  tx.sign(ctx.payer);

  const result = svm.sendTransaction(tx);
  if (!result) throw new Error("create_campaign tx failed");
}

export function campaignAccountsToCompare(ctx: CreateCampaignCtx): Array<{ pubkey: PublicKey; label: string }> {
  return [{ pubkey: ctx.campaign, label: "campaign" }];
}
