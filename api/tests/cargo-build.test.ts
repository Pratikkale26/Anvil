import { describe, test, expect } from "bun:test";
import { parseAnchor } from "../src/parser/anchor-parser.ts";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const DEMOS = ["counter", "vault", "escrow", "staking", "amm", "marketplace", "vesting"];

const PINOCCHIO_CARGO = `[package]
name = "anvil-test"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
pinocchio = "0.9"
pinocchio-system = "0.4"
pinocchio-token = "0.4"
pinocchio-associated-token-account = "0.4"
`;

const NATIVE_CARGO = `[package]
name = "anvil-test"
version = "0.1.0"
edition = "2021"
[lib]
crate-type = ["cdylib", "lib"]
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
solana-program = "2.2"
spl-token = { version = "7", features = ["no-entrypoint"] }
spl-token-2022 = { version = "6", features = ["no-entrypoint"] }
spl-associated-token-account = { version = "6", features = ["no-entrypoint"] }
spl-memo = { version = "6", features = ["no-entrypoint"] }
thiserror = "2.0"
`;

const BUILD_DIR = "/tmp/anvil-cargo-tests";

function buildProject(code: string, cargoToml: string, name: string): { success: boolean; errors: string[] } {
  const projDir = join(BUILD_DIR, name);

  // Clean and create project directory
  if (existsSync(projDir)) rmSync(projDir, { recursive: true });
  mkdirSync(join(projDir, "src"), { recursive: true });

  writeFileSync(join(projDir, "src", "lib.rs"), code);
  writeFileSync(join(projDir, "Cargo.toml"), cargoToml);

  try {
    execSync("cargo build 2>&1", {
      cwd: projDir,
      timeout: 300_000, // 5 minute timeout
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, errors: [] };
  } catch (err: any) {
    const output = (err.stdout ?? "") + (err.stderr ?? "");
    const errors = output
      .split('\n')
      .filter((line: string) => line.startsWith('error[') || line.startsWith('error:'))
      .slice(0, 10); // Limit to first 10 errors
    return { success: false, errors };
  }
}

describe("Cargo Build Verification", () => {
  // Pinocchio builds
  describe("Pinocchio", () => {
    for (const demo of DEMOS) {
      test(`${demo} compiles with cargo build`, async () => {
        const source = readFileSync(
          join(import.meta.dir, "..", "src", "demo-programs", `${demo}.rs`),
          "utf-8"
        );
        const result = await parseAnchor(source);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const output = emitPinocchioFull(result.ir);
        const buildResult = buildProject(
          output.singleFile,
          PINOCCHIO_CARGO,
          `${demo}-pinocchio`
        );

        if (!buildResult.success) {
          throw new Error(
            `cargo build failed for ${demo}-pinocchio:\n${buildResult.errors.join('\n')}`
          );
        }

        expect(buildResult.success).toBe(true);
      }, 300_000); // 5 minute timeout per test
    }
  });

  // Native builds
  describe("Native", () => {
    for (const demo of DEMOS) {
      test(`${demo} compiles with cargo build`, async () => {
        const source = readFileSync(
          join(import.meta.dir, "..", "src", "demo-programs", `${demo}.rs`),
          "utf-8"
        );
        const result = await parseAnchor(source);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const output = emitNativeFull(result.ir);
        const buildResult = buildProject(
          output.singleFile,
          NATIVE_CARGO,
          `${demo}-native`
        );

        if (!buildResult.success) {
          throw new Error(
            `cargo build failed for ${demo}-native:\n${buildResult.errors.join('\n')}`
          );
        }

        expect(buildResult.success).toBe(true);
      }, 300_000); // 5 minute timeout per test
    }
  });
});
