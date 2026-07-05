/**
 * Sandbox wrapper for cargo invocations.
 *
 * `cargo check` runs build.rs scripts as part of metadata resolution. A
 * malicious `build.rs` in user-uploaded source can therefore execute
 * arbitrary code with the API process's UID — read /proc/self/environ,
 * exfiltrate ANTHROPIC_API_KEY, hit the network, etc.
 *
 * This module wraps the cargo invocation with the strongest sandbox
 * available on the host. Detection order at startup:
 *
 *   1. firejail   — best ergonomics, drops net + restricts FS via seccomp.
 *   2. bwrap      — bubblewrap, similar guarantees, used by Flatpak.
 *   3. unshare    — kernel-level user/net namespaces. No FS restriction
 *                   beyond what cgroups give us, but blocks network and
 *                   leaves us with prlimit for memory/CPU caps.
 *   4. none       — log a loud warning. Still apply env-strip + prlimit
 *                   so cargo never sees ANTHROPIC_API_KEY and can't fork
 *                   bomb. Acceptable for local dev; not for prod.
 *
 * Independent of which sandbox is selected, every cargo invocation also:
 *   - has the env stripped to a minimal allowlist (PATH, HOME, USER, the
 *     CARGO_* / RUST_* configuration vars). Notably no ANTHROPIC_API_KEY,
 *     AWS_*, etc.
 *   - runs under prlimit caps: 2 GiB AS, 60s CPU, 256 MiB file-size,
 *     128 processes. These prevent the most obvious DoS shapes (fork bomb,
 *     unbounded malloc, /tmp filling) even without a real sandbox.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

export type SandboxKind = "firejail" | "bwrap" | "unshare" | "none";

/**
 * Read-only paths the sandboxed cargo / cargo-build-sbf must SEE: the warmed
 * cargo registry (+ rustup toolchain). The differential/workbench build does a
 * `cargo fetch` OUTSIDE the sandbox (network) to populate $CARGO_HOME/registry
 * — which `cargo fetch` fully extracts to `registry/src` (verified) — then runs
 * `cargo-build-sbf --offline` INSIDE the sandbox. The FS-restricting sandboxes
 * (firejail `--whitelist=cwd`, bwrap binds only /usr+/lib+/etc+cwd) otherwise
 * HIDE $CARGO_HOME, so the offline build fails with "no matching package named
 * `anchor-lang` found ... offline mode (--offline)" on fresh deploys (DO/Docker).
 * unshare doesn't restrict the FS, which is why it works locally but DO doesn't.
 *
 * READ-ONLY is sufficient + safe: fetch pre-extracts the sources, build outputs
 * go to the rw-bound cwd/target, and the build can't mutate the shared registry.
 * existsSync-guarded so a missing path never breaks the sandbox invocation.
 */
function readonlyDepPaths(): string[] {
  const home = process.env.HOME ?? homedir();
  const cargoHome = process.env.CARGO_HOME ?? `${home}/.cargo`;
  const rustupHome = process.env.RUSTUP_HOME ?? `${home}/.rustup`;
  return [...new Set([cargoHome, rustupHome])].filter((p) => existsSync(p));
}

interface SandboxConfig {
  kind: SandboxKind;
  /** Returns the argv prefix to put in front of `cargo`. */
  wrap: (cwd: string) => { cmd: string; args: string[] };
}

