import type { SolanaIR, CUEstimate, Instruction } from "../ir/schema.js";

/**
 * Static CU cost tables based on Helius/Anza benchmarks and community measurements.
 *
 * References:
 *  - https://helius.dev/blog/the-complete-guide-to-solana-development-for-ethereum-developers
 *  - https://anza.xyz/blog/pinocchio
 *  - https://blueshift.gg/quasar
 */

const ANCHOR_CU = {
  base: 50,                 // discriminator check + program entrypoint
  accountDeserialize: 120,  // borsh deserialization per account (average)
  signerCheck: 30,          // per signer via macro
  mutCheck: 10,             // per mut account
  initAccount: 200,         // account initialization (rent calc + alloc)
  initIfNeeded: 160,        // init_if_needed (conditional alloc)
  hasOne: 25,               // has_one constraint check
  ownerCheck: 20,           // owner constraint
  seedsCheck: 35,           // PDA derivation + verify
  bumpCheck: 15,            // bump seed verify
  closeAccount: 40,         // close constraint (lamport transfer)
  tokenConstraint: 30,      // token::mint / token::authority check
} as const;

const PINOCCHIO_CU = {
  base: 15,
  accountZeroCopy: 12,      // zero-copy read (no alloc)
  signerCheck: 15,          // manual pubkey comparison
  mutCheck: 5,
  initAccount: 80,          // manual space allocation
  initIfNeeded: 65,
  hasOne: 12,               // manual field comparison
  ownerCheck: 10,
  seedsCheck: 28,           // PDA derivation (same syscall, slightly less overhead)
  bumpCheck: 8,
  closeAccount: 20,
  tokenConstraint: 15,
} as const;

const QUASAR_CU = {
  base: 12,
  accountZeroCopy: 10,      // zero-allocation read
  signerCheck: 12,
  mutCheck: 4,
  initAccount: 70,
  initIfNeeded: 58,
  hasOne: 10,
  ownerCheck: 8,
  seedsCheck: 25,
  bumpCheck: 6,
  closeAccount: 18,
  tokenConstraint: 12,
} as const;

const NATIVE_CU = {
  base: 20,
  accountZeroCopy: 18,      // manual deserialization (less overhead than borsh)
  signerCheck: 20,
  mutCheck: 7,
  initAccount: 120,
  initIfNeeded: 95,
  hasOne: 18,
  ownerCheck: 14,
  seedsCheck: 30,
  bumpCheck: 10,
  closeAccount: 28,
  tokenConstraint: 20,
} as const;

function estimateInstructionCU(
  instr: Instruction,
  costs: typeof ANCHOR_CU | typeof PINOCCHIO_CU | typeof QUASAR_CU | typeof NATIVE_CU
): number {
  let cu = costs.base;

  for (const acc of instr.accounts) {
    // Skip program accounts (SystemProgram, TokenProgram, etc.)
    if (
      acc.accountType.includes("Program") ||
      acc.accountType.includes("SystemProgram") ||
      acc.accountType.includes("TokenProgram") ||
      acc.accountType.includes("AssociatedToken")
    ) {
      continue;
    }

    // Base account read cost
    if ("accountDeserialize" in costs) {
      cu += (costs as typeof ANCHOR_CU).accountDeserialize;
    } else {
      cu += (costs as typeof PINOCCHIO_CU).accountZeroCopy;
    }

    if (acc.isSigner) cu += costs.signerCheck;
    if (acc.isMut && !acc.isInit) cu += costs.mutCheck;

    for (const c of acc.constraints) {
      switch (c.kind) {
        case "init":          cu += costs.initAccount; break;
        case "init_if_needed": cu += costs.initIfNeeded; break;
        case "has_one":       cu += costs.hasOne; break;
        case "owner":         cu += costs.ownerCheck; break;
        case "seeds":         cu += costs.seedsCheck; break;
        case "bump":          cu += costs.bumpCheck; break;
        case "close":         cu += costs.closeAccount; break;
        case "token::mint":
        case "token::authority":
          cu += costs.tokenConstraint; break;
      }
    }
  }

  return Math.round(cu);
}

function pct(from: number, to: number): string {
  return `${Math.round(((from - to) / from) * 100)}%`;
}

export function analyzeCU(ir: SolanaIR): CUEstimate[] {
  return ir.instructions.map((instr) => {
    const anchor     = estimateInstructionCU(instr, ANCHOR_CU);
    const pinocchio  = estimateInstructionCU(instr, PINOCCHIO_CU);
    const quasar     = estimateInstructionCU(instr, QUASAR_CU);
    const native     = estimateInstructionCU(instr, NATIVE_CU);

    return {
      instruction:        instr.name,
      anchor,
      pinocchio,
      quasar,
      native,
      savingsPinocchio:   pct(anchor, pinocchio),
      savingsQuasar:      pct(anchor, quasar),
    };
  });
}
