/**
 * Top-level demo orchestrator. Runs all 7 byte-equal demos sequentially
 * against the local solana-test-validator and prints a tweet-ready
 * report per demo + a final aggregate panel.
 *
 * Prerequisites:
 *   1. solana-test-validator running at http://127.0.0.1:8899 with
 *      Metaplex Token Metadata cloned:
 *
 *      solana-test-validator --reset \
 *        --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
 *        --url mainnet-beta
 *
 *   2. `bun build.ts` has been run (generates keypairs + .sos)
 *   3. `bun install` for @solana/web3.js + @solana/spl-token
 *
 * Run: `bun test.ts`
 */
import { writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { RPC, PAYER_PATH } from "./paths.ts";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

import * as Counter from "./test-counter.ts";
import * as Vault from "./test-vault.ts";
import * as T22 from "./test-t22-non-transferable.ts";
import * as Amm from "./test-amm.ts";
import * as SplTokenMinter from "./test-spl-token-minter.ts";
import * as NftMinter from "./test-nft-minter.ts";
import * as Escrow2025 from "./test-escrow2025.ts";

const METAPLEX_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const connection = new Connection(RPC, "confirmed");

function renderBox(title: string, lines: string[]): string {
  const width = 78;
  const top = "┌─ " + title + " " + "─".repeat(Math.max(0, width - title.length - 4)) + "┐";
  const bot = "└" + "─".repeat(width) + "┘";
  return [top, ...lines.map((l) => "│ " + l), bot].join("\n");
}

function renderDemo(r: any): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(r.description);
  lines.push("");
  lines.push(`anchor program: ${r.anchorId}`);
  lines.push(`anvil program:  ${r.anvilId}`);
  if (r.txs?.length) {
    lines.push("");
    lines.push("transactions:");
    for (const t of r.txs) {
      lines.push(`  ${String(t.label).padEnd(28)} anchor=${t.anchor.slice(0, 16)}…`);
      lines.push(`  ${" ".repeat(28)} anvil =${t.anvil.slice(0, 16)}…`);
    }
  }
  if (r.states?.length) {
    lines.push("");
    lines.push("on-chain state byte-comparison:");
    for (const s of r.states) {
      const mark = s.equal ? "✓ BYTE-EQUAL" : "✗ DIVERGED";
      lines.push(`  ${String(s.account).padEnd(24)} ${mark}`);
    }
  }
  if (r.status === "failed") {
    lines.push("");
    lines.push(`✗ failed — ${r.failure ?? "unknown"}`);
  }
  lines.push("");
  lines.push(`binary size:   Anchor ${(r.anchorSize / 1024).toFixed(0).padStart(4)}KB  →  Anvil ${(r.anvilSize / 1024).toFixed(0).padStart(3)}KB  (${r.sizeReduction.toFixed(1)}% smaller)`);
  lines.push("");
  lines.push("verify on chain:");
  lines.push(`  solana program show ${r.anchorId} --url ${RPC}`);
  lines.push(`  solana program show ${r.anvilId} --url ${RPC}`);
  return renderBox(String(r.name).toUpperCase(), lines);
}

async function main(): Promise<void> {
  console.log("═".repeat(80));
  console.log("           ⚒  Anvil on-chain byte-equal demo — Anchor → Pinocchio");
  console.log("═".repeat(80));
  const ver = await connection.getVersion();
  console.log(`RPC:      ${RPC}`);
  console.log(`Agave:    ${ver["solana-core"]}`);
  console.log(`Slot:     ${await connection.getSlot()}`);
  const payer = Keypair.fromSecretKey(Buffer.from(JSON.parse(readFileSync(PAYER_PATH, "utf-8"))));
  console.log(`Payer:    ${payer.publicKey.toBase58()}`);
  const mpl = await connection.getAccountInfo(METAPLEX_PROGRAM);
  console.log(`Metaplex: ${mpl?.executable ? `✓ loaded (${(mpl.data.length / 1024).toFixed(0)}KB)` : "✗ NOT loaded — Metaplex demos will fail"}`);

  const demos = [
    { name: "counter", fn: Counter.runDemo },
    { name: "vault", fn: Vault.runDemo },
    { name: "t22-non-transferable", fn: T22.runDemo },
    { name: "amm", fn: Amm.runDemo },
    { name: "spl-token-minter", fn: SplTokenMinter.runDemo },
    { name: "nft-minter", fn: NftMinter.runDemo },
    { name: "escrow2025", fn: Escrow2025.runDemo },
  ];

  const results: any[] = [];
  for (const d of demos) {
    try {
      console.log(`\n▶ ${d.name}…`);
      results.push(await d.fn());
    } catch (e) {
      console.log(`✗ ${d.name}: ${(e as Error).message?.slice(0, 200)}`);
      results.push({
        name: d.name, description: "(failed)",
        anchorId: "", anvilId: "", txs: [], states: [],
        anchorSize: 0, anvilSize: 0, sizeReduction: 0,
        status: "failed", failure: (e as Error).message?.slice(0, 200),
      });
    }
  }

  console.log("\n\n" + "═".repeat(80));
  console.log("                              FINAL REPORT");
  console.log("═".repeat(80));
  for (const r of results) console.log("\n" + renderDemo(r));

  const byteEq = results.filter((r) => r.status === "byte-equal").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const totalA = results.reduce((s, r) => s + r.anchorSize, 0);
  const totalV = results.reduce((s, r) => s + r.anvilSize, 0);
  const reduction = totalA > 0 ? (1 - totalV / totalA) * 100 : 0;
  console.log("\n\n" + "═".repeat(80));
  console.log("                              AGGREGATE");
  console.log("═".repeat(80));
  console.log(`\n  ${byteEq}/${results.length} byte-equal verified (instruction tx + on-chain state byte-comparison)`);
  if (failed > 0) console.log(`  ${failed} failures`);
  console.log(`\n  total binary size:  Anchor ${(totalA / 1024).toFixed(0)}KB  →  Anvil ${(totalV / 1024).toFixed(0)}KB  (${reduction.toFixed(1)}% smaller overall)`);

  writeFileSync(
    "./test-results.json",
    JSON.stringify({ rpc: RPC, slot: await connection.getSlot(), payer: payer.publicKey.toBase58(), results }, null, 2),
  );
  console.log(`\n  Full JSON: ${process.cwd()}/test-results.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
