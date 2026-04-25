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

  // pda-rent-payer/native: walker.ts now matches the fluent `.with_signer(...)`
  // builder form for create_account; comment-strip in transformNestedAnchorCode
  // lets the regex span struct-field comments. Pinocchio gap remains: Anchor's
  // &[&[&[u8]]] signer_seeds doesn't trivially convert to pinocchio's
  // Signer<&[Seed]> without runtime allocation; needs a separate const-aware
  // emit pass.
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

// Known gap (do NOT add to MUST_PASS): pda-rent-payer/pinocchio — Anchor's
// `&[&[&[u8]]]` signer_seeds form doesn't trivially convert to pinocchio's
// `Signer<'_, '_>::From<&[Seed]>` API without a runtime allocation that
// pinocchio's no_std environment doesn't permit. Native is unblocked.
// Possible future fix: emit a const-size match block that handles N=1..8
// seed counts with stack-allocated Seed arrays.

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
  describe("Real-world Anchor cargo-build regression guard [skipped]", () => {
    test.skip(
      `clone missing — run: git clone --depth 1 https://github.com/solana-developers/program-examples ${PROG_EX}`,
      () => {},
    );
  });
}
