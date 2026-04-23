/**
 * Landing-page demo + target metadata. Single source of truth shared by the
 * playground panels and the CU analysis table.
 */

import type { Target } from "@/lib/constants";

export type DemoName = "counter" | "vault" | "escrow" | "staking";

export type CuRow = {
  instruction: string;
  anchor: number;
  pinocchio: number;
  quasar: number;
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
      { instruction: "initialize", anchor: 520, pinocchio: 108, quasar: 95, native: 130 },
      { instruction: "increment", anchor: 290, pinocchio: 62, quasar: 55, native: 75 },
      { instruction: "decrement", anchor: 290, pinocchio: 62, quasar: 55, native: 75 },
      { instruction: "reset", anchor: 265, pinocchio: 55, quasar: 48, native: 68 },
    ],
  },
  vault: {
    title: "Vault",
    badge: "SOL",
    description: "Multi-PDA lamport management. Deposit, withdraw, vault state.",
    available: true,
    cuSummary: [
      { instruction: "initialize", anchor: 580, pinocchio: 120, quasar: 105, native: 145 },
      { instruction: "deposit", anchor: 620, pinocchio: 145, quasar: 128, native: 165 },
      { instruction: "withdraw", anchor: 670, pinocchio: 158, quasar: 140, native: 180 },
    ],
  },
  escrow: {
    title: "Escrow",
    badge: "SPL",
    description: "Token escrow with SPL transfers. Create, accept, cancel.",
    available: true,
    cuSummary: [
      { instruction: "create_escrow", anchor: 1150, pinocchio: 270, quasar: 240, native: 310 },
      { instruction: "accept_escrow", anchor: 1480, pinocchio: 345, quasar: 305, native: 390 },
      { instruction: "cancel_escrow", anchor: 980, pinocchio: 220, quasar: 195, native: 255 },
    ],
  },
  staking: {
    title: "Staking",
    badge: "Time",
    description: "Pool init, token staking, unstaking, time-based rewards.",
    available: true,
    cuSummary: [
      { instruction: "initialize_pool", anchor: 620, pinocchio: 142, quasar: 126, native: 168 },
      { instruction: "stake", anchor: 890, pinocchio: 205, quasar: 182, native: 238 },
      { instruction: "unstake", anchor: 840, pinocchio: 195, quasar: 172, native: 225 },
      { instruction: "claim_rewards", anchor: 920, pinocchio: 215, quasar: 190, native: 248 },
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
  { id: "quasar", label: "Quasar", color: "#0ea880", tagline: "Zero-allocation by Blueshift", available: true },
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
