/**
 * AMM byte-equal test — initialize_pool + add_liquidity + swap.
 *
 * Per-side strategy:
 *   - SHARE: admin (payer), token_mint_a, token_mint_b, instruction args
 *   - FRESH: lp_mint Keypair (non-PDA), user Keypair, user ATAs
 *
 * Pool PDA differs across sides at: lp_mint pubkey, bump, vault_a_bump,
 * vault_b_bump (program IDs differ -> PDAs derive differently). So we
 * byte-compare only the numeric-state slice:
 *   offset 136..216 = fee_rate, initial_price, reserve_a, reserve_b,
 *   lp_supply, total_fees_a/b, protocol_fees_a/b, protocol_fee_rate.
 * Plus vault token amounts (u64 at offset 64..72 of SPL Token Account).
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
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

// RPC imported from ./paths.ts
const connection = new Connection(RPC, "confirmed");

type StateCompare = { account: string; anchor: string; anvil: string; equal: boolean };
type TxRecord = { label: string; anchor: string; anvil: string };

export interface DemoResult {
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
function boolByte(b: boolean): Buffer {
  return Buffer.from([b ? 1 : 0]);
}
function fileSize(p: string): number {
  return existsSync(p) ? statSync(p).size : 0;
}

async function deploy(soPath: string, kpPath: string, label: string): Promise<PublicKey> {
  const kp = loadKp(kpPath);
  const info = await connection.getAccountInfo(kp.publicKey);
  if (info?.executable) return kp.publicKey;
  if (!existsSync(soPath)) throw new Error(`missing .so: ${soPath}`);
  const r = spawnSync("solana", [
    "--url", RPC, "program", "deploy",
    "--program-id", kpPath,
    "--upgrade-authority", PAYER_PATH,
    soPath,
  ], { encoding: "utf-8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`deploy ${label} failed: ${r.stderr.slice(0, 400)}`);
  return kp.publicKey;
}

/** Run instruction sequence against one program, return collected state + tx sigs. */
async function runOneSide(
  label: string,
  programId: PublicKey,
  payer: Keypair,
  tokenMintA: PublicKey,
  tokenMintB: PublicKey,
): Promise<{
  txs: Record<string, string>;
  poolData: Buffer;
  vaultAData: Buffer;
  vaultBData: Buffer;
  userLpAmount: bigint;
  userAAmount: bigint;
  userBAmount: bigint;
}> {
  // Fresh user + lp_mint per side
  const user = Keypair.generate();
  const lpMint = Keypair.generate();

  // Fund user with SOL
  const fundTx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: user.publicKey,
    lamports: 5 * LAMPORTS_PER_SOL,
  }));
  await sendAndConfirmTransaction(connection, fundTx, [payer], { commitment: "confirmed" });

  // Create user ATAs for mint A + mint B, mint tokens to user
  const userTokenA = await getOrCreateAssociatedTokenAccount(connection, payer, tokenMintA, user.publicKey);
  const userTokenB = await getOrCreateAssociatedTokenAccount(connection, payer, tokenMintB, user.publicKey);
  await mintTo(connection, payer, tokenMintA, userTokenA.address, payer, 1_000_000_000n);
  await mintTo(connection, payer, tokenMintB, userTokenB.address, payer, 1_000_000_000n);

  // Derive PDAs
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMintA.toBuffer(), tokenMintB.toBuffer()],
    programId,
  );
  const [vaultA] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_a"), poolPda.toBuffer()],
    programId,
  );
  const [vaultB] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_b"), poolPda.toBuffer()],
    programId,
  );

  // user_lp_token is an ATA owned by user for lpMint
  const userLpToken = getAssociatedTokenAddressSync(lpMint.publicKey, user.publicKey);

  const txs: Record<string, string> = {};

  // ── 1. initialize_pool ───────────────────────────────────────────────
  // Account order from amm.rs InitializePool:
  //   pool, vault_a, vault_b, lp_mint, token_mint_a, token_mint_b,
  //   admin (Signer mut), token_program, system_program
  // Note: anchor's #[account(init)] needs rent sysvar — implicit since Anchor adds it,
  //   but emitted account order from #[derive(Accounts)] is exactly the field order.
  const initPoolIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: vaultA, isSigner: false, isWritable: true },
      { pubkey: vaultB, isSigner: false, isWritable: true },
      { pubkey: lpMint.publicKey, isSigner: true, isWritable: true },
      { pubkey: tokenMintA, isSigner: false, isWritable: false },
      { pubkey: tokenMintB, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true }, // admin
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("initialize_pool"),
      u64le(30n),        // fee_rate (0.3%)
      u64le(1_000_000n), // initial_price
    ]),
  });
  const initTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(initPoolIx);
  txs["init_pool"] = await sendAndConfirmTransaction(
    connection, initTx, [payer, lpMint], { commitment: "confirmed" },
  );

  // Create user_lp_token ATA now that lp_mint exists
  await getOrCreateAssociatedTokenAccount(connection, payer, lpMint.publicKey, user.publicKey);

  // ── 2. add_liquidity ─────────────────────────────────────────────────
  // Account order from amm.rs AddLiquidity:
  //   user, pool, user_token_a, user_token_b, vault_a, vault_b,
  //   lp_mint, user_lp_token, token_program, system_program
  const addLiqIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: userTokenA.address, isSigner: false, isWritable: true },
      { pubkey: userTokenB.address, isSigner: false, isWritable: true },
      { pubkey: vaultA, isSigner: false, isWritable: true },
      { pubkey: vaultB, isSigner: false, isWritable: true },
      { pubkey: lpMint.publicKey, isSigner: false, isWritable: true },
      { pubkey: userLpToken, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("add_liquidity"),
      u64le(100_000_000n), // amount_a_desired
      u64le(200_000_000n), // amount_b_desired
      u64le(0n),           // amount_a_min
      u64le(0n),           // amount_b_min
    ]),
  });
  const addLiqTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(addLiqIx);
  txs["add_liquidity"] = await sendAndConfirmTransaction(
    connection, addLiqTx, [payer, user], { commitment: "confirmed" },
  );

  // ── 3. swap (a → b) ──────────────────────────────────────────────────
  // Account order from amm.rs Swap:
  //   user, pool, user_token_in, user_token_out, vault_a, vault_b, token_program
  const swapIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: user.publicKey, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: userTokenA.address, isSigner: false, isWritable: true }, // user_token_in (A, since a_to_b=true)
      { pubkey: userTokenB.address, isSigner: false, isWritable: true }, // user_token_out (B)
      { pubkey: vaultA, isSigner: false, isWritable: true },
      { pubkey: vaultB, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("swap"),
      u64le(10_000_000n), // amount_in
      u64le(0n),          // minimum_amount_out
      boolByte(true),     // a_to_b
    ]),
  });
  const swapTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(swapIx);
  txs["swap"] = await sendAndConfirmTransaction(
    connection, swapTx, [payer, user], { commitment: "confirmed" },
  );

  // Fetch final state
  const poolAcct = await connection.getAccountInfo(poolPda);
  if (!poolAcct) throw new Error(`${label}: pool PDA missing after txs`);
  const vaultAAcct = await connection.getAccountInfo(vaultA);
  if (!vaultAAcct) throw new Error(`${label}: vault_a missing`);
  const vaultBAcct = await connection.getAccountInfo(vaultB);
  if (!vaultBAcct) throw new Error(`${label}: vault_b missing`);

  const userLpInfo = await getAccount(connection, userLpToken);
  const userAInfo = await getAccount(connection, userTokenA.address);
  const userBInfo = await getAccount(connection, userTokenB.address);

  return {
    txs,
    poolData: poolAcct.data,
    vaultAData: vaultAAcct.data,
    vaultBData: vaultBAcct.data,
    userLpAmount: userLpInfo.amount,
    userAAmount: userAInfo.amount,
    userBAmount: userBInfo.amount,
  };
}