function which(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function detectSandbox(): SandboxConfig {
  // Allow operators to force a specific sandbox (or disable) via env.
  const forced = (process.env.ANVIL_SANDBOX ?? "").toLowerCase();
  if (forced && forced !== "auto") {
    if (forced === "none") {
      // Explicit opt-out — operator knows what they're doing.
      console.warn(
        "[sandbox] ANVIL_SANDBOX=none — cargo will run without isolation. Acceptable in local dev only.",
      );
      return noneSandbox();
    }
    if (forced === "firejail" && which("firejail")) return firejailSandbox();
    if (forced === "bwrap" && which("bwrap")) return bwrapSandbox();
    if (forced === "unshare" && which("unshare")) return unshareSandbox();
    console.warn(
      `[sandbox] ANVIL_SANDBOX=${forced} requested but tool not available. Falling back to auto-detect.`,
    );
  }

  if (which("firejail")) return firejailSandbox();
  if (which("bwrap")) return bwrapSandbox();
  if (which("unshare")) {
    // Only useful if unprivileged user namespaces are enabled. Probe once.
    try {
      execSync("unshare -r --net true", { stdio: "ignore" });
      return unshareSandbox();
    } catch {
      console.warn(
        "[sandbox] unshare present but unprivileged user namespaces are disabled. Falling back.",
      );
    }
  }
  console.warn(
    "[sandbox] No sandbox tool available (firejail/bwrap/unshare). Cargo will run with env-strip + prlimit only. Install firejail before deploying to production.",
  );
  return noneSandbox();
}

/**
 * #16 — SBF-build CPU rlimit (seconds). The old hardcoded 60s SIGKILLed
 * legitimately-large targets: a 2k–10k line Anchor program's cargo-build-sbf
 * can exceed a minute of CPU, surfacing as a spurious "build failed" on valid
 * input. Raise the default to 300s — still a hard DoS bound (combined with the
 * build-queue concurrency cap + per-IP rate limit + the global AI ceiling) but
 * enough for real programs — and make it tunable per host.
 */
function sandboxCpuSecs(): number {
  const raw = process.env.ANVIL_SANDBOX_CPU_SECS;
  if (!raw) return 300;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

export function firejailSandbox(): SandboxConfig {
  return {
    kind: "firejail",
    wrap: (cwd: string) => ({
      cmd: "firejail",
      args: [
        "--quiet",
        "--noprofile",
        "--net=none",
        "--private-tmp",
        "--private-dev",
        "--caps.drop=all",
        "--seccomp",
        "--rlimit-as=2147483648",
        `--rlimit-cpu=${sandboxCpuSecs()}`,
        "--rlimit-fsize=268435456",
        "--rlimit-nproc=128",
        `--whitelist=${cwd}`,
        // Expose the warmed cargo registry / toolchain READ-ONLY so the offline
        // build can resolve deps (see readonlyDepPaths). --whitelist makes them
        // visible; --read-only keeps them immutable to the sandboxed build.
        ...readonlyDepPaths().flatMap((p) => [`--whitelist=${p}`, `--read-only=${p}`]),
      ],
    }),
  };
}

export function bwrapSandbox(): SandboxConfig {
  return {
    kind: "bwrap",
    wrap: (cwd: string) => ({
      cmd: "bwrap",
      args: [
        "--ro-bind", "/usr", "/usr",
        "--ro-bind", "/lib", "/lib",
        "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", "/bin", "/bin",
        "--ro-bind", "/etc", "/etc",
        "--bind", cwd, cwd,
        // Expose the warmed cargo registry / toolchain READ-ONLY (see
        // readonlyDepPaths) so the offline cargo-build-sbf can resolve deps.
        ...readonlyDepPaths().flatMap((p) => ["--ro-bind", p, p]),
        "--tmpfs", "/tmp",
        "--proc", "/proc",
        "--dev", "/dev",
        "--unshare-net",
        "--unshare-pid",
        "--die-with-parent",
        "--chdir", cwd,
      ],
    }),
  };
}

function unshareSandbox(): SandboxConfig {
  return {
    kind: "unshare",
    wrap: (_cwd: string) => ({
      // Layered isolation:
      //   - `-r`         user namespace, maps current uid → root inside.
      //   - `--net`      fresh empty net namespace, no interfaces, no DNS.
      //   - `--mount`    fresh mount namespace; mounts inside don't escape.
      // We then exec a tiny shell that mounts a fresh tmpfs over /tmp and
      // /var/tmp so any `fs::write("/tmp/...")` from a malicious build.rs
      // lands in throwaway memory instead of the host's /tmp. The cwd is
      // preserved because the build runner places its scratch dir under
      // $HOME (not /tmp).
      // prlimit caps memory + CPU + file size + processes.
      cmd: "unshare",
      args: [
        "-r", "--net", "--mount",
        "sh",
        "-c",
        // Mount tmpfs over the scratch-write paths an attacker would target.
        // Failures are non-fatal (e.g. /var/tmp may not exist on minimal
        // images) — the rest of the isolation still applies.
        `mount -t tmpfs tmpfs /tmp 2>/dev/null; mount -t tmpfs tmpfs /var/tmp 2>/dev/null; exec prlimit --as=2147483648 --cpu=${sandboxCpuSecs()} --fsize=268435456 --nproc=128 -- "$@"`,
        "anvil-sandbox-shim",
      ],
    }),
  };
}

function noneSandbox(): SandboxConfig {
  return {
    kind: "none",
    wrap: (_cwd: string) => ({
      // Even with no sandbox, prlimit blocks the most obvious DoS shapes.
      cmd: "prlimit",
      args: [
        "--as=2147483648",
        `--cpu=${sandboxCpuSecs()}`,
        "--fsize=268435456",
        "--nproc=128",
        "--",
      ],
    }),
  };
}

let cached: SandboxConfig | null = null;
export function getSandbox(): SandboxConfig {
  if (!cached) {
    cached = detectSandbox();
    console.log(`[sandbox] using kind=${cached.kind}`);
  }
  return cached;
}

/**
 * Minimal env allowlist for cargo. Specifically excludes ANTHROPIC_API_KEY
 * and any other secret-shaped vars the API process holds.
 */
export function sandboxedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allow = new Set([
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL",
    "TERM", "TMPDIR", "PWD",
    // cargo / rustup configuration
    "CARGO_HOME", "RUSTUP_HOME", "RUST_BACKTRACE",
    // cargo registry / network — leave defaults; net namespace will block anyway
  ]);
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.has(k)) env[k] = v;
  }
  // Force-set the values we always want.
  env.RUSTFLAGS = "";
  env.CARGO_TERM_COLOR = "never";
  // Disable cargo's auto-network paths; deps must be pre-fetched into the
  // shared CARGO_HOME (warm scratch project handles this).
  env.CARGO_NET_OFFLINE = "true";
  return env;
}

