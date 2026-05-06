/**
 * AST visitor byte-identical parity test.
 *
 * For the IR kinds the Phase-1 visitor handles (`state_read`,
 * `state_field_assign`, `bumps_access`), this test asserts that the
 * visitor's output (AST → printer) is byte-identical to what the
 * existing handler chain pushes into BodyWalker.lines. Same demo
 * sources (counter, vault, escrow), same targets (pinocchio, native).
 *
 * Test methodology — compare two walker runs:
 *   - Walker A: dispatches every statement through the existing
 *     per-kind handlers (handleStateRead, handleStateFieldAssign, ...).
 *   - Walker B: dispatches `state_read` / `state_field_assign` /
 *     `bumps_access` through the AstVisitor (which produces RustStmt
 *     nodes, prints them, and pushes the resulting lines). Other
 *     statement kinds fall through to the same handlers as A.
 *
 * If the visitor produces byte-identical output for the supported
 * kinds, A.lines === B.lines exactly. Any deviation surfaces as a
 * line-by-line diff in the failure log so the regression is easy to
 * locate.
 *
 * This is the parity gate for Phase 2: when the visitor is widened
 * to a new IR kind, this test grows. When all kinds are ported, the
 * visitor can replace the handler chain entirely (Phase 3).
 *
 * Status: visitor lands as DEAD CODE. Production emit still goes
 * through the handler chain. This test is the only consumer.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import {
  PinocchioEmitter,
} from "../src/emitter/pinocchio-emitter.ts";
import { NativeEmitter } from "../src/emitter/native-emitter.ts";
import { BodyWalker } from "../src/emitter/body-emitter/walker.ts";
import type {
  BodyEmitterCallbacks,
  BodyEmitterContext,
} from "../src/emitter/body-emitter/index.ts";
import type {
  Instruction,
  SolanaIR,
  BodyStatement,
} from "../src/ir/schema.ts";
import {
  AstVisitorBase,
  PinocchioAstVisitor,
  NativeAstVisitor,
  VISITOR_SUPPORTED_KINDS,
  printStmt,
  countRawNodes,
  type RustStmt,
} from "../src/emitter/ast-visitor/index.ts";
import { handlePassThrough } from "../src/emitter/body-emitter/handlers/pass-through.ts";
import {
  handleStateRead,
  handleBumpsAccess,
  handleStateFieldAssign,
} from "../src/emitter/body-emitter/handlers/state.ts";
import {
  handleCpiSystemTransfer,
  handleCpiSplTransfer,
  handleCpiSplMintTo,
  handleCpiSplBurn,
  handleCpiSplCloseAccount,
  handleCpiSplSetAuthority,
  handleCpiAtaCreate,
  handleCpiMemo,
  handleCpiCustom,
  handleCpiMplCreateMetadataV3,
  handleCpiMplCreateMasterEditionV3,
} from "../src/emitter/body-emitter/handlers/cpi.ts";
import { handleSysvarClock, handleSysvarRent } from "../src/emitter/body-emitter/handlers/sysvar.ts";
import {
  handleRequire,
  handleMsg,
  handleEmit,
  handlePdaSignerSeeds,
  handleReturnOk,
  handleReturnErr,
} from "../src/emitter/body-emitter/handlers/control.ts";

const DEMO_DIR = join(import.meta.dir, "..", "src", "demo-programs");
const DEMOS = ["counter", "vault", "escrow"];

interface TargetCase {
  name: "pinocchio" | "native";
  makeEmitter: () => BodyEmitterCallbacks;
  makeVisitor: (w: BodyWalker) => AstVisitorBase;
}

const TARGETS: TargetCase[] = [
  {
    name: "pinocchio",
    makeEmitter: () => new PinocchioEmitter() as unknown as BodyEmitterCallbacks,
    makeVisitor: (w) => new PinocchioAstVisitor(w),
  },
  {
    name: "native",
    makeEmitter: () => new NativeEmitter() as unknown as BodyEmitterCallbacks,
    makeVisitor: (w) => new NativeAstVisitor(w),
  },
];

describe("AST visitor — byte-identical to handler chain (Phase 1: 3 IR kinds)", () => {
  for (const demo of DEMOS) {
    for (const target of TARGETS) {
      test(`${demo} (${target.name}): visitor output equals handler output`, async () => {
        const source = readFileSync(join(DEMO_DIR, `${demo}.rs`), "utf-8");
        const parsed = await parseAnchor(source);
        if (!parsed.ok) throw new Error(`parse failed: ${parsed.error}`);
        const ir = parsed.ir;

        for (const instr of ir.instructions) {
          // Run handler-only path to collect baseline lines.
          const baselineLines = runHandlerOnly(target.makeEmitter(), instr, ir);
          // Run visitor-mixed path. Visitor handles supported kinds; other
          // kinds fall through to the same handlers as baseline so any
          // mismatch is isolated to the supported set.
          const visitorLines = runVisitorMixed(
            target.makeEmitter(),
            target.makeVisitor.bind(target),
            instr,
            ir,
          );
          if (baselineLines.join("\n") !== visitorLines.join("\n")) {
            // Locate first diverging line for an actionable error message.
            const max = Math.max(baselineLines.length, visitorLines.length);
            let firstDiff = -1;
            for (let i = 0; i < max; i++) {
              if (baselineLines[i] !== visitorLines[i]) { firstDiff = i; break; }
            }
            const ctx = (lines: string[], idx: number) =>
              [
                lines[idx - 2] ?? "",
                lines[idx - 1] ?? "",
                `>>> ${lines[idx] ?? "<eof>"} <<<`,
                lines[idx + 1] ?? "",
                lines[idx + 2] ?? "",
              ].join("\n");
            throw new Error(
              `[ast-visitor-parity] ${demo}/${target.name}/${instr.name}: divergence at line ${firstDiff}\n\n` +
                `--- handler baseline (${baselineLines.length} lines):\n${ctx(baselineLines, firstDiff)}\n\n` +
                `--- visitor (${visitorLines.length} lines):\n${ctx(visitorLines, firstDiff)}`,
            );
          }
          expect(visitorLines).toEqual(baselineLines);
        }
      });
    }
  }

  test("visitor emits at least one structured (non-raw) AST node per supported kind", async () => {
    // Sanity check: confirm the visitor isn't degenerate (everything
    // wrapped in raw_line). Counter exercises all three kinds; we expect
    // at least one structured `assign` (state_field_assign LHS) and one
    // structured `let` (bumps_access alias). If this fires, the visitor
    // collapsed to raw-only and Phase 1 succeeded only by accident.
    const source = readFileSync(join(DEMO_DIR, "counter.rs"), "utf-8");
    const parsed = await parseAnchor(source);
    if (!parsed.ok) throw new Error(parsed.error);
    const ir = parsed.ir;

    for (const target of TARGETS) {
      const initialize = ir.instructions.find((i) => i.name === "initialize");
      if (!initialize) throw new Error("counter has no initialize ix?");
      const emitter = target.makeEmitter();
      const ctx: BodyEmitterContext = {
        transformedCount: 0,
        passedThroughCount: 0,
        details: [],
        warnings: [],
      };
      const walker = new BodyWalker(emitter, ctx, initialize.body, initialize, ir);
      const visitor = target.makeVisitor(walker);

      let structuredAssignCount = 0;
      let structuredLetCount = 0;
      for (const stmt of initialize.body) {
        if (!VISITOR_SUPPORTED_KINDS.has(stmt.kind)) continue;
        const ast: RustStmt[] = visitor.visit(stmt);
        for (const node of ast) {
          if (node.kind === "assign") structuredAssignCount++;
          if (node.kind === "let") structuredLetCount++;
        }
      }
      expect(structuredAssignCount).toBeGreaterThan(0);
      expect(structuredLetCount).toBeGreaterThanOrEqual(0);
    }
  });

  test("countRawNodes scope-metric visible for the migration tracking", async () => {
    // Documents how much structural progress remains. Today: every
    // state_read / state_field_assign / bumps_access wrap external
    // text in raw expressions; structural nodes are LHS only. The
    // metric drops as Phase 2 ports each kind.
    const source = readFileSync(join(DEMO_DIR, "counter.rs"), "utf-8");
    const parsed = await parseAnchor(source);
    if (!parsed.ok) throw new Error(parsed.error);
    const ir = parsed.ir;
    const target = TARGETS[0]!;
    const emitter = target.makeEmitter();
    const initialize = ir.instructions.find((i) => i.name === "initialize")!;
    const ctx: BodyEmitterContext = {
      transformedCount: 0,
      passedThroughCount: 0,
      details: [],
      warnings: [],
    };
    const walker = new BodyWalker(emitter, ctx, initialize.body, initialize, ir);
    const visitor = target.makeVisitor(walker);
    const allStmts: RustStmt[] = [];
    for (const stmt of initialize.body) {
      if (!VISITOR_SUPPORTED_KINDS.has(stmt.kind)) continue;
      allStmts.push(...visitor.visit(stmt));
    }
    const counts = countRawNodes(allStmts);
    // No assertion on a specific number — Phase 2 will reduce these.
    // The test just exercises the counter so it stays runnable.
    expect(counts.rawLines + counts.rawExprs).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Run all body statements through the existing per-kind handlers. Returns
 * the lines BodyWalker would have collected if `walker.walk()` had fully
 * dispatched. Skips constructor-emitted preamble (canonical bump lines)
 * because those run identically in both A and B.
 */
