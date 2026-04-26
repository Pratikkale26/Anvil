/**
 * RCE-resistance smoke test for the build sandbox.
 *
 * Cargo runs build.rs scripts during `cargo check`. A malicious build.rs
 * in user-controlled source could exfiltrate env / write to disk / hit
 * the network. This test drops a payload that tries each of those and
 * asserts they all fail.
 *
 * Test paths run cargo against a temp project we control directly (not
 * through the API runBuild path). That keeps the test independent of
 * which deps the prod scratch projects pin.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSandboxed, sandboxedEnv, getSandbox } from "../src/build/sandbox.js";

const RCE_PROOF = "/tmp/anvil-rce-proof.txt";
const RCE_NET_PROOF = "/tmp/anvil-rce-net-proof.txt";

let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "anvil-sandbox-test-"));
  await mkdir(join(tmp, "src"), { recursive: true });

  // Trivial Cargo.toml + build.rs that tries to (1) write outside cwd,
  // (2) exfiltrate an env var, (3) reach the network.
  await writeFile(join(tmp, "Cargo.toml"), `[package]
name = "rce-test"
version = "0.1.0"
edition = "2021"
build = "build.rs"
[lib]
path = "src/lib.rs"
`);
  await writeFile(join(tmp, "src/lib.rs"), "pub fn x() {}\n");
  await writeFile(join(tmp, "build.rs"), `
use std::io::Write;
fn main() {
    // (1) write outside cwd to a well-known path
    let _ = std::fs::write("${RCE_PROOF}", "rce");
    // (2) exfiltrate env (write whatever ANVIL_TEST_SECRET we set)
    if let Ok(v) = std::env::var("ANVIL_TEST_SECRET") {
        let _ = std::fs::write("${RCE_PROOF}.env", v);
    }
    // (3) attempt outbound connection
    if let Ok(mut s) = std::net::TcpStream::connect_timeout(
        &"1.1.1.1:80".parse().unwrap(),
        std::time::Duration::from_millis(500),
    ) {
        let _ = s.write_all(b"GET / HTTP/1.0\\r\\n\\r\\n");
        let _ = std::fs::write("${RCE_NET_PROOF}", "net");
    }
}
`);

  // Wipe any previous proof files so a stale one doesn't fool us.
  for (const p of [RCE_PROOF, `${RCE_PROOF}.env`, RCE_NET_PROOF]) {
    try { await rm(p); } catch { /* fine */ }
  }
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  for (const p of [RCE_PROOF, `${RCE_PROOF}.env`, RCE_NET_PROOF]) {
    try { await rm(p); } catch { /* fine */ }
  }
});

async function fileExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe("build sandbox blocks RCE shapes", () => {
  it("detects a usable sandbox kind", () => {
    const sb = getSandbox();
    // 'none' is acceptable for local dev but loud about it; we just want
    // to confirm detection ran without crashing.
    expect(["firejail", "bwrap", "unshare", "none"]).toContain(sb.kind);
  });

  it("a malicious build.rs cannot write outside cwd, leak env, or open the network", async () => {
    // Run cargo build inside the sandbox. It will compile + run our
    // malicious build.rs. If any of the three writes happen, we have RCE.
    await new Promise<void>((resolve) => {
      const child = spawnSandboxed("cargo", ["build", "--quiet", "--offline"], {
        cwd: tmp,
        env: { ...sandboxedEnv(), ANVIL_TEST_SECRET: "this-should-not-leak" },
      });
      // We don't care about exit code — cargo may fail with --offline if
      // there are no deps cached, that's fine. The proof is whether the
      // payload's side effects happened.
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      // Hard timeout so the test can't hang.
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* fine */ } }, 30_000);
    });

    const sb = getSandbox();

    if (sb.kind === "none") {
      // No real sandbox — we expect prlimit-only. The test should still
      // run, but we skip the strict assertions and surface a warning.
      console.warn("[sandbox-test] kind=none — strict RCE assertions skipped. Install firejail or bwrap for full coverage.");
      return;
    }

    // With any real sandbox, all three side effects should be blocked.
    expect(await fileExists(RCE_PROOF)).toBe(false);
    expect(await fileExists(`${RCE_PROOF}.env`)).toBe(false);
    expect(await fileExists(RCE_NET_PROOF)).toBe(false);
  }, 60_000);

  it("env-strip removes ANTHROPIC_API_KEY from the spawned cargo env", () => {
    const env = sandboxedEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // But basic shell vars are preserved.
    expect(env.PATH).toBeTruthy();
  });
});
