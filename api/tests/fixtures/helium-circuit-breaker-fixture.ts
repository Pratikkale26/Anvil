/**
 * Shared fixture for Helium's circuit-breaker program.
 *
 * Exercises: init PDA with seeds, SPL Token interactions, windowed
 * circuit breaker state management. Multi-file Anchor program (12 .rs files).
 *
 * Smoke path: initialize_account_windowed_breaker_v0
 *   - Creates a circuit breaker PDA for a token account
 *   - Seeds: ["account_windowed_breaker", token_account.key()]
 *   - Args: authority (Pubkey), owner (Pubkey), config (WindowedCircuitBreakerConfigV0)
 *
 * First multi-file real-world program byte-equal differential.
 */
import {
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  anchorIxDiscriminator,
  concatBytes,
  encodeU64LE,
  Keypair,
  PublicKey,
  LiteSVM,
} from "../differential-harness.ts";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { collectProjectFilesFromEntry, buildProjectSource } from "../../src/parser/project-source.ts";

const REPO_URL = "https://github.com/helium/helium-program-library";
export const REPO_PATH = "/tmp/helium-program-library";
export const CRATE_DIR = `${REPO_PATH}/programs/circuit-breaker`;
export const LIB_RS = `${CRATE_DIR}/src/lib.rs`;
export const PROGRAM_ID = "circAbx64bbsscPbQzZAUvuXpHqrCe6fLMzc2uKXz9g";

export function ensureRepoCloned(): void {
  if (existsSync(LIB_RS)) return;
  const r = spawnSync(
    "git",
    ["clone", "--depth=1", "--filter=blob:none", REPO_URL, REPO_PATH],
    { stdio: "inherit", timeout: 120_000 },
  );
  if (r.status !== 0) {
    console.warn("[helium-circuit-breaker-fixture] clone failed; fixtures will skip");
  }
}

export function loadAnchorSource(): string {
  if (!existsSync(LIB_RS)) return "// MISSING";
  const files = collectProjectFilesFromEntry(LIB_RS);
  const key = files.find((f) => f.path === "lib.rs")?.path ?? files[0]?.path;
  return buildProjectSource(key!, files);
}

// Borsh-encode InitializeAccountWindowedBreakerArgsV0:
//   authority: Pubkey (32 bytes)
//   owner: Pubkey (32 bytes)
//   config: WindowedCircuitBreakerConfigV0 {
//     window_size_seconds: u64 (8 bytes)
//     threshold_type: ThresholdType enum (1 byte: 0=Percent, 1=Absolute)
//     threshold: u64 (8 bytes)
//   }
function encodeInitArgs(authority: Uint8Array, owner: Uint8Array): Uint8Array {
  const windowSizeSeconds = encodeU64LE(BigInt(3600)); // 1 hour
  const thresholdType = new Uint8Array([1]); // Absolute
  const threshold = encodeU64LE(BigInt(1_000_000_000)); // 1 SOL worth
  return concatBytes(authority, owner, windowSizeSeconds, thresholdType, threshold);
}

export async function setupCircuitBreaker() {
  const payer = Keypair.generate();
  const owner = Keypair.generate();
  const programId = new PublicKey(PROGRAM_ID);

  const mintKeypair = Keypair.generate();
  const tokenAccountKeypair = Keypair.generate();

  const [circuitBreakerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("account_windowed_breaker"), tokenAccountKeypair.publicKey.toBytes()],
    programId,
  );

  return {
    payer,
    owner,
    mintKeypair,
    tokenAccountKeypair,
    circuitBreakerPda,
    programId,
  };
}

