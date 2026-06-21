/**
 * CLI-side stub-marker patterns for the `--strict` deploy gate.
 *
 * Defense-in-depth parallel to the validator (api/src/emitter/output-validator.ts).
 * The validator is the PRIMARY, linkage-tested gate (marker-validator-linkage.test.ts)
 * and `--strict` already ORs its error count in — but this cargo-not-needed scan
 * must achieve PARITY: every ERROR-severity marker in api/src/emitter/markers.ts
 * (ALL_MARKERS) must be matched here too, so the list can't silently drift out of
 * sync with the emit-side constants. The linkage test (stub-marker-linkage.test.ts)
 * enforces that parity.
 */
export const CLI_STUB_MARKER_PATTERNS: RegExp[] = [
  /TODO\(manual\)/,
  /FIXME\(anvil\)/,
  /TODO\(anvil\)/,
  /TODO:\s*parse/,
  /⚠️\s*Anvil[^\n]*manual rebuild required/i,
  /⚠️\s*Anvil[^\n]*not yet supported/i,
  /⚠️\s*Anvil\s+TODO:/,
  /\b0u8\s*\/\*\s*TODO:\s*decimals\b/,
];
