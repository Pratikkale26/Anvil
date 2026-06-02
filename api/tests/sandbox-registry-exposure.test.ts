/**
 * Prod fix — the FS-restricting sandboxes (firejail / bwrap) must expose the
 * warmed cargo registry READ-ONLY so the offline `cargo-build-sbf` can resolve
 * deps. Without it, fresh deploys (DigitalOcean / Docker) failed with
 * "no matching package named `anchor-lang` found ... offline mode (--offline)":
 * the differential/workbench build `cargo fetch`es into $CARGO_HOME outside the
 * sandbox, but firejail (--whitelist=cwd) / bwrap (binds only /usr+/lib+/etc+cwd)
 * hid $CARGO_HOME inside the sandbox. (unshare doesn't restrict the FS → worked
 * locally, masking the bug.)
 *
 * Read-only is sufficient + safe: `cargo fetch` pre-extracts the crate sources to
 * registry/src, build outputs land in the rw cwd/target, and the build can't
 * mutate the shared registry.
 */
import { describe, test, expect } from "bun:test";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { firejailSandbox, bwrapSandbox } from "../src/build/sandbox.ts";

const home = process.env.HOME ?? homedir();
const cargoHome = process.env.CARGO_HOME ?? `${home}/.cargo`;
const CWD = "/some/scratch/_workbench_build_counter_anchor";

describe("sandbox exposes the warmed cargo registry read-only (offline-build fix)", () => {
  test("CARGO_HOME exists in this env (sanity — otherwise the assertions below are vacuous)", () => {
    expect(existsSync(cargoHome)).toBe(true);
  });

  test("firejail: --whitelist + --read-only for CARGO_HOME, and still whitelists cwd", () => {
    const { cmd, args } = firejailSandbox().wrap(CWD);
    expect(cmd).toBe("firejail");
    expect(args).toContain(`--whitelist=${CWD}`); // base behavior preserved
    expect(args).toContain(`--whitelist=${cargoHome}`); // registry visible
    expect(args).toContain(`--read-only=${cargoHome}`); // but immutable to the build
    // net cut must remain.
    expect(args).toContain("--net=none");
  });

  test("bwrap: --ro-bind CARGO_HOME and still binds cwd + cuts net", () => {
    const { cmd, args } = bwrapSandbox().wrap(CWD);
    expect(cmd).toBe("bwrap");
    // the ro-bind is the adjacent triple [--ro-bind, cargoHome, cargoHome]
    const idx = args.indexOf("--ro-bind");
    expect(args.join(" ")).toContain(`--ro-bind ${cargoHome} ${cargoHome}`);
    expect(idx).toBeGreaterThanOrEqual(0);
    // cwd still rw-bound (build outputs), net still cut.
    expect(args.join(" ")).toContain(`--bind ${CWD} ${CWD}`);
    expect(args).toContain("--unshare-net");
  });
});
