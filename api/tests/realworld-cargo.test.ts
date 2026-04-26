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

  // t22-transfer-fee/pinocchio: promoted from tracking after T22 extension
  // call-site commentout landed (errors 16 → 0). spl_token_2022 lacks a
  // no_std variant, so the pass excises every body-level reference to
  // extension types + their call sites, leaving the file compile-clean.
  // Native version stays in tracking — auto-imports drop most errors but
  // InterfaceAccount<TokenAccount> in account structs still leaks.
  { id: "t22-transfer-fee", target: "pinocchio", path: "tokens/token-2022/transfer-fee/anchor/programs/transfer-fee/src/lib.rs" },

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
];

interface ExternalCase {
  id: string;
  target: Target;
  /** Absolute path to the fixture's `src/lib.rs`. */
  path: string;
  /** Repo URL for auto-clone. */
  repo: string;
  /** Local clone target for the repo. */
  cloneRoot: string;
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
