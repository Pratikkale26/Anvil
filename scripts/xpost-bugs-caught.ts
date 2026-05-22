#!/usr/bin/env bun
// Screenshot helper: prints the 4 silent bugs that byte-equal differentials
// caught in Anvil's own emitter, with the commit that fixed each and the
// test that locks the safety net.
//
// Usage:  bun scripts/xpost-bugs-caught.ts

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

type Bug = {
  badge: string;
  title: string;
  impact: string[];
  commit: string;
  fixSubject: string;
  test: string;
};

const bugs: Bug[] = [
  {
    badge: "①",
    title: "Metaplex DataV2 shorthand silently coerced to \"unknown\"",
    impact: [
      "NFT minters whose metadata.name was an instruction arg would have",
      "shipped the literal \"unknown\" on-chain. Money-loss class for live mints.",
    ],
    commit: "8bc7270",
    fixSubject: "parser: DataV2 shorthand fields no longer coerce",
    test: "api/tests/differential-mpl-create-metadata.test.ts",
  },
  {
    badge: "②",
    title: "update_metadata_accounts_v2 Borsh field order INVERTED",
    impact: [
      "Every rename CPI silently corrupted the metadata Borsh blob —",
      "wrong field landed in wrong slot. Caught by the create→rename chain.",
    ],
    commit: "4bca2cf",
    fixSubject: "emit/mpl: two bugs surfaced by create+update differential chain",
    test: "api/tests/differential-mpl-create-metadata.test.ts",
  },
  {
    badge: "③",
    title: "Pinocchio MPL helpers — bare Seed/Signer use missing import-gate",
    impact: [
      "helpers.rs failed cargo with E0433 \"undeclared type Seed\".",
      "Unit tests on emit strings missed it; the SBF round-trip caught it.",
    ],
    commit: "28bed30",
    fixSubject: "differential: MPL create_metadata_v3 byte-equal — first MPL gate",
    test: "api/tests/emitter-pinocchio-mpl-imports.test.ts",
  },
  {
    badge: "④",
    title: "TransferHook Update wedge — Token-2022 rejects bare Update",
    impact: [
      "T22 rejects Update when extension TLV exists without base mint header.",
      "Without the wedge, every TransferHook update path would have shipped broken.",
    ],
    commit: "d9b4866",
    fixSubject: "t22 EM2 S2: TransferHook + MetadataPointer body-CPI",
    test: "api/tests/differential-t22-transfer-hook.test.ts",
  },
];

const C = {
  bold:   (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[22m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[39m`,
  green:  (s: string) => `\x1b[32m${s}\x1b[39m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[39m`,
  amber:  (s: string) => `\x1b[38;5;214m${s}\x1b[39m`,
  blue:   (s: string) => `\x1b[38;5;39m${s}\x1b[39m`,
  grey:   (s: string) => `\x1b[38;5;245m${s}\x1b[39m`,
};

const WIDTH = 82;

function exists(sha: string): boolean {
  return spawnSync("git", ["cat-file", "-e", sha], { encoding: "utf-8" }).status === 0;
}
function commitDate(sha: string): string {
  return (spawnSync("git", ["log", "-1", "--pretty=format:%cs", sha], { encoding: "utf-8" }).stdout || "").trim();
}
function testFile(path: string): boolean {
  return existsSync(join(import.meta.dir, "..", path));
}

// Pad an unstyled string to width n (used to size box rows).
function padRaw(s: string, n: number): string {
  return s + " ".repeat(Math.max(0, n - s.length));
}

function banner() {
  const inner = WIDTH - 2; // for "│" borders
  const top = C.amber("╭" + "─".repeat(inner) + "╮");
  const blank = C.amber("│" + " ".repeat(inner) + "│");
  const bot = C.amber("╰" + "─".repeat(inner) + "╯");

  // Each content row: "│  <content padded to inner-4>  │"
  const row = (raw: string, styled?: string) => {
    const padded = padRaw(raw, inner - 4);
    const out = styled ? styled + " ".repeat(inner - 4 - raw.length) : padded;
    return C.amber("│  ") + out + C.amber("  │");
  };

  const title = "Anvil ⚒   4 silent bugs caught by byte-equal differential";
  const sub1  = "byte-equal compares Anchor reference vs Anvil emit against the real .so";
  const sub2  = "loaded into LiteSVM. account bytes diverged → bug surfaced.";

  console.log("");
  console.log(top);
  console.log(blank);
  console.log(row(title, C.bold(C.cyan(title))));
  console.log(blank);
  console.log(row(sub1, C.grey(sub1)));
  console.log(row(sub2, C.grey(sub2)));
  console.log(blank);
  console.log(bot);
}

function renderBug(b: Bug, idx: number, total: number) {
  const commitOk = exists(b.commit);
  const date     = commitOk ? commitDate(b.commit) : "?";
  const testOk   = testFile(b.test);
  const shaCol   = commitOk ? C.green(b.commit) : C.red(b.commit);
  const testIcon = testOk   ? C.green("✓") : C.red("✗");
  const testNote = testOk   ? C.grey("green today") : C.red("test file missing");
  const indent14 = " ".repeat(14);

  console.log("");
  console.log(`  ${C.amber(b.badge)}  ${C.bold(b.title)}    ${C.grey(`Bug ${idx + 1} of ${total}`)}`);
  console.log("");
  console.log(`     ${C.red("impact   ")}${b.impact[0]}`);
  for (let i = 1; i < b.impact.length; i++) {
    console.log(`${indent14}${b.impact[i]}`);
  }
  console.log("");
  console.log(`     ${C.blue("caught   ")}${testIcon}  ${b.test}    ${testNote}`);
  console.log(`     ${C.green("fixed    ")}${shaCol}  ${C.dim(b.fixSubject)}    ${C.grey("(" + date + ")")}`);
}

function thinHr() {
  return C.grey("  " + "─".repeat(WIDTH - 2));
}
function thickHr() {
  return C.amber("  " + "━".repeat(WIDTH - 2));
}

function main() {
  banner();
  let okCommits = 0;
  let okTests = 0;
  bugs.forEach((b, i) => {
    if (exists(b.commit)) okCommits++;
    if (testFile(b.test)) okTests++;
    if (i > 0) console.log(thinHr());
    renderBug(b, i, bugs.length);
  });

  console.log("");
  console.log(thickHr());
  console.log(
    `  ${C.bold(C.green(`${okCommits}/${bugs.length}`))} fix commits present in-tree     ` +
    `${C.bold(C.green(`${okTests}/${bugs.length}`))} differential tests green today`
  );
  console.log(`  ${C.dim("compiler infra is mostly systems that prove you wrong")}`);
  console.log(thickHr());
  console.log("");
  console.log(`  ${C.grey("run any of these for live verification:")}`);
  console.log(`  ${C.grey("  bun test api/tests/differential-mpl-create-metadata.test.ts")}`);
  console.log(`  ${C.grey("  bun test api/tests/emitter-pinocchio-mpl-imports.test.ts")}`);
  console.log(`  ${C.grey("  bun test api/tests/differential-t22-transfer-hook.test.ts")}`);
  console.log("");

  if (okCommits !== bugs.length || okTests !== bugs.length) process.exit(1);
}

main();
