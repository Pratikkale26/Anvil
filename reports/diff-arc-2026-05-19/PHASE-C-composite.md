# Phase C v2 — composite — :8899 byte-equal verification

**Source:** Anchor org composite example (post-H1).
**Date:** 2026-05-19T15:16:50.443Z

## Programs

| Side | Program ID | .so size |
| --- | --- | --- |
| Anchor | `Dt4rbzVLx69qKFYg5mMaxnvJqYNcis5bhWkiC9deANHJ` | 123216 bytes |
| Anvil  | `FgaE8PKvXJDxcuHcrMWSybgDWUp9vrDALWT7mXiEnVyc` | 6176 bytes |

**.so size delta:** Anvil emit is 95.0% smaller than Anchor reference.

## Step results

### initialize()
- Anchor: OK ✓
- Anvil:  OK ✓
- post-init dummyA byte-equal: **YES**
- post-init dummyB byte-equal: **YES**

### composite_update(dummy_a=7, dummy_b=13)
- Anchor: OK ✓
- Anvil:  OK ✓
- post-update dummyA byte-equal: **YES**
  - anchor: `f8ca38c22234a46f0700000000000000`
  - anvil:  `f8ca38c22234a46f0700000000000000`
- post-update dummyB byte-equal: **YES**
  - anchor: `bddbfa36ea66f2840d00000000000000`
  - anvil:  `bddbfa36ea66f2840d00000000000000`

## Verdict

**BYTE_EQUAL on real :8899 validator** — H1 composite-Accounts flatten produces SBF bytecode that the actual Solana runtime executes AND the resulting on-chain state byte-matches Anchor's reference across both instructions.

## What this proves

1. H1 composite-Accounts flatten (commits 903aa9a + 9bd32b1) lands cleanly through Anvil's full pipeline.
2. The emit's SBF bytecode is accepted by the live solana-test-validator on :8899.
3. The instruction execution paths produce identical post-state on disk to Anchor's reference.
4. Anvil emit is dramatically smaller (~95%) — no anchor-spl runtime overhead.
