/**
 * Real-world Anchor cargo-build regression guard.
 *
 * Locks in the program-examples (solana-developers) fixtures that we transpile
 * and cargo-build deterministically — i.e. without depending on the AI refine
 * loop. If any of these regress, this test fails and the offending change
 * shouldn't merge.
 *
 * Source corpus is /tmp/program-examples (depth-1 clone of
 * solana-developers/program-examples). The test auto-skips with an actionable
 * message if the clone isn't present locally.
 *
 * Each MUST_PASS entry runs the full pipeline:
 *   parse → emit per target → cargo build (in-process via runBuild)
 *
 * NOT to be confused with cargo-build.test.ts which exercises the vendored
 * demo programs in api/src/demo-programs/. This one is a realistic-codebase
 * regression layer for fixtures we don't control.
 */
import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";
import { spawnSync } from "child_process";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { runBuild } from "../src/build/build-runner.ts";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import {
  buildProjectSource,
  collectProjectFilesFromEntry,
  getProjectEntryPath,
} from "../src/parser/project-source.ts";

const PROG_EX = "/tmp/program-examples";

type Target = "pinocchio" | "native";

interface Case {
  id: string;
  target: Target;
  path: string;
  /**
   * Optional ownership metadata. Populated as cases are promoted into
   * MUST_PASS so a regression has a clear contact + the recency signal
   * is queryable. `lastPassedDate` is updated by hand on promotion or
   * after a deliberate re-validation; it is NOT auto-bumped on every
   * green CI run (that would defeat the staleness signal).
   */
  maintainer?: string;
  /** ISO yyyy-mm-dd; when this case last passed by deliberate verification. */
  lastPassedDate?: string;
}

/**
 * Cases that MUST cargo-build green deterministically (no AI refine).
 * Adding a case here is the durability hand-off: once it lands as a green
 * cargo build via emitter logic alone, lock it in here so a later change
 * can't silently break it.
 */
