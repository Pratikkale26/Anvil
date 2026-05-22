/**
 * Project scaffolding — produces the non-Rust files a user needs to turn a
 * raw Anvil emit into a cargo-buildable, devnet-deployable Solana program.
 *
 * Each target gets its own Cargo.toml dep set, README, and deploy script
 * rather than a single generic template. The version pins deliberately
 * match tests/cargo-build.test.ts so what users download is exactly what
 * Anvil's CI proves builds. Upstream version bumps (pinocchio 0.11,
 * solana-program 2.3) are noted in the README as optional upgrades
 * instead of shipped by default — the emitter still writes against the
 * older APIs.
 *
 * Scaffold layout (all targets):
 *   Cargo.toml              target-specific deps + release profile
 *   README.md               target-specific build / test / deploy guide
 *   .cargo/config.toml      ergonomic cargo aliases
 *   .gitignore              standard Rust / Solana exclusions
 *   rust-toolchain.toml     pinned channel for reproducibility
 *   scripts/deploy.sh       devnet deploy wrapper (airdrop + deploy + show)
 *   anvil-manifest.json     generator metadata for bug reports
 */

import type { SolanaIR, EmitterFile } from "../ir/schema.js";

type Target = "pinocchio" | "native";

const ANVIL_VERSION = "0.3.0";