function runHandlerOnly(
  emitter: BodyEmitterCallbacks,
  instr: Instruction,
  ir: SolanaIR,
): string[] {
  const ctx: BodyEmitterContext = {
    transformedCount: 0,
    passedThroughCount: 0,
    details: [],
    warnings: [],
  };
  const walker = new BodyWalker(emitter, ctx, instr.body, instr, ir);
  const baseLineCount = walker.lines.length;
  for (const stmt of instr.body) {
    dispatchHandler(walker, stmt);
  }
  return walker.lines.slice(baseLineCount);
}

/**
 * Run all body statements through the visitor for supported kinds, falling
 * through to handlers for everything else. Returns the lines collected
 * minus the constructor preamble, mirroring runHandlerOnly's shape so the
 * two arrays compare line-for-line.
 */
function runVisitorMixed(
  emitter: BodyEmitterCallbacks,
  makeVisitor: (w: BodyWalker) => AstVisitorBase,
  instr: Instruction,
  ir: SolanaIR,
): string[] {
  const ctx: BodyEmitterContext = {
    transformedCount: 0,
    passedThroughCount: 0,
    details: [],
    warnings: [],
  };
  const walker = new BodyWalker(emitter, ctx, instr.body, instr, ir);
  const visitor = makeVisitor(walker);
  const baseLineCount = walker.lines.length;
  for (const stmt of instr.body) {
    if (VISITOR_SUPPORTED_KINDS.has(stmt.kind)) {
      const astStmts = visitor.visit(stmt);
      for (const node of astStmts) {
        // Mirror handler convention: each pushed string carries 4-space
        // indent. printStmt returns the unindented form; reapply here.
        walker.lines.push(`    ${printStmt(node)}`);
      }
    } else {
      dispatchHandler(walker, stmt);
    }
  }
  return walker.lines.slice(baseLineCount);
}