/**
 * #32 — final-artifact manifest guard for the network-enabled `cargo fetch`
 * warm-up (the ONE cargo invocation that runs OUTSIDE the no-network
 * sandbox). Input validation (validateAnchorExtraDeps, the client-scaffold
 * source-override guard) already blocks injection at intake; this re-checks
 * the Cargo.toml that was ACTUALLY WRITTEN to disk immediately before the
 * fetch spawns, so a future call-path that skips intake validation — or a
 * validator gap — still cannot point the fetch at an attacker host. A full
 * egress allowlist (netns to crates.io only) isn't available in the DO
 * container (no CAP_NET_ADMIN), so this is the enforceable boundary.
 *
 * Section-aware: `git = / path = / registry = / package =` are refused only
 * inside dependency tables (a `[lib] path` or `[package] name` is normal);
 * `[patch.*]` / `[source.*]` / `[registries.*]` sections and `replace-with`
 * are refused anywhere (they redirect resolution wholesale).
 */
export function assertManifestFetchSafe(manifestPath: string): void {
  const text = readFileSync(manifestPath, "utf-8");
  const violations: string[] = [];
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[+([^\]]+)\]+/);
    if (header) {
      section = (header[1] ?? "").trim().toLowerCase();
      if (/^(patch|source|registries)(\.|$)/.test(section)) {
        violations.push(`[${section}] section`);
      }
      continue;
    }
    if (/\breplace-with\b/.test(line)) {
      violations.push(`replace-with in [${section || "root"}]`);
      continue;
    }
    const inDeps = /(^|\.)(dev-|build-|target\.[^.]+\.)?dependencies(\.|$)/.test(section);
    if (inDeps && /(^|[,{\s])["']?(git|path|registry|package)["']?\s*=/.test(line)) {
      violations.push(`\`${line.slice(0, 80)}\` in [${section}]`);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `cargo-fetch manifest guard: refusing network warm-up — ${violations.join("; ")} (only plain crates.io version pins may reach the fetch)`,
    );
  }
}

/**
 * Spawn cargo (or any binary) wrapped in the detected sandbox. The caller
 * provides the inner command and its argv; we prepend the sandbox shim.
 */
export function spawnSandboxed(
  innerCmd: string,
  innerArgs: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): ChildProcess {
  const sandbox = getSandbox();
  const wrap = sandbox.wrap(opts.cwd);
  const argv = [...wrap.args, innerCmd, ...innerArgs];
  return spawn(wrap.cmd, argv, {
    cwd: opts.cwd,
    env: opts.env ?? sandboxedEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}
