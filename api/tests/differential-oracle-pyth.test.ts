/**
 * Pyth oracle differential — DEFERRED, blocked on Pyth CPI emit.
 *
 * The roadmap (Tier 2.1) lists `oracle-pyth` as a target for the
 * differential corpus. It is intentionally not scoped here yet, for one
 * blocking reason that lives in the emitter, not in the scenario code:
 *
 *   1. Anvil has no typed IR kind for Pyth price-account reads.
 *      Currently `pyth_solana_receiver_sdk::*` / `pyth_sdk_solana::*`
 *      imports are surfaced by the lint-analyzer as
 *      "pyth_solana_receiver_sdk imports — Pyth oracle reads aren't
 *      transpiled" (see api/src/cli/lint-analyzer.ts:119-141). The
 *      bodies that consume those types fall through to `pass_through`,
 *      where the regex layer cannot rewrite a price-feed deserialize
 *      into a Pinocchio-equivalent that's byte-equal to Anchor's.
 *
 *   2. The grant M2 milestone (project-roadmap-todos.md, Tier 2.2)
 *      schedules `cpi_pyth_read_price` + `cpi_switchboard_read_result`
 *      typed IR kinds + emit + 2 fixtures over ~2 weeks. Until that
 *      lands, byte-equal divergence here would be a known emit gap
 *      tagged as a differential test failure — wrong signal.
 *
 * Path to enable:
 *   - Land Tier 2.2 Pyth CPI work (typed IR kind + parser + emitter).
 *   - Add a small Pyth-consumer demo program under
 *     `api/src/demo-programs/oracle-pyth.rs` (read price,
 *     write to a state PDA).
 *   - Mock the Pyth price account in scenario setup using a
 *     pre-encoded price feed buffer (LiteSVM `setAccount`).
 *   - Compare the state PDA byte-for-byte; the price feed input is
 *     identical across both runs so the only divergence source is the
 *     Pinocchio/Native deserialize path.
 *
 * Tracking-layer style: surface the gap explicitly in the test suite
 * so it doesn't disappear into a TODO file no one re-reads. When it's
 * unblocked, replace the `describe.skip` body with a real
 * `defineDifferential({...})` call — same shape as
 * `differential-staking.test.ts`.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (oracle-pyth) [DEFERRED — Pyth CPI emit]", () => {
  test.skip("see file header for the path to enable", () => {});
});