export async function runDemo(): Promise<DemoResult> {
  const anchorPath = soPath("amm", "anchor");
  const anvilPath = soPath("amm", "anvil");
  const anchorId = await deploy(anchorPath, kpPath("amm", "anchor"), "anchor");
  const anvilId = await deploy(anvilPath, kpPath("amm", "anvil"), "anvil");
  const payer = loadKp(PAYER_PATH);

  const result: DemoResult = {
    name: "amm",
    description:
      "AMM byte-equal: initialize_pool(fee=30, price=1e6) + add_liquidity(100M/200M) + swap(a→b 10M) — compare pool numeric state + vault amounts + user balances",
    anchorId: anchorId.toBase58(),
    anvilId: anvilId.toBase58(),
    txs: [],
    states: [],
    anchorSize: fileSize(anchorPath),
    anvilSize: fileSize(anvilPath),
    sizeReduction: 0,
    status: "byte-equal",
  };

  try {
    // Share mints across sides (TOKEN_PROGRAM-owned, not AMM-bound)
    const tokenMintA = await createMint(connection, payer, payer.publicKey, null, 6);
    const tokenMintB = await createMint(connection, payer, payer.publicKey, null, 6);

    const anchorRun = await runOneSide("anchor", anchorId, payer, tokenMintA, tokenMintB);
    const anvilRun = await runOneSide("anvil", anvilId, payer, tokenMintA, tokenMintB);

    result.txs.push({ label: "init_pool", anchor: anchorRun.txs["init_pool"]!, anvil: anvilRun.txs["init_pool"]! });
    result.txs.push({ label: "add_liquidity", anchor: anchorRun.txs["add_liquidity"]!, anvil: anvilRun.txs["add_liquidity"]! });
    result.txs.push({ label: "swap (a→b)", anchor: anchorRun.txs["swap"]!, anvil: anvilRun.txs["swap"]! });

    // ── Pool numeric state slice ─────────────────────────────────────
    // AmmPool layout (post-8B disc):
    //   admin: Pubkey         offset 8..40
    //   token_mint_a: Pubkey  offset 40..72
    //   token_mint_b: Pubkey  offset 72..104
    //   lp_mint: Pubkey       offset 104..136   <- DIFFERS (fresh Keypair per side)
    //   fee_rate: u64         offset 136..144
    //   initial_price: u64    offset 144..152
    //   reserve_a: u64        offset 152..160
    //   reserve_b: u64        offset 160..168
    //   lp_supply: u64        offset 168..176
    //   total_fees_a: u64     offset 176..184
    //   total_fees_b: u64     offset 184..192
    //   protocol_fees_a: u64  offset 192..200
    //   protocol_fees_b: u64  offset 200..208
    //   protocol_fee_rate:u64 offset 208..216
    //   bump, vault_a/b_bump  offset 216..219   <- DIFFERS (different programId)
    //   is_frozen: bool       offset 219..220
    const numStart = 136, numEnd = 216;
    const anchorNumeric = anchorRun.poolData.subarray(numStart, numEnd);
    const anvilNumeric = anvilRun.poolData.subarray(numStart, numEnd);
    result.states.push({
      account: "pool numeric state (offset 136..216)",
      anchor: anchorNumeric.toString("hex"),
      anvil: anvilNumeric.toString("hex"),
      equal: Buffer.compare(anchorNumeric, anvilNumeric) === 0,
    });

    // is_frozen byte (offset 219)
    result.states.push({
      account: "pool is_frozen byte",
      anchor: anchorRun.poolData.subarray(219, 220).toString("hex"),
      anvil: anvilRun.poolData.subarray(219, 220).toString("hex"),
      equal: anchorRun.poolData[219] === anvilRun.poolData[219],
    });

    // ── Vault token amounts ──────────────────────────────────────────
    // SPL Token Account layout: mint(32) | owner(32) | amount(u64 at 64..72) | …
    const vaultAAmountAnchor = anchorRun.vaultAData.readBigUInt64LE(64);
    const vaultAAmountAnvil = anvilRun.vaultAData.readBigUInt64LE(64);
    result.states.push({
      account: "vault_a token amount",
      anchor: vaultAAmountAnchor.toString(),
      anvil: vaultAAmountAnvil.toString(),
      equal: vaultAAmountAnchor === vaultAAmountAnvil,
    });
    const vaultBAmountAnchor = anchorRun.vaultAData.length > 0 ? anchorRun.vaultBData.readBigUInt64LE(64) : 0n;
    const vaultBAmountAnvil = anvilRun.vaultBData.readBigUInt64LE(64);
    result.states.push({
      account: "vault_b token amount",
      anchor: vaultBAmountAnchor.toString(),
      anvil: vaultBAmountAnvil.toString(),
      equal: vaultBAmountAnchor === vaultBAmountAnvil,
    });

    // ── User balances ────────────────────────────────────────────────
    result.states.push({
      account: "user_lp_token amount",
      anchor: anchorRun.userLpAmount.toString(),
      anvil: anvilRun.userLpAmount.toString(),
      equal: anchorRun.userLpAmount === anvilRun.userLpAmount,
    });
    result.states.push({
      account: "user_token_a amount (post-swap)",
      anchor: anchorRun.userAAmount.toString(),
      anvil: anvilRun.userAAmount.toString(),
      equal: anchorRun.userAAmount === anvilRun.userAAmount,
    });
    result.states.push({
      account: "user_token_b amount (post-swap)",
      anchor: anchorRun.userBAmount.toString(),
      anvil: anvilRun.userBAmount.toString(),
      equal: anchorRun.userBAmount === anvilRun.userBAmount,
    });

    if (result.states.some((s) => !s.equal)) result.status = "failed";
  } catch (e) {
    result.status = "failed";
    result.failure = (e as Error).message?.slice(0, 400);
  }

  result.sizeReduction = result.anchorSize > 0
    ? (1 - result.anvilSize / result.anchorSize) * 100
    : 0;
  return result;
}