const MUST_PASS: Case[] = [
  // Always-green baseline cases (lock in to catch silent regressions).
  { id: "checking-accounts", target: "pinocchio", path: "basics/checking-accounts/anchor/programs/anchor-program-example/src/lib.rs" },
  { id: "checking-accounts", target: "native",    path: "basics/checking-accounts/anchor/programs/anchor-program-example/src/lib.rs" },
  { id: "counter", target: "pinocchio", path: "basics/counter/anchor/programs/counter_anchor/src/lib.rs" },
  { id: "counter", target: "native",    path: "basics/counter/anchor/programs/counter_anchor/src/lib.rs" },
  { id: "processing-instructions", target: "pinocchio", path: "basics/processing-instructions/anchor/programs/processing-instructions/src/lib.rs" },
  { id: "processing-instructions", target: "native",    path: "basics/processing-instructions/anchor/programs/processing-instructions/src/lib.rs" },
  { id: "cpi-lever", target: "pinocchio", path: "basics/cross-program-invocation/anchor/programs/lever/src/lib.rs" },
  { id: "cpi-lever", target: "native",    path: "basics/cross-program-invocation/anchor/programs/lever/src/lib.rs" },
  { id: "create-account", target: "pinocchio", path: "basics/create-account/anchor/programs/create-system-account/src/lib.rs" },

  // close-account: unlocked by #58 (handler-exclusion regex catches `_ctx`).
  { id: "close-account", target: "pinocchio", path: "basics/close-account/anchor/programs/close-account/src/lib.rs" },
  { id: "close-account", target: "native",    path: "basics/close-account/anchor/programs/close-account/src/lib.rs" },

  // realloc: native unlocked by #53 (inherent-impl emit). pin was always green.
  { id: "realloc", target: "pinocchio", path: "basics/realloc/anchor/programs/anchor-realloc/src/lib.rs" },
  { id: "realloc", target: "native",    path: "basics/realloc/anchor/programs/anchor-realloc/src/lib.rs" },

  // program-derived-addresses: native unlocked by #53 (SEED_PREFIX const emit).
  { id: "program-derived-addresses", target: "pinocchio", path: "basics/program-derived-addresses/anchor/programs/anchor-program-example/src/lib.rs" },
  { id: "program-derived-addresses", target: "native",    path: "basics/program-derived-addresses/anchor/programs/anchor-program-example/src/lib.rs" },

  // transfer-tokens / spl-token-minter native: locked in by #52 (Mint::unpack
  // body-scan prelude — bare `<account>.decimals` no longer leaks).
  // Pinocchio for both: locked in by Metaplex CPI stub comment-out (this
  // session) — broken `solana_program::instruction::Instruction` placeholder
  // no longer cascades errors through pinocchio's create_token instruction.
  { id: "transfer-tokens", target: "pinocchio", path: "tokens/transfer-tokens/anchor/programs/transfer-tokens/src/lib.rs" },
  { id: "transfer-tokens", target: "native",    path: "tokens/transfer-tokens/anchor/programs/transfer-tokens/src/lib.rs" },
  { id: "spl-token-minter", target: "pinocchio", path: "tokens/spl-token-minter/anchor/programs/spl-token-minter/src/lib.rs" },
  { id: "spl-token-minter", target: "native",    path: "tokens/spl-token-minter/anchor/programs/spl-token-minter/src/lib.rs" },

  // create-token: same Metaplex-stub commentout fix
  { id: "create-token", target: "pinocchio", path: "tokens/create-token/anchor/programs/create-token/src/lib.rs" },
  { id: "create-token", target: "native",    path: "tokens/create-token/anchor/programs/create-token/src/lib.rs" },

  // token-2022-basics/pinocchio: locked in by #54 + #55 + #56 + #58 stack.
  { id: "token-2022-basics", target: "pinocchio", path: "tokens/token-2022/basics/anchor/programs/basics/src/lib.rs" },
  // token-2022-basics/native: locked in by spl-token-2022 scaffold dep +
  // ATA-import alias (avoids name collision with same-named user
  // instruction handler).
  { id: "token-2022-basics", target: "native", path: "tokens/token-2022/basics/anchor/programs/basics/src/lib.rs" },

  // t22-transfer-fee/pinocchio: re-promoted 2026-05-09 after the sibling-
  // state body-stub pass also caught the harvest helper's mint_account
  // access. Cargo-clean.
  { id: "t22-transfer-fee", target: "pinocchio", path: "tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-09" },
  { id: "t22-transfer-fee", target: "native", path: "tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },

  // t22-transfer-hook/pinocchio: promoted 2026-05-02 after extending the
  // import filter to drop spl_tlv_account_resolution / spl_transfer_hook_
  // interface / spl_discriminator / spl_pod, AND running the T22
  // commentout pass over the init/realloc preludes (not just the handler
  // body) so unresolvable types in `space = ...` expressions get
  // commented out.
  { id: "t22-transfer-hook", target: "pinocchio", path: "tokens/token-2022/transfer-hook/hello-world/anchor/programs/transfer-hook/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-02" },

  // t22-transfer-hook/native: promoted 2026-05-18 after the cpi-detector
  // dispatch-order fix routed qualified `token_2022::transfer_hook_*`
  // calls to the typed T22 IR kinds (pre-fix they were silently misrouted
  // to cpi_spl_transfer via substring precedence). Verified by tracking
  // surface "now BUILDS GREEN" signal.
  { id: "t22-transfer-hook", target: "native", path: "tokens/token-2022/transfer-hook/hello-world/anchor/programs/transfer-hook/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-18" },

  // create-account/native: locked in by pass-through-aware import scan
  // (`(transfer|create_account|...)\\(\\s*CpiContext::new` triggers the
  // invoke + system_instruction imports the rewriter needs).
  { id: "create-account", target: "native", path: "basics/create-account/anchor/programs/create-system-account/src/lib.rs" },

  // transfer-sol both targets: pinocchio unlocked by `**X.try_borrow_mut_lamports()`
  // → `*X.try_borrow_mut_lamports()` rewrite (pinocchio's RefMut wraps u64
  // not &mut u64, so single-deref is right). native was already green.
  { id: "transfer-sol", target: "pinocchio", path: "basics/transfer-sol/anchor/programs/transfer-sol/src/lib.rs" },
  { id: "transfer-sol", target: "native",    path: "basics/transfer-sol/anchor/programs/transfer-sol/src/lib.rs" },

  // rent both targets: pinocchio unlocked by `borsh::to_vec(&X)?` →
  // `.map_err(...)?` rewrite; native unlocked by pass-through-aware import scan.
  { id: "rent", target: "pinocchio", path: "basics/rent/anchor/programs/rent-example/src/lib.rs" },
  { id: "rent", target: "native",    path: "basics/rent/anchor/programs/rent-example/src/lib.rs" },

  // pda-rent-payer both targets: pinocchio unlocked by const-size [Seed; 8]
  // stack-pattern in postProcessPinocchioRewrites — same shape as the
  // helper functions (transfer_lamports_signed, create_program_account)
  // already use. Cap of 8 seeds is fine in practice (SPL ATA's 4-seed list
  // is the densest case in the wild). Native was already green.
  { id: "pda-rent-payer", target: "pinocchio", path: "basics/pda-rent-payer/anchor/programs/anchor-program-example/src/lib.rs" },
  { id: "pda-rent-payer", target: "native", path: "basics/pda-rent-payer/anchor/programs/anchor-program-example/src/lib.rs" },

  // carnival: multi-module within one program (state/{ride,game,food}.rs +
  // instructions/{get_on_ride,play_game,eat_food}.rs). Three correlated
  // emitter improvements unblock it: (a) collapse `<modname>::<helper>(...)`
  // → `<helper>(...)` in both walker pass-through AND helpers.rs emit when
  // helper is in IR.helperFns; (b) extend implItems collection to TypeDef
  // (was AccountDef-only) so carnival's `Ride::new(...)`/`Game::new(...)`/
  // `FoodStand::new(...)` constructors land; (c) drop redundant `.into()` on
  // `Err(<Type>::Variant.into())` and convert standalone `Err(...);` to
  // `return Err(...);` so rustc can bind the Err's generic Ok-type via the
  // function signature.
  { id: "carnival", target: "pinocchio", path: "basics/repository-layout/anchor/programs/carnival/src/lib.rs" },
  { id: "carnival", target: "native",    path: "basics/repository-layout/anchor/programs/carnival/src/lib.rs" },

  // pda-mint-authority both targets: green for free as a cumulative effect
  // of the Metaplex-stub commentout + signer_seeds parser fix + walker
  // comment-strip + .into() handling. The CreateMetadataAccountsV3 CPI
  // remains a TODO(manual) in the emitted code — runtime no-op — but the
  // file compiles, which is the threshold for the regression layer.
  { id: "pda-mint-authority", target: "pinocchio", path: "tokens/pda-mint-authority/anchor/programs/token-minter/src/lib.rs" },
  { id: "pda-mint-authority", target: "native",    path: "tokens/pda-mint-authority/anchor/programs/token-minter/src/lib.rs" },

  // cpi-hand both targets: same pattern as Metaplex — sibling-program CPI
  // (cpi-hand → cpi-lever) where Anvil hasn't catalogued the target program.
  // Drop sibling-program `use <crate>::cpi/accounts/program::*` imports
  // (auto-generated by Anchor for cross-program access) so the file
  // compiles, comment out the generic CPI stub. CPI is a runtime no-op
  // with TODO(manual). Same threshold as pda-mint-authority.
  { id: "cpi-hand", target: "pinocchio", path: "basics/cross-program-invocation/anchor/programs/hand/src/lib.rs" },
  { id: "cpi-hand", target: "native",    path: "basics/cross-program-invocation/anchor/programs/hand/src/lib.rs" },

  // ── 2026-05-02 H7 corpus expansion — promoted from probe sweep ──
  //
  // Each entry below was verified green via runBuild on /tmp/program-examples
  // at lastPassedDate. Maintainer = "anvil-core" until a specific contributor
  // owns a fixture's edge case. Cases that surfaced 1-error gaps (favorites/
  // native missing from_account_info, events/* uses emit_cpi macro) are
  // tracked in realworld-tracking.test.ts instead of here — those are
  // emitter follow-ups, not regression-guard targets.
  { id: "favorites", target: "pinocchio", path: "basics/favorites/anchor/programs/favorites/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-02" },
  // favorites/native promoted 2026-05-02 after Native emit gained
  // from_account_info wrapper to match Pinocchio (commit pending).
  { id: "favorites", target: "native", path: "basics/favorites/anchor/programs/favorites/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-02" },
  { id: "hello-solana", target: "pinocchio", path: "basics/hello-solana/anchor/programs/hello-solana/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-02" },
  { id: "hello-solana", target: "native", path: "basics/hello-solana/anchor/programs/hello-solana/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-02" },
  { id: "account-data", target: "pinocchio", path: "basics/account-data/anchor/programs/anchor-program-example/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-02" },
  { id: "account-data", target: "native", path: "basics/account-data/anchor/programs/anchor-program-example/src/lib.rs",
    maintainer: "anvil-core", lastPassedDate: "2026-05-02" },
];

// Round 3 sweep picks (cnft-burn, cnft-vault) emit cleanly per the
// VALIDATOR but FAIL full cargo build under the regression guard:
//   - `expected ;, found Ok` — syntax error in inlined CPI invoke
//     code (mpl-bubblegum `Burn`/`Transfer` instruction builders
//     produce shapes Anvil doesn't fully terminate)
//   - `BorshSerialize defined multiple times` (duplicate import scan)
//   - `AccountMeta` / `tree_authority` undeclared — auto-import +
//     account-binding gaps for compression/mpl-bubblegum CPIs
//
// These mirror the round-2 promotion failures (tokens/escrow,
// token-swap, oracle-pyth) — the regression layer's full cargo
// build pipeline catches what `cargo check` via the CLI scaffold
// path does not. Promote only after fixing the underlying emit gaps.

// reports/external-anchor-sweep-2026-05-07.md round 2 picks
// (tokens/escrow, tokens/token-swap, oracles/pyth) PASS cargo check
// via the CLI path but FAIL full cargo build under the regression
// guard's stricter validator + build pipeline:
//   - tokens-escrow: 5 + 3 unsafe-marker validator errors
//     (instructions/make_offer.rs + take_offer.rs)
//   - token-swap: cargo build failure (likely SPL extension imports)
//   - oracle-pyth: pyth_solana_receiver_sdk module unresolved + multiple
//     E0609 "no field price_message on type AccountInfo"
//
// Each is a real bug class for follow-up — promote to MUST_PASS only
// after the underlying emit gap is fixed and cargo build is green
// under the regression guard.

interface ExternalCase {
  id: string;
  target: Target;
  /** Absolute path to the fixture's `src/lib.rs`. */
  path: string;
  /** Repo URL for auto-clone. */
  repo: string;
  /** Local clone target for the repo. */
  cloneRoot: string;
  /** Same ownership metadata as MUST_PASS Case. */
  maintainer?: string;
  lastPassedDate?: string;
}

/**
 * Out-of-corpus MUST_PASS cases — programs hosted in their own repos that
 * we want to lock in as deterministic green builds. Promoted from
 * realworld-tracking.test.ts when their cargo error count hit 0. Auto-
 * clones the parent repo if missing (similar to the program-examples
 * auto-clone above).
 */
const EXTERNAL_MUST_PASS: ExternalCase[] = [
  // anchor-escrow-2025: promoted after unsalvageable-helper commentout
  // landed (errors 31/28 → 0/0 across both targets).
  {
    id: "escrow2025",
    target: "pinocchio",
    path: "/tmp/anchor-escrow-2025/programs/escrow/src/lib.rs",
    repo: "https://github.com/mikemaccana/anchor-escrow-2025",
    cloneRoot: "/tmp/anchor-escrow-2025",
  },
  {
    id: "escrow2025",
    target: "native",
    path: "/tmp/anchor-escrow-2025/programs/escrow/src/lib.rs",
    repo: "https://github.com/mikemaccana/anchor-escrow-2025",
    cloneRoot: "/tmp/anchor-escrow-2025",
  },

  // coral-escrow/native: promoted after seed-orphan splice (commit 0a881e2).
  {
    id: "coral-escrow",
    target: "native",
    path: "/tmp/coral-anchor/tests/escrow/programs/escrow/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
  },

  // coral-escrow/pinocchio: promoted after Pubkey:: -> pinocchio::pubkey::
  // rewrite + signer-seeds shape conversion in set_authority emit + temp-
  // borrow fix in t22 transfer signer-seeds template (this commit).
  // 6 -> 0. Final coral fixture in MUST_PASS.
  {
    id: "coral-escrow",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/escrow/programs/escrow/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
  },

  // coral-multisig/pinocchio: promoted after seed-orphan splice (this commit)
  // closed the last `seeds` scope error. The full chain to 0:
  // (1) #2 batch — solana_program::invoke{,_signed} commentout
  // (2) #3 batch — &Pubkey/Pubkey deref strip in iter closures
  // (3) #4 batch — index-assignment mut detection
  // (4) this commit — seed-orphan splice keeps `let seeds = …` in scope.
  {
    id: "coral-multisig",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/multisig/programs/multisig/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
  },
  {
    id: "coral-multisig",
    target: "native",
    path: "/tmp/coral-anchor/tests/multisig/programs/multisig/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
  },

  // ── 2026-05-02 emit_cpi! recognized by classifier ──
  //
  // coral-events: uses both emit!() and emit_cpi!(). Pre-fix the
  // classifier only recognized emit!; emit_cpi! fell through to
  // pass_through, leaving an unresolved macro at cargo build. Adding
  // emit_cpi as an alias of emit (both lower to comment-only on
  // non-Anchor targets, both subject to --ignore-events on the
  // differential CLI) unlocks both targets.
  {
    id: "coral-events",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/events/programs/events/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core",
    lastPassedDate: "2026-05-02",
  },
  {
    id: "coral-events",
    target: "native",
    path: "/tmp/coral-anchor/tests/events/programs/events/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core",
    lastPassedDate: "2026-05-02",
  },

  // ── 2026-05-02 H7 corpus expansion — coral-anchor probe sweep ──
  //
  // coral-sysvars: tests/sysvars exercises Clock/Rent/EpochSchedule
  // sysvar reads from Anchor handlers. Both targets land green because
  // the Sysvar IR kinds were already wired (clock/rent), and Anvil's
  // emit qualifies them per target (Clock::get for native,
  // pinocchio::sysvars::clock::Clock for pinocchio).
  {
    id: "coral-sysvars",
    target: "pinocchio",
    path: "/tmp/coral-anchor/tests/sysvars/programs/sysvars/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
  },
  {
    id: "coral-sysvars",
    target: "native",
    path: "/tmp/coral-anchor/tests/sysvars/programs/sysvars/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor",
    cloneRoot: "/tmp/coral-anchor",
  },

  // ── 2026-05-09 squads-mpl-roles full pipeline ──
  // Promoted from realworld-tracking after the 8-fix arc (51→0/55→0):
  // sibling-cpi imports, sibling trait-impl commentout, Result alias,
  // ctx.bumps.get method form, invoke()?; semicolon, rent.minimum_balance,
  // sibling-typed-state body stub, empty-accounts→stub fallback,
  // get_instance_packed_len → borsh::to_vec rewrite, native solana_program
  // import dedup, double-Ok suppression. Whole-body stub is the contract
  // for opaque sibling-typed accounts; user gets a TODO marker per
  // affected instruction and the file compiles cleanly.
  {
    id: "squads-mpl-roles",
    target: "pinocchio",
    path: "/tmp/squads-mpl/programs/roles/src/lib.rs",
    repo: "https://github.com/Squads-Protocol/squads-mpl",
    cloneRoot: "/tmp/squads-mpl",
    maintainer: "anvil-core",
    lastPassedDate: "2026-05-09",
  },
  {
    id: "squads-mpl-roles",
    target: "native",
    path: "/tmp/squads-mpl/programs/roles/src/lib.rs",
    repo: "https://github.com/Squads-Protocol/squads-mpl",
    cloneRoot: "/tmp/squads-mpl",
    maintainer: "anvil-core",
    lastPassedDate: "2026-05-09",
  },

  // ── 2026-05-23 Phase 4 corpus expansion — coral-anchor probe sweep ──
  { id: "coral-cashiers-check", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/cashiers-check/programs/cashiers-check/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  // coral-cashiers-check/native: E0599 unpack — needs `use Pack` scope for spl_token::state::Account
  // { id: "coral-cashiers-check", target: "native", ... },
  // coral-tictactoe: cargo build fails on both targets (enum variant + match pattern gaps)
  // { id: "coral-tictactoe", ... },
  { id: "coral-declare-id", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/declare-id/programs/declare-id/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-declare-id", target: "native",
    path: "/tmp/coral-anchor/tests/declare-id/programs/declare-id/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-custom-discriminator", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/custom-discriminator/programs/ambiguous-discriminator/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-custom-discriminator", target: "native",
    path: "/tmp/coral-anchor/tests/custom-discriminator/programs/ambiguous-discriminator/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  // coral-anchor-cli-account + coral-misc: cargo build fails (various gaps)
  // { id: "coral-anchor-cli-account", ... },
  // { id: "coral-misc", ... },

  // ── 2026-05-23 extended sweep ──
  { id: "coral-chat", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/chat/programs/chat/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-chat", target: "native",
    path: "/tmp/coral-anchor/tests/chat/programs/chat/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-cpi-returns", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/cpi-returns/programs/callee/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-cpi-returns", target: "native",
    path: "/tmp/coral-anchor/tests/cpi-returns/programs/callee/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-bpf-upgradeable", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/bpf-upgradeable-state/programs/bpf-upgradeable-state/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-bpf-upgradeable", target: "native",
    path: "/tmp/coral-anchor/tests/bpf-upgradeable-state/programs/bpf-upgradeable-state/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  // coral-ido-pool + coral-swap: cargo build fails (SPL unpack needs `use Pack` scope)
  // { id: "coral-ido-pool", ... },
  // { id: "coral-swap", ... },

  // ── coral tutorial basics ──
  { id: "coral-basic-0", target: "pinocchio",
    path: "/tmp/coral-anchor/examples/tutorial/basic-0/programs/basic-0/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-0", target: "native",
    path: "/tmp/coral-anchor/examples/tutorial/basic-0/programs/basic-0/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-1", target: "pinocchio",
    path: "/tmp/coral-anchor/examples/tutorial/basic-1/programs/basic-1/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-1", target: "native",
    path: "/tmp/coral-anchor/examples/tutorial/basic-1/programs/basic-1/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-2", target: "pinocchio",
    path: "/tmp/coral-anchor/examples/tutorial/basic-2/programs/basic-2/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-2", target: "native",
    path: "/tmp/coral-anchor/examples/tutorial/basic-2/programs/basic-2/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-4", target: "pinocchio",
    path: "/tmp/coral-anchor/examples/tutorial/basic-4/programs/basic-4/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-4", target: "native",
    path: "/tmp/coral-anchor/examples/tutorial/basic-4/programs/basic-4/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-5", target: "pinocchio",
    path: "/tmp/coral-anchor/examples/tutorial/basic-5/programs/basic-5/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-basic-5", target: "native",
    path: "/tmp/coral-anchor/examples/tutorial/basic-5/programs/basic-5/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },

  // ── squads-mpl auxiliary programs ──
  // squads-txmeta: cargo build fails (access_control + owner constraint gaps)
  // { id: "squads-txmeta", ... },
  { id: "squads-validator", target: "pinocchio",
    path: "/tmp/squads-mpl/programs/validator/src/lib.rs",
    repo: "https://github.com/Squads-Protocol/squads-mpl", cloneRoot: "/tmp/squads-mpl",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "squads-validator", target: "native",
    path: "/tmp/squads-mpl/programs/validator/src/lib.rs",
    repo: "https://github.com/Squads-Protocol/squads-mpl", cloneRoot: "/tmp/squads-mpl",
    maintainer: "anvil-core", lastPassedDate: "2026-05-23" },
  { id: "coral-optional", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/optional/programs/allow-missing-optionals/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-optional", target: "native",
    path: "/tmp/coral-anchor/tests/optional/programs/allow-missing-optionals/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-multiple-suites", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/multiple-suites/programs/multiple-suites/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-multiple-suites", target: "native",
    path: "/tmp/coral-anchor/tests/multiple-suites/programs/multiple-suites/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-solana-program-deps", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/solana-program-deps/mismatched/programs/mismatched-solana-program/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-solana-program-deps", target: "native",
    path: "/tmp/coral-anchor/tests/solana-program-deps/mismatched/programs/mismatched-solana-program/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-typescript", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/typescript/programs/typescript/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-typescript", target: "native",
    path: "/tmp/coral-anchor/tests/typescript/programs/typescript/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-validator-clone", target: "pinocchio",
    path: "/tmp/coral-anchor/tests/validator-clone/programs/validator-clone/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
  { id: "coral-validator-clone", target: "native",
    path: "/tmp/coral-anchor/tests/validator-clone/programs/validator-clone/src/lib.rs",
    repo: "https://github.com/coral-xyz/anchor", cloneRoot: "/tmp/coral-anchor",
    maintainer: "anvil-core", lastPassedDate: "2026-05-24" },
];

// All 36 program-examples cases now pass deterministically. The pinocchio
// signer-seeds impedance gap that previously blocked pda-rent-payer was
// closed by a const-size [Seed; 8] stack-allocation pattern in
// postProcessPinocchioRewrites — matches the helper-function style.

/**
 * Auto-clone the program-examples corpus on first run. Without this, the
 * suite silently auto-skips on fresh CI machines or new contributor laptops
 * — coverage that's invisible until someone notices the regression layer
 * never runs. 60s timeout since the depth-1 clone is small (~50MB) and a
 * slow network shouldn't wedge the whole test run.
 *
 * Set ANVIL_NO_CLONE=1 to disable (e.g. for offline development).
 */
if (!existsSync(PROG_EX) && process.env.ANVIL_NO_CLONE !== "1") {
  console.warn(
    `[realworld-cargo] ${PROG_EX} not found — auto-cloning program-examples (depth=1)…`,
  );
  const clone = spawnSync(
    "git",
    ["clone", "--depth", "1", "https://github.com/solana-developers/program-examples", PROG_EX],
    { stdio: "inherit", timeout: 60_000 },
  );
  if (clone.status !== 0) {
    console.warn(
      `[realworld-cargo] auto-clone failed (status=${clone.status}). Suite will skip.`,
    );
  }
}

// Auto-clone external (out-of-corpus) repos that host promoted MUST_PASS
// fixtures. Each repo is cloned into its `cloneRoot` if missing. Same
// rationale as the program-examples auto-clone — silent skip on fresh
// CI machines was masking the regression layer.
if (process.env.ANVIL_NO_CLONE !== "1") {
  const seen = new Set<string>();
  for (const c of EXTERNAL_MUST_PASS) {
    if (seen.has(c.cloneRoot)) continue;
    seen.add(c.cloneRoot);
    if (!existsSync(c.cloneRoot)) {
      console.warn(
        `[realworld-cargo] ${c.cloneRoot} not found — auto-cloning ${c.repo} (depth=1)…`,
      );
      const clone = spawnSync(
        "git",
        ["clone", "--depth", "1", c.repo, c.cloneRoot],
        { stdio: "inherit", timeout: 60_000 },
      );
      if (clone.status !== 0) {
        console.warn(
          `[realworld-cargo] auto-clone failed for ${c.repo} (status=${clone.status}). Suite will skip.`,
        );
      }
    }
  }
}

if (existsSync(PROG_EX)) {
  describe("Real-world Anchor cargo-build regression guard", () => {
    for (const c of MUST_PASS) {
      test(`${c.id} / ${c.target}`, async () => {
        const entry = `${PROG_EX}/${c.path}`;
        if (!existsSync(entry)) {
          throw new Error(
            `Fixture missing: ${entry}. The clone exists but this path may have moved upstream.`,
          );
        }
        const files = collectProjectFilesFromEntry(entry);
        const source = buildProjectSource(getProjectEntryPath(entry), files);
        const parsed = await parseAnchor(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const out = c.target === "native"
          ? emitNativeFull(parsed.ir)
          : emitPinocchioFull(parsed.ir);

        // Validator-clean visibility. Logs unsafe-marker stubs (Metaplex CPI
        // commentouts, TODO(manual) sentinels, 0u8 /* TODO */ decimals)
        // loudly without failing the test — a chunk of MUST_PASS fixtures
        // legitimately ship Metaplex stubs that compile but require manual
        // rebuild. The cargo-green gate below remains the hard regression
        // bar; validator-clean is a stricter target we drive toward over
        // time. A future task can promote this to a hard failure once the
        // marker-emitting code paths are eliminated from these fixtures.
        const issues = validateEmitterOutput(parsed.ir, out);
        const errors = issues.filter((i) => i.severity === "error");
        if (errors.length > 0) {
          console.warn(
            `[validator] ${c.id}/${c.target}: ${errors.length} unsafe-marker error(s) — ${errors.map((e) => `${e.path}:${e.line ?? "?"}`).join(", ")}`,
          );
        }

        const r = await runBuild(
          c.target,
          out.files.map((f) => ({ path: f.path, content: f.content })),
          parsed.ir.name,
        );
        if (!r.ok) {
          const head = r.errors
            .slice(0, 5)
            .map(
              (e) =>
                `  [${e.code ?? "?"}] ${e.filePath}:${e.line ?? "?"}  ${(e.message ?? "").slice(0, 200)}`,
            )
            .join("\n");
          throw new Error(
            `cargo build failed for ${c.id}/${c.target} — this case used to pass, a recent change broke it:\n${head}`,
          );
        }
      }, 120_000);
    }
  });
} else {
  // Loud skip — silent CI skips have masked broken regression layers before.
  // The warning + the test.skip name both surface the missing fixture so
  // local devs and CI logs can't lose this coverage without noticing.
  console.warn(
    `\n[realworld-cargo] SKIPPED: ${MUST_PASS.length} regression cases not run.\n` +
      `  Reason: ${PROG_EX} not found.\n` +
      `  To restore coverage:\n` +
      `    git clone --depth 1 https://github.com/solana-developers/program-examples ${PROG_EX}\n`,
  );
  describe("Real-world Anchor cargo-build regression guard [SKIPPED — clone missing]", () => {
    test.skip(
      `clone missing at ${PROG_EX} — see console warning for fix`,
      () => {},
    );
  });
}

// External (out-of-corpus) MUST_PASS — same regression-guard contract as
// the program-examples loop above, but each case has its own clone root.
const externalReady = EXTERNAL_MUST_PASS.filter((c) => existsSync(c.path));
if (externalReady.length > 0) {
  describe("Real-world Anchor cargo-build regression guard (external)", () => {
    for (const c of externalReady) {
      test(`${c.id} / ${c.target}`, async () => {
        const files = collectProjectFilesFromEntry(c.path);
        const source = buildProjectSource(getProjectEntryPath(c.path), files);
        const parsed = await parseAnchor(source);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const out = c.target === "native"
          ? emitNativeFull(parsed.ir)
          : emitPinocchioFull(parsed.ir);

        // See note on the in-corpus loop above — validator-clean is logged
        // loudly but not gated; cargo-green remains the regression bar.
        const issues = validateEmitterOutput(parsed.ir, out);
        const errors = issues.filter((i) => i.severity === "error");
        if (errors.length > 0) {
          console.warn(
            `[validator] ${c.id}/${c.target} (external): ${errors.length} unsafe-marker error(s) — ${errors.map((e) => `${e.path}:${e.line ?? "?"}`).join(", ")}`,
          );
        }

        const r = await runBuild(
          c.target,
          out.files.map((f) => ({ path: f.path, content: f.content })),
          parsed.ir.name,
        );
        if (!r.ok) {
          const head = r.errors
            .slice(0, 5)
            .map(
              (e) =>
                `  [${e.code ?? "?"}] ${e.filePath}:${e.line ?? "?"}  ${(e.message ?? "").slice(0, 200)}`,
            )
            .join("\n");
          throw new Error(
            `cargo build failed for ${c.id}/${c.target} (external) — this case used to pass, a recent change broke it:\n${head}`,
          );
        }
      }, 120_000);
    }
  });
}
