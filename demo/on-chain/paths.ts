/**
 * Shared path/config resolution for the on-chain demo. All hardcoded
 * absolute paths in the per-fixture test files route through these env-
 * var-overridable defaults so the demo works on any machine.
 *
 * Defaults assume:
 *   - This directory contains the keypair JSONs (created by build.ts)
 *   - build/ subdirectory contains the .so files (created by build.ts)
 *   - The user's solana CLI default keypair lives at ~/.config/solana/id.json
 *   - solana-test-validator is running at http://127.0.0.1:8899
 *
 * Override any with env vars: ANVIL_DEMO_BUILD_DIR, ANVIL_DEMO_KEYPAIR_DIR,
 * ANVIL_DEMO_PAYER, ANVIL_DEMO_RPC.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

export const ROOT = resolve(HERE);
export const BUILD_DIR = process.env["ANVIL_DEMO_BUILD_DIR"] ?? resolve(ROOT, "build");
export const KEYPAIR_DIR = process.env["ANVIL_DEMO_KEYPAIR_DIR"] ?? ROOT;
export const PAYER_PATH = process.env["ANVIL_DEMO_PAYER"] ?? resolve(homedir(), ".config/solana/id.json");
export const RPC = process.env["ANVIL_DEMO_RPC"] ?? "http://127.0.0.1:8899";

export function soPath(fixture: string, label: "anchor" | "anvil"): string {
  return resolve(BUILD_DIR, `${fixture}_${label}.so`);
}
export function kpPath(fixture: string, label: "anchor" | "anvil"): string {
  return resolve(KEYPAIR_DIR, `${fixture}-${label}.json`);
}
