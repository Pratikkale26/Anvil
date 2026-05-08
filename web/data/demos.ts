/**
 * Landing-page demo + target metadata. Single source of truth shared by the
 * playground panels and the CU analysis table.
 */

import type { Target } from "@/lib/constants";

export type DemoName = "counter" | "vault" | "escrow" | "marketplace" | "staking" | "vesting" | "amm" | "multisig";

export type CuRow = {
  instruction: string;
  anchor: number;
  pinocchio: number;
  native: number;
};

export type Demo = {
  title: string;
  badge: string;
  description: string;
  available: boolean;
  cuSummary: CuRow[];
};

export const DEMOS: Record<DemoName, Demo> = {
  counter: {
    title: "Counter",
    badge: "Simplest",
    description: "PDA state, signer checks, overflow-safe arithmetic.",
    available: true,
    cuSummary: [
      { instruction: "initialize", anchor: 520, pinocchio: 108, native: 130 },
      { instruction: "increment", anchor: 290, pinocchio: 62, native: 75 },
      { instruction: "decrement", anchor: 290, pinocchio: 62, native: 75 },
      { instruction: "reset", anchor: 265, pinocchio: 55, native: 68 },
    ],
  },
  vault: {
    title: "Vault",
    badge: "SOL",
    description: "Multi-PDA lamport management. Deposit, withdraw, vault state.",
    available: true,
    cuSummary: [
      { instruction: "initialize", anchor: 580, pinocchio: 120, native: 145 },
      { instruction: "deposit", anchor: 620, pinocchio: 145, native: 165 },
      { instruction: "withdraw", anchor: 670, pinocchio: 158, native: 180 },
    ],
  },
  escrow: {
    title: "Escrow",
    badge: "SPL",
    description: "Token escrow with SPL transfers. Create, accept, cancel.",
    available: true,
    cuSummary: [
      { instruction: "create_escrow", anchor: 1150, pinocchio: 270, native: 310 },
      { instruction: "accept_escrow", anchor: 1480, pinocchio: 345, native: 390 },
      { instruction: "cancel_escrow", anchor: 980, pinocchio: 220, native: 255 },
    ],
  },
  marketplace: {
    title: "Marketplace",
    badge: "NFT",
    description: "NFT marketplace with admin fees, listing PDAs, vault transfers.",
    available: true,
    cuSummary: [
      { instruction: "initialize", anchor: 540, pinocchio: 115, native: 138 },
      { instruction: "list", anchor: 1180, pinocchio: 280, native: 320 },
      { instruction: "purchase", anchor: 1620, pinocchio: 380, native: 430 },
      { instruction: "delist", anchor: 980, pinocchio: 230, native: 268 },
    ],
  },
  staking: {
    title: "Staking",
    badge: "Time",
    description: "Pool init, token staking, unstaking, time-based rewards.",
    available: true,
    cuSummary: [
      { instruction: "initialize_pool", anchor: 620, pinocchio: 142, native: 168 },
      { instruction: "stake", anchor: 890, pinocchio: 205, native: 238 },
      { instruction: "unstake", anchor: 840, pinocchio: 195, native: 225 },
      { instruction: "claim_rewards", anchor: 920, pinocchio: 215, native: 248 },
    ],
  },
  vesting: {
    title: "Vesting",
    badge: "Schedule",
    description: "Linear token vesting with cliff. Create, release, revoke, close.",
    available: true,
    cuSummary: [
      { instruction: "create_vesting", anchor: 1320, pinocchio: 305, native: 348 },
      { instruction: "release", anchor: 1180, pinocchio: 270, native: 310 },
      { instruction: "revoke", anchor: 1120, pinocchio: 258, native: 295 },
      { instruction: "close", anchor: 850, pinocchio: 195, native: 222 },
    ],
  },
  amm: {
    title: "AMM",
    badge: "DeFi",
    description: "Constant-product AMM with LP mint, fees, protocol-fee accumulator.",
    available: true,
    cuSummary: [
      { instruction: "initialize_pool", anchor: 1620, pinocchio: 380, native: 430 },
      { instruction: "add_liquidity", anchor: 1480, pinocchio: 345, native: 390 },
      { instruction: "remove_liquidity", anchor: 1380, pinocchio: 320, native: 365 },
      { instruction: "swap", anchor: 1280, pinocchio: 295, native: 335 },
    ],
  },
  multisig: {
    title: "Multisig",
    badge: "Governance",
    description: "n-of-m multisig with Vec<Pubkey> owners, proposal + threshold gating.",
    available: true,
    cuSummary: [
      { instruction: "create", anchor: 580, pinocchio: 125, native: 145 },
      { instruction: "propose", anchor: 520, pinocchio: 110, native: 130 },
      { instruction: "approve", anchor: 380, pinocchio: 78, native: 92 },
      { instruction: "execute", anchor: 420, pinocchio: 88, native: 105 },
    ],
  },
};

export type LandingTarget = {
  id: Target;
  label: string;
  color: string;
  tagline: string;
  available: boolean;
};

export const LANDING_TARGETS: LandingTarget[] = [
  { id: "pinocchio", label: "Pinocchio", color: "#e8820a", tagline: "Zero-copy, zero-dependency by Anza", available: true },
  { id: "native", label: "Native", color: "#6b7bff", tagline: "Raw solana_program + borsh", available: true },
];

// Landing-only pipeline stages — distinct from the workbench's because the
// landing playground only does fetch → parse → emit (no separate validate step).
export type LandingStage = "idle" | "fetching" | "parsing" | "generating" | "done" | "error";

export const LANDING_STAGES: { id: Exclude<LandingStage, "idle" | "error">; label: string; sublabel: string }[] = [
  { id: "fetching", label: "Load fixture", sublabel: "GET /demo/:name" },
  { id: "parsing", label: "Parse IR", sublabel: "Anchor → SolanaIR" },
  { id: "generating", label: "Emit code", sublabel: "IR → Rust" },
  { id: "done", label: "Complete", sublabel: "Code ready" },
];

export const LANDING_STAGE_ORDER: Record<string, number> = {
  idle: -1,
  fetching: 0,
  parsing: 1,
  generating: 2,
  done: 3,
  error: -1,
};

export type { Target };
