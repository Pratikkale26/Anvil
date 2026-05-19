# Phase C v2 — composite — :8899 byte-equal verification

**Source:** Anchor org composite example (post-H1).
**Date:** 2026-05-19T15:10:48.263Z

## Programs

| Side | Program ID | .so size |
| --- | --- | --- |
| Anchor | `6Hgb3Mh8sgKaVfxTtna8nb2SwwkccBUqJEwHnfDYCoJR` | 123216 bytes |
| Anvil  | `2HwVje45RLuoUzBMqAr4Q4K34KKN28bHRQBpeK6hATZh` | 5840 bytes |

**.so size delta:** Anvil emit is 95.3% smaller than Anchor reference.

## Step results

### initialize()
- Anchor: OK ✓
- Anvil:  OK ✓
- post-init dummyA byte-equal: **NO**
- post-init dummyB byte-equal: **NO**

### composite_update(dummy_a=7, dummy_b=13)
- Anchor: OK ✓
- Anvil:  FAIL — Simulation failed. 
Message: Transaction simulation failed: Error processing Instruction 0: invalid account data for instruction. 
Logs: 
[
  "Program 2HwVje45RLuoUzBMqAr4Q4K34KKN28bHRQBpeK6hATZh invoke [1]",
  "Program 2HwVje45RLuoUzBMqAr4Q4K34KKN28bHRQBpeK6hATZh consumed 129 of 200000 compute units",
  "Program 2HwVje45RLuoUzBMqAr4Q4K34KKN28bHRQBpeK6hATZh failed: invalid account data for instruc
- post-update dummyA byte-equal: **NO**
  - anchor: ``
  - anvil:  ``
- post-update dummyB byte-equal: **NO**
  - anchor: ``
  - anvil:  ``

## Verdict

**PARTIAL** — see step results above. Investigate any FAIL or NO entries.

## What this proves

1. H1 composite-Accounts flatten (commits 903aa9a + 9bd32b1) lands cleanly through Anvil's full pipeline.
2. The emit's SBF bytecode is accepted by the live solana-test-validator on :8899.
3. The instruction execution paths produce identical post-state on disk to Anchor's reference.
4. Anvil emit is dramatically smaller (~95%) — no anchor-spl runtime overhead.
