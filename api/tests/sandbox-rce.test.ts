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
// #30: additional payload variants. Each writes a unique sentinel so we
// can attribute which attack succeeded if the assertion fails.
const RCE_HOME_PROOF = `${process.env.HOME ?? "/tmp"}/.anvil-rce-home-proof`;
const RCE_PROCENV_PROOF = "/tmp/anvil-rce-procenv-proof.txt";

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
  for (const p of [RCE_PROOF, `${RCE_PROOF}.env`, RCE_NET_PROOF, RCE_HOME_PROOF, RCE_PROCENV_PROOF]) {
    try { await rm(p); } catch { /* fine */ }
  }
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  for (const p of [RCE_PROOF, `${RCE_PROOF}.env`, RCE_NET_PROOF, RCE_HOME_PROOF, RCE_PROCENV_PROOF]) {
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

  // ── #30: additional payload variants ─────────────────────────────────────

  it("env-strip drops LD_PRELOAD / LD_LIBRARY_PATH (library hijack vectors)", () => {
    // Set them in the parent so we can prove the strip is active. If the
    // strip path ever silently widens to allow LD_*, this test fails.
    process.env.LD_PRELOAD = "/tmp/evil.so";
    process.env.LD_LIBRARY_PATH = "/tmp/evil-libdir";
    try {
      const env = sandboxedEnv();
      expect(env.LD_PRELOAD).toBeUndefined();
      expect(env.LD_LIBRARY_PATH).toBeUndefined();
      // Other dynamic-loader vectors that aren't on the allowlist either.
      expect(env.LD_AUDIT).toBeUndefined();
    } finally {
      delete process.env.LD_PRELOAD;
      delete process.env.LD_LIBRARY_PATH;
    }
  });

  it("env-strip drops common cloud + CI credential vars", () => {
    // Cloud / CI providers all leak their tokens via env. The current
    // allowlist is positive (PATH/HOME/USER/...) so these should all be
    // gone; this test pins the negative case so a future allowlist
    // expansion can't accidentally re-include them.
    const before: Record<string, string | undefined> = {};
    const VARS = [
      "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "DOCKER_PASSWORD",
      "GCP_SA_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET",
      "DO_AUTH_TOKEN", "VERCEL_TOKEN", "CI_JOB_TOKEN",
      "STRIPE_SECRET_KEY", "OPENAI_API_KEY",
      "REDIS_URL", "DATABASE_URL", "SENTRY_DSN",
    ];
    for (const k of VARS) {
      before[k] = process.env[k];
      process.env[k] = "this-should-not-leak";
    }
    try {
      const env = sandboxedEnv();
      for (const k of VARS) {
        expect(env[k]).toBeUndefined();
      }
    } finally {
      for (const k of VARS) {
        if (before[k] === undefined) delete process.env[k];
        else process.env[k] = before[k];
      }
    }
  });

  it("a malicious build.rs cannot write to $HOME or read /proc/self/environ secrets", async () => {
    // Two NEW payload vectors not covered by the original test:
    //   (a) write to $HOME/.anvil-rce-home-proof  -- targets dotfile / SSH
    //       config / shell-rc style escalation. Sandbox FS isolation must
    //       block it; outside any sandbox, the test runner's HOME is writable.
    //   (b) read /proc/self/environ + write a copy to /tmp. If the env
    //       strip from sandboxedEnv() is bypassed (e.g. unshare not actually
    //       cutting env), the parent's secrets show up here.
    const tmp2 = await mkdtemp(join(tmpdir(), "anvil-rce-test2-"));
    await mkdir(join(tmp2, "src"), { recursive: true });
    await writeFile(join(tmp2, "Cargo.toml"), `[package]
name = "rce-test-extras"
version = "0.1.0"
edition = "2021"
build = "build.rs"
[lib]
path = "src/lib.rs"
`);
    await writeFile(join(tmp2, "src/lib.rs"), "pub fn x() {}\n");
    await writeFile(join(tmp2, "build.rs"), `
use std::io::Write;
fn main() {
    // (a) try to write into $HOME
    if let Ok(home) = std::env::var("HOME") {
        let path = format!("{}/.anvil-rce-home-proof", home);
        let _ = std::fs::write(&path, "home-pwned");
    }
    // (b) try to read /proc/self/environ and dump it
    if let Ok(envblob) = std::fs::read("/proc/self/environ") {
        let _ = std::fs::write("${RCE_PROCENV_PROOF}", &envblob);
    }
}
`);

    await new Promise<void>((resolve) => {
      const child = spawnSandboxed("cargo", ["build", "--quiet", "--offline"], {
        cwd: tmp2,
        env: { ...sandboxedEnv(), ANVIL_PARENT_SECRET: "should-not-be-in-procself" },
      });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* fine */ } }, 30_000);
    });
    await rm(tmp2, { recursive: true, force: true });

    const sb = getSandbox();

    if (sb.kind === "none") {
      console.warn("[sandbox-test] kind=none — strict RCE assertions skipped. Install firejail or bwrap for full coverage.");
      return;
    }

    // (a) HOME write must be blocked by FS-isolating sandboxes (firejail
    // --whitelist, bwrap doesn't bind $HOME). unshare doesn't restrict FS,
    // so we accept either outcome there but warn loudly.
    if (sb.kind === "firejail" || sb.kind === "bwrap") {
      expect(await fileExists(RCE_HOME_PROOF)).toBe(false);
    } else if (sb.kind === "unshare" && (await fileExists(RCE_HOME_PROOF))) {
      console.warn(`[sandbox-test] unshare doesn't restrict FS; HOME write succeeded at ${RCE_HOME_PROOF}. firejail / bwrap recommended for full FS isolation.`);
      // Cleanup so the next run starts clean.
      try { await rm(RCE_HOME_PROOF); } catch { /* fine */ }
    }

    // (b) /proc/self/environ read + dump. Even if the dump succeeded,
    // the env-strip MUST have removed ANVIL_PARENT_SECRET so the dumped
    // bytes don't contain it. Tests the env-strip independently of
    // whether /proc reads are blocked (they generally aren't).
    if (await fileExists(RCE_PROCENV_PROOF)) {
      const dumped = await Bun.file(RCE_PROCENV_PROOF).text();
      expect(dumped).not.toContain("should-not-be-in-procself");
      expect(dumped).not.toContain("ANVIL_PARENT_SECRET");
    }
  }, 60_000);
});
