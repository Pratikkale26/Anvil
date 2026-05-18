/**
 * E3 — validator's T22 extension space-allocation cross-check.
 *
 * Pre-E3 a source that declared `init mint::decimals=6 ... space=82`
 * AND called `cpi_t22_transfer_fee_initialize` produced no warning.
 * The Anchor build allocated 82 bytes (mint base only), the TransferFee
 * init CPI failed at runtime because the extension data didn't fit,
 * and the user found out at deploy time. E3 adds the cross-check at
 * IR-level so the validator refuses the emit pre-build.
 *
 * Three cases exercised:
 *   1. Under-allocation (space too small) → error
 *   2. No explicit space + extensions → warning (Anchor InitSpace
 *      doesn't account for T22 extensions)
 *   3. Sufficient space → no T22-space issue
 *   4. Variable-size extension (TokenMetadata) → warning (precise
 *      compute requires per-call inspection)
 */
import { describe, test, expect } from "bun:test";
import { validateEmitterOutput } from "../src/emitter/output-validator.ts";
import {
  minimumMintSize,
  T22_MINT_BASE_BYTES,
} from "../src/emitter/t22-extension-sizes.ts";
import type { SolanaIR, EmitterOutput } from "../src/ir/schema.ts";

function shellOutput(): EmitterOutput {
  return { files: [], singleFile: "", warnings: [] };
}

function buildIR(opts: {
  spaceValue?: string;
  extensionKinds: SolanaIR["instructions"][0]["body"];
}): SolanaIR {
  const constraints = opts.spaceValue
    ? [
        { kind: "init" as const, value: undefined },
        { kind: "constraint" as const, value: `space = ${opts.spaceValue}` },
      ]
    : [{ kind: "init" as const, value: undefined }];
  return {
    name: "t22_space_check",
    instructions: [
      {
        name: "init_mint",
        accounts: [
          {
            name: "the_mint",
            accountType: "Mint",
            isSigner: false,
            isMut: true,
            isInit: true,
            isOptional: false,
            isPda: false,
            pdaSeeds: [],
            constraints,
          },
        ],
        args: [],
        body: opts.extensionKinds,
        bodyLocs: [],
      },
    ],
    accounts: [],
    types: [],
    constants: [],
    errors: [],
    helperFns: [],
    events: [],
    imports: [],
    userTraitImpls: [],
    warnings: [],
    metadata: {
      sourceFramework: "anchor",
      anvilVersion: "0.4.0",
      parsedAt: new Date().toISOString(),
    },
  };
}

describe("E3: T22 extension space cross-check", () => {
  test("under-allocation → error with computed minimum", () => {
    const ir = buildIR({
      spaceValue: String(T22_MINT_BASE_BYTES), // 82 — mint base only, no extension budget
      extensionKinds: [
        {
          kind: "cpi_t22_transfer_fee_initialize",
          mint: "the_mint",
          tokenProgram: "token_program",
          transferFeeConfigAuthority: "None",
          withdrawWithheldAuthority: "None",
          basisPoints: "100",
          maximumFee: "1000000",
        },
      ],
    });
    const issues = validateEmitterOutput(ir, shellOutput());
    const t22Errors = issues.filter(
      (i) => i.severity === "error" && /Token-2022 TransferFeeConfig/.test(i.message),
    );
    expect(t22Errors.length).toBeGreaterThan(0);
    // Minimum: 82 base + 1 marker + 4 TLV + 116 data = 203
    expect(t22Errors[0]?.message).toMatch(/require at least 203 bytes/);
  });

  test("sufficient space → no T22-space error", () => {
    const minRequired = minimumMintSize(["cpi_t22_transfer_fee_initialize"])!;
    const ir = buildIR({
      spaceValue: String(minRequired),
      extensionKinds: [
        {
          kind: "cpi_t22_transfer_fee_initialize",
          mint: "the_mint",
          tokenProgram: "token_program",
          transferFeeConfigAuthority: "None",
          withdrawWithheldAuthority: "None",
          basisPoints: "100",
          maximumFee: "1000000",
        },
      ],
    });
    const issues = validateEmitterOutput(ir, shellOutput());
    const t22Errors = issues.filter(
      (i) =>
        i.severity === "error" && /Token-2022.*require at least/.test(i.message),
    );
    expect(t22Errors).toEqual([]);
  });

  test("no explicit space + extensions in use → warning", () => {
    const ir = buildIR({
      // No space constraint at all — Anchor's InitSpace doesn't account
      // for T22 extensions, so the user might be silently underallocating.
      extensionKinds: [
        {
          kind: "cpi_t22_metadata_pointer_initialize",
          mint: "the_mint",
          tokenProgram: "token_program",
          authority: "None",
          metadataAddress: "None",
        },
      ],
    });
    const issues = validateEmitterOutput(ir, shellOutput());
    const t22Warnings = issues.filter(
      (i) =>
        i.severity === "warning" &&
        /MetadataPointer/.test(i.message) &&
        /no explicit `space/.test(i.message),
    );
    expect(t22Warnings.length).toBeGreaterThan(0);
  });

  test("variable-size extension (TokenMetadata) → warning, not error", () => {
    const ir = buildIR({
      spaceValue: "300",
      extensionKinds: [
        {
          kind: "cpi_t22_token_metadata_initialize",
          metadata: "the_mint",
          mint: "the_mint",
          mintAuthority: "the_mint",
          updateAuthority: "the_mint",
          tokenProgram: "token_program",
          name: '"foo".to_string()',
          symbol: '"FOO".to_string()',
          uri: '"https://x".to_string()',
        },
      ],
    });
    const issues = validateEmitterOutput(ir, shellOutput());
    const variableWarning = issues.find(
      (i) => i.severity === "warning" && /TokenMetadata/.test(i.message) && /variable-length/.test(i.message),
    );
    expect(variableWarning).toBeDefined();
    // No hard error — variable-size extensions can't be cross-checked exactly.
    const t22Errors = issues.filter(
      (i) =>
        i.severity === "error" && /Token-2022.*require at least/.test(i.message),
    );
    expect(t22Errors).toEqual([]);
  });

  test("multi-extension sums correctly", () => {
    // TransferFee (116 data) + MetadataPointer (64 data) on the same mint:
    // 82 base + 1 marker + (4 TLV + 116) + (4 TLV + 64) = 271 bytes.
    const minRequired = minimumMintSize([
      "cpi_t22_transfer_fee_initialize",
      "cpi_t22_metadata_pointer_initialize",
    ])!;
    expect(minRequired).toBe(271);

    // Allocate just-below — should error.
    const ir = buildIR({
      spaceValue: String(minRequired - 1),
      extensionKinds: [
        {
          kind: "cpi_t22_transfer_fee_initialize",
          mint: "the_mint",
          tokenProgram: "token_program",
          transferFeeConfigAuthority: "None",
          withdrawWithheldAuthority: "None",
          basisPoints: "100",
          maximumFee: "1000000",
        },
        {
          kind: "cpi_t22_metadata_pointer_initialize",
          mint: "the_mint",
          tokenProgram: "token_program",
          authority: "None",
          metadataAddress: "None",
        },
      ],
    });
    const issues = validateEmitterOutput(ir, shellOutput());
    const t22Errors = issues.filter(
      (i) =>
        i.severity === "error" && /require at least 271/.test(i.message),
    );
    expect(t22Errors.length).toBeGreaterThan(0);
  });
});
