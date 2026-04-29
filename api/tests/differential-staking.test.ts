/**
 * Staking differential — TODO, scaffolded but DELIBERATELY DEFERRED.
 *
 * Staking is intentionally skipped beyond the SPL setup cost (which
 * applies equally to escrow). Two structural reasons:
 *
 *   1. `emit!` events. Anchor's `emit!` macro serializes event data
 *      and CPIs to System program with a self-describing log entry.
 *      Anvil-Pinocchio currently does not produce a byte-equal event
 *      log on the runtime side, so logs diverge even when state math
 *      is correct. Comparing only state would silently mask event-
 *      shape regressions; comparing logs would always fail. Either
 *      direction loses signal.
 *
 *   2. Clock-dependent reward math. `claim_rewards` and `unstake`
 *      compute `rewards = stake_amount × elapsed × reward_rate`
 *      where `elapsed = clock.unix_timestamp - last_claim`. LiteSVM's
 *      clock does advance between transactions, but it advances
 *      independently in each scenario run — so anchor and anvil
 *      scenarios will see different `elapsed` values and produce
 *      different rewards even with identical inputs. We'd need
 *      explicit clock-pinning across both scenarios to make this
 *      meaningful.
 *
 * To enable this fixture, the path is:
 *   - All escrow prerequisites (SPL Token JS lib, mint + ATA setup)
 *   - Pin the clock identically in both scenarios via
 *     `svm.warpToSlot(N)` + `svm.warpToTimestamp(T)` after deploy
 *     and before the first instruction
 *   - Either drop `emit!` events from comparison surface (state-only)
 *     OR confirm that Anvil-Pinocchio emits matching event log entries
 *
 * Tracking-layer style: we surface the gap explicitly in the test
 * suite so it doesn't disappear into a TODO file no one re-reads.
 */
import { describe, test } from "bun:test";

describe.skip("Anchor vs Anvil-Pinocchio runtime correctness (staking) [DEFERRED — emit! + clock]", () => {
  test.skip("see file header for the path to enable", () => {});
});