/** Sanitize the program name into a valid Rust crate name. */
function crateName(ir: SolanaIR): string {
  const raw = ir.name || "anvil_program";
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "anvil_program"
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Map of crate-name → Cargo.toml dep line, for crates that real-world Anchor
 * programs commonly depend on. Anvil normally filters these from the emitted
 * `use` statements (so the transpiled program doesn't break when the dep is
 * missing). For the native target — which is API-compatible with regular
 * Solana programs — we instead include the dep when the source imports it,
 * so the transpiled output can reach the same external functionality.
 */
/**
 * Crates we add to Cargo.toml when their identifier appears in the source
 * (parsed from imports + helper bodies + instruction bodies + custom types).
 * Adding a crate here only takes effect on `--target native` since pinocchio
 * has its own list. Versions are pinned to what Anvil validates; users can
 * bump in the README's "Optional upgrades" section.
 *
 * Three categories:
 *   1. SPL ecosystem additions (memo, governance, account-compression, etc.)
 *   2. Common third-party deps Anchor programs reach for (bytemuck, arrayref,
 *      bs58, hex, chrono — the "stdlib for Solana programs")
 *   3. External program SDKs that are lint-flagged but kept compilable
 *      (mpl-core, mpl-token-metadata, pyth, switchboard)
 */
const NATIVE_OPTIONAL_DEPS: Record<string, string> = {
  // External program SDKs.
  // Note: pyth_sdk_solana and pyth_solana_receiver_sdk are NOT in this
  // list. N5b unified Pyth emit on hand-rolled bytes (see emitter-base
  // emitPythReadPriceLegacy / emitPythReadPriceModern), and the source's
  // `use pyth_*::*` lines are filtered out by filteredSourceImports.
  // Re-adding them would compile the pyth crates and re-introduce the
  // borsh-derive proc-macro interop issue that locked the M2/N5
  // ceiling pre-N5b.
  // mpl_core is intentionally NOT in this list. Task #48 S1 unified MPL
  // Core CreateV2 emit on hand-rolled bytes (see mpl_core_create_v2 helper
  // in emitter-base / pinocchio-emitter / native-emitter). Including the
  // crate re-introduces the borsh-derive proc-macro interop issue against
  // mpl-core's 0.10 → solana-address 2.x → borsh-1.6 vs the program's
  // own borsh-1.5 dep, surfacing as a wave of E0277 "Pubkey: BorshSerialize
  // not satisfied" errors across PluginRegistryV1 / PluginAuthority. The
  // `use mpl_core::*` source line is dropped by filteredSourceImports for
  // CreateV2 — other MPL Core CPIs are still lint-flagged.
  mpl_token_metadata:        `mpl-token-metadata = "5.1"`,
  // G5 — switchboard-on-demand 0.4.x transitively pulls borsh 0.10 (vs
  // our 1.6) AND references solana_program::address_lookup_table (absent
  // in 2.2). Adding the crate as a dep cascades unresolvable trait-bound
  // errors across every BorshSerialize derive in the workspace. Source-
  // level `use switchboard_on_demand::*` lines are filtered by
  // filteredSourceImports; body refs are commented out by the T22-style
  // statement walker. Keeping the crate OUT of the dep map is the
  // architectural blocker until upstream fixes the borsh/solana-program
  // pins. Same fix applies to switchboard_v2 (older but same conflict
  // surface). Caught by drift-protocol.
  //   switchboard_on_demand:     `switchboard-on-demand = "0.4"`,
  //   switchboard_v2:            `switchboard-v2 = "0.4"`,
  // SPL extensions (beyond core token + ATA + memo + token-2022)
  spl_account_compression:   `spl-account-compression = "0.4"`,
  spl_governance:            `spl-governance = "4.0"`,
  // EM2: spl-token-metadata-interface — pulled in by anchor-spl 0.31's
  // token_2022 feature, exposed for direct CPI use when emit produces
  // typed cpi_t22_token_metadata_initialize.
  spl_token_metadata_interface: `spl-token-metadata-interface = "0.7"`,
  // G110 — spl-pod (optional_keys::OptionalNonZeroPubkey) for T22
  // metadata update_authority and Pointer extension types. Transitively
  // pulled by spl_token_metadata_interface but cargo needs it declared
  // for `use spl_pod::optional_keys::OptionalNonZeroPubkey` to resolve.
  spl_pod:                   `spl-pod = "0.5"`,
  spl_concurrent_merkle_tree: `spl-concurrent-merkle-tree = "0.4"`,
  spl_noop:                  `spl-noop = "0.2"`,
  // Solana hash helpers used in custom logic
  solana_keccak_hasher:      `solana-keccak-hasher = "2.2"`,
  solana_sha256_hasher:      `solana-sha256-hasher = "2.2"`,
  solana_zk_sdk:             `solana-zk-sdk = "2.2"`,
  // Common third-party crates Anchor programs use directly
  bytemuck:                  `bytemuck = { version = "1", features = ["derive"] }`,
  arrayref:                  `arrayref = "0.3"`,
  bs58:                      `bs58 = "0.5"`,
  hex:                       `hex = "0.4"`,
  chrono:                    `chrono = { version = "0.4", default-features = false }`,
  sha2:                      `sha2 = "0.10"`,
  sha3:                      `sha3 = "0.10"`,
  blake3:                    `blake3 = "1.5"`,
  base64:                    `base64 = "0.22"`,
  num_derive:                `num-derive = "0.4"`,
  num_traits:                `num-traits = "0.2"`,
  num_enum:                  `num_enum = "0.7"`,
  sha2_const_stable:         `sha2-const-stable = "0.1"`,
  ark_bn254:                 `ark-bn254 = "0.4"`,
  ark_ff:                    `ark-ff = "0.4"`,
  ark_serialize:             `ark-serialize = "0.4"`,
  // Fixed-point arithmetic — used by AMM / DEX programs (token-swap,
  // marginfi, etc.) for ratio math without floats. Pinned to 1.28
  // (the last release compatible with rustc 1.89; 1.29+ requires
  // rustc 1.93). Pure-Rust no_std-compatible when default-features
  // disabled.
  fixed:                     `fixed = "=1.28"`,
};

/**
 * Same intent as NATIVE_OPTIONAL_DEPS but for pinocchio. The base
 * pinocchio scaffold only ships pinocchio + pinocchio-system + pinocchio-token
 * + pinocchio-associated-token-account; everything else is on-demand.
 */
const PINOCCHIO_OPTIONAL_DEPS: Record<string, string> = {
  // External program SDKs (these typically don't depend on solana-program,
  // so they tend to compile on pinocchio with `default-features = false`)
  // Same rationale as NATIVE_OPTIONAL_DEPS — mpl_core dropped post task #48 S1.
  mpl_token_metadata:        `mpl-token-metadata = { version = "5.1", default-features = false }`,
  // G101 — Pinocchio scaffolds use pinocchio-token by default, but real-world
  // Anchor programs (marinade) carry bodies that call `spl_token::state::Mint::unpack(...)`
  // / `spl_token::instruction::burn(...)` directly. With no-entrypoint these
  // are library-only — no runtime conflict with pinocchio-token's CPI layer.
  spl_token:                 `spl-token = { version = "7", default-features = false, features = ["no-entrypoint"] }`,
  // Finding #57 — spl-token-2022's confidential_mint_burn/processor.rs
  // calls verify_burn_proof / process_rotate_supply_elgamal_pubkey /
  // etc. that are ONLY defined when the `zk-ops` feature is enabled.
  // default-features includes "zk-ops" but our default-features = false
  // strips it, so we add it back explicitly. Affects v6.0.0 through
  // v8.0.1 confirmed. Pinned to v6 (matches existing Anvil corpus
  // baseline) + zk-ops.
  spl_token_2022:            `spl-token-2022 = { version = "6", default-features = false, features = ["no-entrypoint", "zk-ops"] }`,
  spl_associated_token_account: `spl-associated-token-account = { version = "6", default-features = false, features = ["no-entrypoint"] }`,
  // G104 — spl-memo (no-entrypoint) for programs that emit Memo CPIs via
  // carried bodies. Same library-only safety as G101.
  spl_memo:                  `spl-memo = { version = "6", default-features = false, features = ["no-entrypoint"] }`,
  // Common third-party crates
  bytemuck:                  `bytemuck = { version = "1", features = ["derive"] }`,
  arrayref:                  `arrayref = "0.3"`,
  bs58:                      `bs58 = { version = "0.5", default-features = false, features = ["alloc"] }`,
  hex:                       `hex = { version = "0.4", default-features = false }`,
  sha2:                      `sha2 = { version = "0.10", default-features = false }`,
  sha3:                      `sha3 = { version = "0.10", default-features = false }`,
  blake3:                    `blake3 = { version = "1.5", default-features = false }`,
  num_derive:                `num-derive = "0.4"`,
  num_traits:                `num-traits = { version = "0.2", default-features = false }`,
  // Fixed-point arithmetic for AMM / DEX programs — no_std-compat
  // when default-features disabled. Pinned to 1.28 (rustc 1.89 compat).
  fixed:                     `fixed = { version = "=1.28", default-features = false }`,
};

/** Extract crate prefixes from IR imports AND from carried-over source text
 *  (instruction bodies, helper fns, custom type rawCode). Real Anchor programs
 *  frequently use qualified calls like `solana_sha256_hasher::hashv(...)`
 *  without a matching `use` statement, so an imports-only scan misses them. */
function extractUsedCrates(ir: SolanaIR): Set<string> {
  const seen = new Set<string>();
  const scan = (text: string | undefined) => {
    if (!text) return;
    for (const m of text.matchAll(/\b([a-zA-Z_][\w]*)::/g)) {
      if (m[1]) seen.add(m[1]);
    }
  };
  for (const imp of ir.imports ?? []) scan(imp);
  for (const helper of ir.helperFns ?? []) scan(helper.rawCode);
  for (const typeDef of ir.types ?? []) scan(typeDef.rawCode);
  for (const instr of ir.instructions ?? []) {
    for (const stmt of instr.body ?? []) {
      if ("code" in stmt) scan(stmt.code);
      if ("rawCode" in stmt) scan(stmt.rawCode);
      // EM2: typed IR kinds whose Native emit references external
      // crates that don't appear textually in source-side fields.
      // Without this hint, scaffolding misses the dep.
      if (
        stmt.kind === "cpi_t22_token_metadata_initialize" ||
        stmt.kind === "cpi_t22_token_metadata_update_field" ||
        stmt.kind === "cpi_t22_token_metadata_update_authority"
      ) {
        seen.add("spl_token_metadata_interface");
      }
      // Zero-copy load handlers + struct emit reference `bytemuck::*`
      // for the unsafe Pod / Zeroable impls and from_bytes_mut casts.
      if (
        stmt.kind === "zero_copy_load_init" ||
        stmt.kind === "zero_copy_load_mut" ||
        stmt.kind === "zero_copy_load"
      ) {
        seen.add("bytemuck");
      }
    }
  }
  // The struct emit itself adds `unsafe impl bytemuck::Pod / Zeroable` even
  // if no instruction body uses the loader (rare but possible: a program
  // declaring a zero-copy state type that's only read from off-chain).
  if (ir.accounts?.some((a) => a.isZeroCopy)) {
    seen.add("bytemuck");
  }
  return seen;
}

// ─── Cargo.toml per target ───────────────────────────────────────────────────

function cargoToml(ir: SolanaIR, target: Target): string {
  const name = crateName(ir);
  const header = `[package]
name = "${name}"
version = "0.1.0"
edition = "2021"
description = "Generated by Anvil v${ANVIL_VERSION} — Anchor → ${capitalize(target)} transpile"

[lib]
crate-type = ["cdylib", "lib"]

[features]
no-entrypoint = []
test-sbf = []

[profile.release]
# Rust's default release profile leaves overflow wrapping — disastrous for on-chain
# arithmetic. Anvil emits checked_* everywhere already; this belt-and-suspenders
# catches anything that slipped through.
overflow-checks = true
lto = "fat"
codegen-units = 1
opt-level = 3
`;

  if (target === "pinocchio") {
    const used = extractUsedCrates(ir);
    const optional = Object.entries(PINOCCHIO_OPTIONAL_DEPS)
      .filter(([crate]) => used.has(crate))
      .map(([_, dep]) => dep);
    const optionalSection = optional.length > 0
      ? `\n# Auto-detected from source imports — required for the carried-over\n# helpers and CPI calls that reference these external programs.\n${optional.join("\n")}\n`
      : "";
    return `${header}
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
# Pinned to the versions Anvil's CI validates. Pinocchio 0.11 is available
# upstream but renames AccountInfo → AccountView and Pubkey → Address — Anvil
# currently emits against the 0.9 API. Track progress in README.md.
pinocchio = "0.9"
pinocchio-system = "0.4"
pinocchio-token = "0.4"
pinocchio-associated-token-account = "0.4"
${optionalSection}
[dev-dependencies]
# Preferred Pinocchio test harness — in-process SVM, ~10× faster than
# solana-program-test. Uncomment and run \`cargo test-sbf\` to use it.
# mollusk-svm = "0.5"
`;
  }
  if (target === "native") {
    const used = extractUsedCrates(ir);
    const optional = Object.entries(NATIVE_OPTIONAL_DEPS)
      .filter(([crate]) => used.has(crate))
      .map(([_, dep]) => dep);
    const optionalSection = optional.length > 0
      ? `\n# Auto-detected from source imports — required for the carried-over\n# helpers and CPI calls that reference these external programs.\n${optional.join("\n")}\n`
      : "";
    return `${header}
[dependencies]
borsh = { version = "1.5", features = ["derive"] }
# Pinned to the versions Anvil's CI validates. solana-program 2.3 / spl-token 9 /
# spl-associated-token-account 8 are available upstream and backwards-compatible
# — bump after verifying your program still builds.
solana-program = "2.2"
spl-token = { version = "7", features = ["no-entrypoint"] }
spl-token-2022 = { version = "6", features = ["no-entrypoint", "zk-ops"] }
spl-associated-token-account = { version = "6", features = ["no-entrypoint"] }
spl-memo = { version = "6", features = ["no-entrypoint"] }
thiserror = "2.0"
${optionalSection}
[dev-dependencies]
# LiteSVM is the 2026 recommendation for native program tests — in-process,
# fast, no validator process. Uncomment to use.
# litesvm = "0.6"
# solana-sdk = "2.3"
`;
  }
  // Unreachable post-Quasar removal — both supported targets handled above.
  throw new Error(`unsupported target: ${target as string}`);
}

// ─── .cargo/config.toml — common cargo aliases ─────────────────────────────

function cargoConfigToml(_target: Target): string {
  // Cargo aliases only — no dead `deploy-dev` alias, since cargo can't execute
  // shell scripts via aliases (confirmed via verification agent). Deploy flow
  // stays under `bash scripts/deploy.sh` which is what the README recommends.
  return `# Cargo aliases — type \`cargo bsbf\` instead of \`cargo build-sbf\`, etc.
# Generated by Anvil. Safe to remove or extend.

[alias]
bsbf = "build-sbf"
tsbf = "test-sbf"

# Uncomment to pass custom linker flags for tighter on-chain binaries.
# [target.sbf-solana-solana]
# rustflags = ["-C", "link-arg=-zseparate-loadable-segments"]
`;
}

// ─── rust-toolchain.toml ────────────────────────────────────────────────────

function rustToolchain(): string {
  // Pinned to stable for reproducibility. Users who need the Anza Solana
  // platform-tools toolchain will install it separately via solana-install.
  return `[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
profile = "minimal"
`;
}

// ─── .gitignore ─────────────────────────────────────────────────────────────

function gitignore(): string {
  return `# Rust / Solana build output
/target
Cargo.lock
*.so
*.rs.bk

# Anchor / Solana tooling
.anchor/
test-ledger/

# IDE
.idea/
.vscode/*
!.vscode/settings.json
!.vscode/launch.json
!.vscode/extensions.json

# OS
.DS_Store
Thumbs.db

# Deployed keypair (NEVER commit — it's your program authority)
deploy-keypair.json
`;
}

// ─── scripts/deploy.sh ─────────────────────────────────────────────────────

function deployScript(ir: SolanaIR, _target: Target): string {
  const name = crateName(ir);
  return `#!/usr/bin/env bash
# Deploy ${name} to devnet.
# Prerequisites:
#   solana --version   (3.1.x or newer)
#   solana config set --url devnet
#   solana-keygen new  (once)
set -euo pipefail

SO_PATH="target/deploy/${name}.so"
KEYPAIR="\${KEYPAIR:-./deploy-keypair.json}"

if [ ! -f "\$KEYPAIR" ]; then
  echo "→ creating program keypair at \$KEYPAIR"
  solana-keygen new --no-bip39-passphrase -o "\$KEYPAIR"
fi

PROGRAM_ID="\$(solana-keygen pubkey "\$KEYPAIR")"
echo "→ program id: \$PROGRAM_ID"

echo "→ building SBF binary"
cargo build-sbf

echo "→ airdropping 2 SOL if balance is low"
BALANCE_RAW="\$(solana balance 2>/dev/null || echo '0 SOL')"
BALANCE="\${BALANCE_RAW%% *}"
if [ -z "\$BALANCE" ] || awk "BEGIN{exit !(\$BALANCE<2)}"; then
  solana airdrop 2 || true
fi

echo "→ deploying \$SO_PATH"
solana program deploy "\$SO_PATH" --program-id "\$KEYPAIR"

echo "→ done · program id \$PROGRAM_ID"
echo "→ tail logs with:  solana logs \$PROGRAM_ID"
`;
}

// ─── README per target ──────────────────────────────────────────────────────

function readmePinocchio(ir: SolanaIR): string {
  const name = crateName(ir);
  return `# ${name}

Generated by **[Anvil](https://anvilsol.xyz)** from Anchor source. Target framework: **Pinocchio**.

> Pinocchio is a zero-copy, zero-dependency Solana program framework by Anza.
> It strips Anchor's overhead and is the go-to framework when every compute
> unit counts. A "hello world" costs ~25 CU on Pinocchio vs ~2,500 CU on
> \`solana-program\`. [Upstream repo](https://github.com/anza-xyz/pinocchio).

---

## Prerequisites

| | version | install |
|---|---|---|
| **Rust** | 1.75+ (1.89+ recommended) | https://rustup.rs |
| **Solana CLI** | Agave 2.0+ | \`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"\` |

Verify:

\`\`\`bash
rustc --version
solana --version
cargo build-sbf --help
\`\`\`

## Build

\`\`\`bash
# Host-side build — fastest way to verify the code compiles.
cargo build
# or via the provided alias:
cargo bsbf    # alias for cargo build-sbf

# On-chain build — produces target/deploy/${name}.so.
cargo build-sbf
\`\`\`

## Test

\`\`\`bash
# Unit / integration tests (cargo's regular harness).
cargo test

# SBF-target tests — compile tests to SBF and run them under the runtime.
cargo test-sbf

# For a faster in-process harness, uncomment \`mollusk-svm\` in [dev-dependencies]
# and write your tests against it directly (no special cargo subcommand needed).
\`\`\`

## Deploy to devnet

The provided script generates a keypair, airdrops SOL, and deploys in one shot:

\`\`\`bash
bash scripts/deploy.sh
\`\`\`

Or manually:

\`\`\`bash
solana config set --url devnet
solana-keygen new -o deploy-keypair.json
solana airdrop 2
cargo build-sbf
solana program deploy target/deploy/${name}.so --program-id deploy-keypair.json
solana logs $(solana-keygen pubkey deploy-keypair.json)
\`\`\`

## Gotchas (Pinocchio-specific)

1. **\`entrypoint!\`** expands to the program entrypoint **plus** a default bump allocator and panic handler. If you never heap-allocate, \`no_allocator!\` + \`nostd_panic_handler!\` can save you a few CUs. See the [Pinocchio README](https://github.com/anza-xyz/pinocchio#defining-the-program-entrypoint).
2. **\`no_std\`**: the SDK itself is \`no_std\`. Avoid \`std::collections\`, \`println!\`, \`format!\`. Use \`pinocchio::log::sol_log\` (or the \`pinocchio-log\` crate for better ergonomics).
3. **State layout**: zero-copy programs use \`#[repr(C)]\` with fixed-size fields. Place \`u64\` and \`Pubkey\` first for natural alignment. Avoid \`Vec\`, \`String\` in state — borsh can still serialize them but you lose the zero-copy win.
4. **PDAs**: \`find_program_address\` costs ~1,500 CU per iteration. **Always store the bump on the account** (Anvil emits this automatically) so subsequent invocations skip derivation.
5. **Overflow-safe arithmetic**: Anvil emits \`checked_add\` / \`checked_sub\` / \`checked_mul\` on all state-field mutations; don't replace them with \`+ / - / *\` without understanding the DeFi exploit risk.

## Upgrading the Pinocchio version

The scaffold pins \`pinocchio = "0.9"\` because that's what Anvil's CI validates. Upstream 0.11 introduced breaking renames (\`AccountInfo → AccountView\`, \`Pubkey → Address\`) — if you bump, you'll also need to find-replace those in the emitted code.

\`\`\`bash
# Attempt an upgrade — keep the old lockfile around first.
cp Cargo.lock Cargo.lock.backup
cargo update -p pinocchio --precise 0.11.1
cargo check
\`\`\`

## Files in this project

| | |
|---|---|
| \`src/lib.rs\` | The single-file emit from Anvil (instructions + state + helpers) |
| \`Cargo.toml\` | Pinned Pinocchio deps |
| \`.cargo/config.toml\` | Cargo aliases for \`cargo bsbf\` etc. |
| \`rust-toolchain.toml\` | Stable Rust pin |
| \`scripts/deploy.sh\` | Devnet deploy wrapper |
| \`anvil-manifest.json\` | Generation metadata — attach to bug reports |

## What Anvil did

Anvil parsed the Anchor source into a typed \`SolanaIR\` and emitted Pinocchio
Rust. The deterministic validator ran structural checks (PDA verification,
constraint coverage, bracket balance, Anchor-leakage detection). If any
check failed, a single AI refine call with strict re-validation was offered
at the UI layer. Everything that's in \`src/lib.rs\` has been validated.

## Docs & community

- Pinocchio repo + examples — https://github.com/anza-xyz/pinocchio
- docs.rs — https://docs.rs/pinocchio
- Releases / changelog — https://github.com/anza-xyz/pinocchio/releases
- Community examples — https://github.com/febo/pinocchio-examples
- Anvil repo (file bugs here) — https://github.com/pratikkale26/anvil
`;
}

function readmeNative(ir: SolanaIR): string {
  const name = crateName(ir);
  return `# ${name}

Generated by **[Anvil](https://anvilsol.xyz)** from Anchor source. Target framework: **Native (raw \`solana-program\`)**.

> The native target is closest to the Solana runtime — no Anchor, no
> Pinocchio, just \`solana-program\` directly. Useful when you need full
> control over instruction parsing, account validation, and CPI
> construction. Bigger CU footprint than Pinocchio but the most portable.

---

## Prerequisites

| | version | install |
|---|---|---|
| **Rust** | 1.75+ | https://rustup.rs |
| **Solana CLI** | Agave 2.0+ | \`sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"\` |

Verify:

\`\`\`bash
rustc --version
solana --version
cargo build-sbf --help
\`\`\`

## Build

\`\`\`bash
# Host-side compile — fastest sanity check.
cargo check

# On-chain build — produces target/deploy/${name}.so.
cargo build-sbf
# or via the alias:
cargo bsbf
\`\`\`

Note: \`cargo build-bpf\` still works as a shim but is deprecated. Use \`build-sbf\`.

## Local dev with solana-test-validator

Run a local validator in a second terminal:

\`\`\`bash
solana-test-validator --reset
\`\`\`

Point the CLI at it and deploy:

\`\`\`bash
solana config set --url localhost
cargo build-sbf
solana program deploy target/deploy/${name}.so
\`\`\`

Tail the logs in a third terminal:

\`\`\`bash
solana logs <YOUR_PROGRAM_ID>
\`\`\`

## Test (LiteSVM recommended)

LiteSVM embeds the Solana runtime in-process — the 2026 canonical test
harness. Uncomment the \`[dev-dependencies]\` block in \`Cargo.toml\` and
write tests in \`tests/\`:

\`\`\`rust
use litesvm::LiteSVM;

#[test]
fn deploys_and_runs() {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!("../target/deploy/${name}.so");
    let program_id = solana_sdk::pubkey::Pubkey::new_unique();
    svm.add_program(program_id, bytes);
    // ...build instruction, send via svm.send_transaction(...)
}
\`\`\`

## Deploy to devnet

One-liner:

\`\`\`bash
bash scripts/deploy.sh
\`\`\`

Under the hood: creates a program keypair if missing, requests a 2-SOL
airdrop, builds the SBF binary, deploys with the matching program ID, and
prints the command to tail logs.

## Gotchas (native-specific)

1. **Instruction parsing is manual.** Native programs get no free routing — match byte-0 of \`instruction_data\` yourself. Don't collide with Anchor's 8-byte discriminators if you plan to interop with Anchor IDLs.
2. **Borsh vs bincode.** Borsh is the ecosystem default (deterministic, no length-prefix surprises). \`bincode\` is effectively banned on-chain. Raw \`&[u8]\` slicing wins on CUs but is error-prone — reserve it for hot paths.
3. **\`invoke\` vs \`invoke_signed\`.** \`invoke\` forwards the caller's signer set unchanged — use for user-signed CPIs (e.g. token transfer from a user). \`invoke_signed\` additionally signs for PDAs your program owns — required any time a PDA must authorize.
4. **PDAs.** \`Pubkey::find_program_address\` iterates bumps 255 → 0 — use it off-chain. On-chain, pass the bump in the instruction data and verify with \`create_program_address(&[...seeds, &[bump]], program_id)\`. \`find_program_address\` on-chain costs ~1,500 CU per bump tried.
5. **Rent exemption.** Size accounts with \`Rent::get()?.minimum_balance(data_len)\` and fund at creation. Under-funded accounts are garbage-collected.
6. **\`rent_epoch\`.** Ignored in solana-sdk v3 and newer — don't rely on it.

## Optional: upgrade to solana-program 2.3 / spl-token 9

The pins in \`Cargo.toml\` match Anvil's CI. Newer stable versions are
available and backwards-compatible:

\`\`\`bash
cargo add solana-program@2.3 spl-token@9 spl-associated-token-account@8
cargo check
\`\`\`

If \`cargo check\` still passes after the bump, ship it.

## Files in this project

| | |
|---|---|
| \`src/lib.rs\` | The single-file emit from Anvil |
| \`Cargo.toml\` | solana-program + spl-token deps |
| \`.cargo/config.toml\` | Cargo aliases |
| \`rust-toolchain.toml\` | Stable Rust pin |
| \`scripts/deploy.sh\` | Devnet deploy wrapper |
| \`anvil-manifest.json\` | Generation metadata |

## Docs & community

- Official Rust program guide — https://solana.com/docs/programs/rust
- Native program intro — https://solana.com/developers/guides/getstarted/intro-to-native-rust
- Program examples — https://github.com/solana-developers/program-examples
- LiteSVM — https://litesvm.github.io/litesvm/
- Anza CLI docs — https://docs.anza.xyz/cli/install
- SPL Token — https://spl.solana.com/token
- Anvil repo (file bugs here) — https://github.com/pratikkale26/anvil
`;
}

function readme(ir: SolanaIR, target: Target): string {
  if (target === "pinocchio") return readmePinocchio(ir);
  return readmeNative(ir);
}

// ─── anvil-manifest.json ────────────────────────────────────────────────────

function manifest(ir: SolanaIR, target: Target): string {
  return (
    JSON.stringify(
      {
        generator: "anvil",
        generatorVersion: ANVIL_VERSION,
        generatedAt: new Date().toISOString(),
        target,
        programName: ir.name,
        instructionCount: ir.instructions.length,
        accountCount: ir.accounts.length,
        feedback: "https://github.com/pratikkale26/anvil/issues",
      },
      null,
      2,
    ) + "\n"
  );
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Build the non-Rust project files for a target. Callers prepend these to
 * the emitter output to produce a fully buildable Cargo project.
 *
 * scripts/deploy.sh is marked executable via a shebang, but the tar builder
 * on the frontend can't set the unix exec bit through the browser download
 * pipeline — the README explicitly instructs users to `chmod +x`.
 */
export function buildProjectScaffold(ir: SolanaIR, target: Target): EmitterFile[] {
  return [
    { path: "Cargo.toml", content: cargoToml(ir, target) },
    { path: "README.md", content: readme(ir, target) },
    { path: ".cargo/config.toml", content: cargoConfigToml(target) },
    { path: ".gitignore", content: gitignore() },
    { path: "rust-toolchain.toml", content: rustToolchain() },
    { path: "scripts/deploy.sh", content: deployScript(ir, target) },
    { path: "anvil-manifest.json", content: manifest(ir, target) },
  ];
}