export async function callCircuitBreaker(
  svm: LiteSVM,
  ctx: Awaited<ReturnType<typeof setupCircuitBreaker>>,
  programId: PublicKey,
) {
  const { payer, owner, mintKeypair, tokenAccountKeypair, circuitBreakerPda } = ctx;

  // Airdrop to payer + owner
  svm.airdrop(payer.publicKey, BigInt(10_000_000_000));
  svm.airdrop(owner.publicKey, BigInt(10_000_000_000));

  // 1. Create the SPL Token mint
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");
  const mintSpace = 82; // Mint account size
  const mintRent = BigInt(1_461_600);

  const createMintIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: mintKeypair.publicKey,
    lamports: Number(mintRent),
    space: mintSpace,
    programId: TOKEN_PROGRAM_ID,
  });

  // Initialize mint: discriminator 0, decimals 9, mint_authority = owner
  const initMintData = concatBytes(
    new Uint8Array([0]), // InitializeMint instruction
    new Uint8Array([9]), // decimals
    owner.publicKey.toBytes(), // mint_authority
    new Uint8Array([1]), // COption::Some for freeze_authority
    owner.publicKey.toBytes(), // freeze_authority
  );
  const initMintIx = new TransactionInstruction({
    keys: [
      { pubkey: mintKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data: Buffer.from(initMintData),
  });

  const tx1 = new Transaction().add(createMintIx, initMintIx);
  tx1.recentBlockhash = svm.latestBlockhash();
  tx1.feePayer = payer.publicKey;
  tx1.sign(payer, mintKeypair);
  svm.sendTransaction(tx1);

  // 2. Create token account
  const tokenAccountSpace = 165; // Token account size
  const tokenAccountRent = BigInt(2_039_280);

  const createTokenAccountIx = SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: tokenAccountKeypair.publicKey,
    lamports: Number(tokenAccountRent),
    space: tokenAccountSpace,
    programId: TOKEN_PROGRAM_ID,
  });

  // Initialize account: discriminator 1, owner = owner
  const initAccountData = concatBytes(
    new Uint8Array([1]), // InitializeAccount instruction
  );
  const initAccountIx = new TransactionInstruction({
    keys: [
      { pubkey: tokenAccountKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: mintKeypair.publicKey, isSigner: false, isWritable: false },
      { pubkey: owner.publicKey, isSigner: false, isWritable: false },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data: Buffer.from(initAccountData),
  });

  const tx2 = new Transaction().add(createTokenAccountIx, initAccountIx);
  tx2.recentBlockhash = svm.latestBlockhash();
  tx2.feePayer = payer.publicKey;
  tx2.sign(payer, tokenAccountKeypair);
  svm.sendTransaction(tx2);

  // 3. Call initialize_account_windowed_breaker_v0
  const disc = anchorIxDiscriminator("initialize_account_windowed_breaker_v0");
  const args = encodeInitArgs(owner.publicKey.toBytes(), owner.publicKey.toBytes());
  const data = concatBytes(disc, args);

  const ix = new TransactionInstruction({
    keys: [
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: circuitBreakerPda, isSigner: false, isWritable: true },
      { pubkey: tokenAccountKeypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data: Buffer.from(data),
  });

  const tx3 = new Transaction().add(ix);
  tx3.recentBlockhash = svm.latestBlockhash();
  tx3.feePayer = payer.publicKey;
  tx3.sign(payer, owner);
  try {
    const result = svm.sendTransaction(tx3);
    console.log(`[circuit-breaker] init tx result:`, typeof result, result ? "ok" : "null");
  } catch (e: any) {
    console.error(`[circuit-breaker] init tx FAILED:`, e.message?.slice(0, 300));
  }
  // Check if PDA was created
  try {
    const acct = svm.getAccount(circuitBreakerPda);
    console.log(`[circuit-breaker] PDA exists: ${!!acct}, lamports: ${acct?.lamports}`);
  } catch {
    console.log(`[circuit-breaker] PDA does NOT exist after tx`);
  }
}

export function circuitBreakerAccountsToCompare(
  ctx: Awaited<ReturnType<typeof setupCircuitBreaker>>,
) {
  return [
    { pubkey: ctx.circuitBreakerPda, label: "circuit_breaker_pda" },
  ];
}