function renderDemo(r: DemoResult): string {
  const lines: string[] = [];
  lines.push("═".repeat(80));
  lines.push(`  ${r.name.toUpperCase()}`);
  lines.push("═".repeat(80));
  lines.push("");
  lines.push(r.description);
  lines.push("");
  if (r.anchorId) {
    lines.push(`anchor program: ${r.anchorId}`);
    lines.push(`anvil program:  ${r.anvilId}`);
  }
  if (r.txs.length > 0) {
    lines.push("");
    lines.push("transactions:");
    for (const t of r.txs) {
      lines.push(`  ${t.label.padEnd(18)} anchor=${t.anchor.slice(0, 16)}…`);
      lines.push(`  ${" ".repeat(18)} anvil =${t.anvil.slice(0, 16)}…`);
    }
  }
  if (r.states.length > 0) {
    lines.push("");
    lines.push("on-chain state comparison:");
    for (const s of r.states) {
      const mark = s.equal ? "✓ EQUAL" : "✗ DIVERGED";
      lines.push(`  ${s.account.padEnd(40)} ${mark}`);
      if (s.anchor.length < 80) {
        lines.push(`    anchor: ${s.anchor}`);
        lines.push(`    anvil : ${s.anvil}`);
      } else {
        lines.push(`    anchor: ${s.anchor.slice(0, 70)}…`);
        lines.push(`    anvil : ${s.anvil.slice(0, 70)}…`);
      }
    }
  }
  if (r.status === "failed") {
    lines.push("");
    lines.push(`✗ status: failed — ${r.failure ?? "state divergence"}`);
  } else if (r.status === "byte-equal") {
    lines.push("");
    lines.push(`✓ status: byte-equal across all ${r.states.length} state slices`);
  }
  lines.push("");
  lines.push(
    `binary size: Anchor ${(r.anchorSize / 1024).toFixed(0)}KB → Anvil ${(r.anvilSize / 1024).toFixed(0)}KB (${r.sizeReduction.toFixed(1)}% smaller)`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  runDemo().then((r) => {
    console.log(renderDemo(r));
    process.exit(r.status === "failed" ? 1 : 0);
  }).catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