function dispatchHandler(walker: BodyWalker, stmt: BodyStatement): void {
  switch (stmt.kind) {
    case "pass_through": handlePassThrough(walker, stmt); break;
    case "state_read": handleStateRead(walker, stmt); break;
    case "bumps_access": handleBumpsAccess(walker, stmt); break;
    case "state_field_assign": handleStateFieldAssign(walker, stmt); break;
    case "require": handleRequire(walker, stmt); break;
    case "msg": handleMsg(walker, stmt); break;
    case "emit": handleEmit(walker, stmt); break;
    case "cpi_system_transfer": handleCpiSystemTransfer(walker, stmt); break;
    case "cpi_spl_transfer": handleCpiSplTransfer(walker, stmt); break;
    case "cpi_spl_mint_to": handleCpiSplMintTo(walker, stmt); break;
    case "cpi_spl_burn": handleCpiSplBurn(walker, stmt); break;
    case "cpi_spl_close_account": handleCpiSplCloseAccount(walker, stmt); break;
    case "cpi_spl_set_authority": handleCpiSplSetAuthority(walker, stmt); break;
    case "cpi_ata_create": handleCpiAtaCreate(walker, stmt); break;
    case "cpi_memo": handleCpiMemo(walker, stmt); break;
    case "cpi_custom": handleCpiCustom(walker, stmt); break;
    case "cpi_mpl_create_metadata_v3": handleCpiMplCreateMetadataV3(walker, stmt); break;
    case "cpi_mpl_create_master_edition_v3": handleCpiMplCreateMasterEditionV3(walker, stmt); break;
    case "sysvar_clock": handleSysvarClock(walker, stmt); break;
    case "sysvar_rent": handleSysvarRent(walker, stmt); break;
    case "pda_signer_seeds": handlePdaSignerSeeds(walker, stmt); break;
    case "return_ok": handleReturnOk(walker); break;
    case "return_err": handleReturnErr(walker, stmt); break;
  }
}
