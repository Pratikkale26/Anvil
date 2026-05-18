/**
 * N7 — Snapshot sweep for the 10 Metaplex Token Metadata CPI helpers shipped
 * in the catalog-closure session. Each per-slot unit test asserts on
 * contains-style invariants (disc byte, AccountMeta shape, invoke vs
 * invoke_signed). Those catch behavioral regressions; this layer freezes
 * the rendered Rust so whitespace/format drift, signature changes, and
 * argument-order shuffling become visible diffs in PR review.
 *
 * Helper extraction (not full-file snapshot): the emitter wraps each
 * helper in a much larger output with entry-point, dispatch, and
 * boilerplate. Snapshotting only the helper body keeps the diff focused
 * on what changed. Reviewers grep elsewhere if the call site shifts.
 *
 * First-run behavior: writes the snapshot file. Subsequent runs compare;
 * on mismatch, writes `.actual.rs` for diffing and throws with the
 * update incantation.
 *
 * Update snapshots: `rm api/tests/snapshots/emitter-mpl/*.rs && bun test
 * api/tests/emitter-mpl-snapshots.test.ts` after verifying the diff is
 * intentional.
 */
import { describe, test, expect } from "bun:test";
import { emitPinocchioFull } from "../src/emitter/pinocchio-emitter.ts";
import { emitNativeFull } from "../src/emitter/native-emitter.ts";
import { SolanaIRSchema, type SolanaIR, type BodyStatement } from "../src/ir/schema.ts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SNAP_DIR = join(import.meta.dir, "snapshots", "emitter-mpl");
if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });

type AcctSpec = {
  name: string;
  accountType: string;
  isSigner?: boolean;
  isMut?: boolean;
};

function mkAcct(spec: AcctSpec) {
  return {
    name: spec.name,
    accountType: spec.accountType,
    isSigner: spec.isSigner ?? false,
    isMut: spec.isMut ?? false,
    isInit: false,
    isOptional: false,
    isPda: false,
    pdaSeeds: [],
    constraints: [],
  };
}

function mkIR(ixName: string, accounts: AcctSpec[], body: BodyStatement[]): SolanaIR {
  // Routed through schema.parse so field-name typos in body statements
  // (which would otherwise pass through TS structural typing) surface as
  // a loud parse error at the fixture site, not deep inside the visitor.
  return SolanaIRSchema.parse({
    name: "mpl_snap",
    instructions: [
      {
        name: ixName,
        accounts: accounts.map(mkAcct),
        args: [],
        body: [...body, { kind: "return_ok" }],
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
      // Pinned so the emit is deterministic across runs.
      parsedAt: "2026-05-18T00:00:00Z",
    },
  });
}

/**
 * Pull just the named helper function out of the emit. Tracks brace depth
 * starting at the opening `{` and stops when the matching close fires.
 * Returns a placeholder if the helper isn't found — that itself surfaces
 * as a snapshot diff and forces an audit.
 */
function extractHelper(emit: string, helperName: string): string {
  const lines = emit.split("\n");
  const startIdx = lines.findIndex(
    (l) => l.includes(`fn ${helperName}(`) || l.includes(`fn ${helperName}<'a>(`),
  );
  if (startIdx < 0) return `<HELPER NOT FOUND: ${helperName}>\n`;
  let depth = 0;
  let started = false;
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    out.push(lines[i]!);
    for (const ch of lines[i]!) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth === 0) return out.join("\n") + "\n";
  }
  return out.join("\n") + "\n<UNCLOSED HELPER>\n";
}

function compareToSnap(label: string, body: string): void {
  const snapPath = join(SNAP_DIR, `${label}.rs`);
  if (!existsSync(snapPath)) {
    writeFileSync(snapPath, body);
    console.log(`  seeded snapshot: ${label}.rs`);
    return;
  }
  const expected = readFileSync(snapPath, "utf-8");
  if (body !== expected) {
    writeFileSync(join(SNAP_DIR, `${label}.actual.rs`), body);
    throw new Error(
      `Snapshot mismatch for ${label}.\n` +
        `Generated: ${body.split("\n").length} lines, ${body.length} bytes\n` +
        `Snapshot : ${expected.split("\n").length} lines, ${expected.length} bytes\n` +
        `Actual written to ${label}.actual.rs.\n` +
        `If intentional: rm ${snapPath} && bun test api/tests/emitter-mpl-snapshots.test.ts`,
    );
  }
}

// ─── Slot fixtures ─────────────────────────────────────────────────────────
// One row per IR kind. The IR for each slot is the minimal account set +
// body statement that triggers the helper. Account ordering matches the
// helper's expected AccountMeta sequence — keep in lockstep with the emit.

type Slot = {
  label: string;
  helper: string;
  ir: () => SolanaIR;
};

const SLOTS: Slot[] = [
  {
    label: "update_metadata_accounts_v2",
    helper: "mpl_update_metadata_accounts_v2",
    ir: () =>
      mkIR(
        "update_meta",
        [
          { name: "metadata", accountType: "UncheckedAccount", isMut: true },
          { name: "update_authority", accountType: "Signer", isSigner: true },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_update_metadata_accounts_v2",
            metadata: "metadata",
            updateAuthority: "update_authority",
            newUpdateAuthority: "None",
            newName: undefined,
            newSymbol: undefined,
            newUri: undefined,
            newSellerFeeBasisPoints: "0",
            primarySaleHappened: "None",
            isMutable: "None",
          },
        ],
      ),
  },
  {
    label: "verify_collection",
    helper: "mpl_verify_collection",
    ir: () =>
      mkIR(
        "verify",
        [
          { name: "metadata", accountType: "UncheckedAccount", isMut: true },
          { name: "collection_authority", accountType: "Signer", isSigner: true },
          { name: "payer", accountType: "Signer", isSigner: true },
          { name: "collection_mint", accountType: "UncheckedAccount" },
          { name: "collection_metadata", accountType: "UncheckedAccount" },
          { name: "collection_master_edition", accountType: "UncheckedAccount" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_verify_collection",
            metadata: "metadata",
            collectionAuthority: "collection_authority",
            payer: "payer",
            collectionMint: "collection_mint",
            collection: "collection_metadata",
            collectionMasterEdition: "collection_master_edition",
            collectionAuthorityRecord: "None",
          },
        ],
      ),
  },
  {
    label: "sign_metadata",
    helper: "mpl_sign_metadata",
    ir: () =>
      mkIR(
        "sign",
        [
          { name: "metadata", accountType: "UncheckedAccount", isMut: true },
          { name: "creator", accountType: "Signer", isSigner: true },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [{ kind: "cpi_mpl_sign_metadata", metadata: "metadata", creator: "creator" }],
      ),
  },
  {
    label: "unverify_collection",
    helper: "mpl_unverify_collection",
    ir: () =>
      mkIR(
        "unverify",
        [
          { name: "metadata", accountType: "UncheckedAccount", isMut: true },
          { name: "collection_authority", accountType: "Signer", isSigner: true },
          { name: "collection_mint", accountType: "UncheckedAccount" },
          { name: "collection_metadata", accountType: "UncheckedAccount" },
          { name: "collection_master_edition", accountType: "UncheckedAccount" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_unverify_collection",
            metadata: "metadata",
            collectionAuthority: "collection_authority",
            payer: "payer",
            collectionMint: "collection_mint",
            collection: "collection_metadata",
            collectionMasterEdition: "collection_master_edition",
            collectionAuthorityRecord: "None",
          },
        ],
      ),
  },
  {
    label: "set_and_verify_collection",
    helper: "mpl_set_and_verify_collection",
    ir: () =>
      mkIR(
        "set_and_verify",
        [
          { name: "metadata", accountType: "UncheckedAccount", isMut: true },
          { name: "collection_authority", accountType: "Signer", isSigner: true },
          { name: "payer", accountType: "Signer", isSigner: true },
          { name: "update_authority", accountType: "UncheckedAccount" },
          { name: "collection_mint", accountType: "UncheckedAccount" },
          { name: "collection_metadata", accountType: "UncheckedAccount" },
          { name: "collection_master_edition", accountType: "UncheckedAccount" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_set_and_verify_collection",
            metadata: "metadata",
            collectionAuthority: "collection_authority",
            payer: "payer",
            updateAuthority: "update_authority",
            collectionMint: "collection_mint",
            collection: "collection_metadata",
            collectionMasterEdition: "collection_master_edition",
            collectionAuthorityRecord: "None",
          },
        ],
      ),
  },
  {
    label: "approve_collection_authority",
    helper: "mpl_approve_collection_authority",
    ir: () =>
      mkIR(
        "approve_ca",
        [
          { name: "collection_authority_record", accountType: "UncheckedAccount", isMut: true },
          { name: "new_collection_authority", accountType: "UncheckedAccount" },
          { name: "update_authority", accountType: "Signer", isSigner: true },
          { name: "payer", accountType: "Signer", isSigner: true, isMut: true },
          { name: "metadata", accountType: "UncheckedAccount" },
          { name: "mint", accountType: "UncheckedAccount" },
          { name: "system_program", accountType: "Program" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_approve_collection_authority",
            collectionAuthorityRecord: "collection_authority_record",
            newCollectionAuthority: "new_collection_authority",
            updateAuthority: "update_authority",
            payer: "payer",
            metadata: "metadata",
            mint: "mint",
          },
        ],
      ),
  },
  {
    label: "revoke_collection_authority",
    helper: "mpl_revoke_collection_authority",
    ir: () =>
      mkIR(
        "revoke_ca",
        [
          { name: "collection_authority_record", accountType: "UncheckedAccount", isMut: true },
          { name: "delegate_authority", accountType: "Signer", isSigner: true, isMut: true },
          { name: "revoke_authority", accountType: "Signer", isSigner: true },
          { name: "metadata", accountType: "UncheckedAccount" },
          { name: "mint", accountType: "UncheckedAccount" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_revoke_collection_authority",
            collectionAuthorityRecord: "collection_authority_record",
            delegateAuthority: "delegate_authority",
            revokeAuthority: "revoke_authority",
            metadata: "metadata",
            mint: "mint",
          },
        ],
      ),
  },
  {
    label: "mint_new_edition_from_master",
    helper: "mpl_mint_new_edition_from_master",
    ir: () =>
      mkIR(
        "mint_edition",
        [
          { name: "new_metadata", accountType: "UncheckedAccount", isMut: true },
          { name: "new_edition", accountType: "UncheckedAccount", isMut: true },
          { name: "master_edition", accountType: "UncheckedAccount", isMut: true },
          { name: "new_mint", accountType: "UncheckedAccount", isMut: true },
          { name: "edition_mark_pda", accountType: "UncheckedAccount", isMut: true },
          { name: "new_mint_authority", accountType: "Signer", isSigner: true },
          { name: "payer", accountType: "Signer", isSigner: true, isMut: true },
          { name: "token_account_owner", accountType: "Signer", isSigner: true },
          { name: "token_account", accountType: "UncheckedAccount" },
          { name: "new_metadata_update_authority", accountType: "UncheckedAccount" },
          { name: "metadata", accountType: "UncheckedAccount" },
          { name: "token_program", accountType: "Program" },
          { name: "system_program", accountType: "Program" },
          { name: "rent", accountType: "UncheckedAccount" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_mint_new_edition_from_master",
            newMetadata: "new_metadata",
            newEdition: "new_edition",
            masterEdition: "master_edition",
            newMint: "new_mint",
            editionMarkPda: "edition_mark_pda",
            newMintAuthority: "new_mint_authority",
            payer: "payer",
            tokenAccountOwner: "token_account_owner",
            tokenAccount: "token_account",
            newMetadataUpdateAuthority: "new_metadata_update_authority",
            metadata: "metadata",
            edition: "1",
          },
        ],
      ),
  },
  {
    label: "freeze_delegated",
    helper: "mpl_freeze_delegated",
    ir: () =>
      mkIR(
        "freeze",
        [
          { name: "delegate", accountType: "Signer", isSigner: true },
          { name: "token_account", accountType: "UncheckedAccount", isMut: true },
          { name: "edition", accountType: "UncheckedAccount" },
          { name: "mint", accountType: "UncheckedAccount" },
          { name: "token_program", accountType: "Program" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_freeze_delegated",
            delegate: "delegate",
            tokenAccount: "token_account",
            edition: "edition",
            mint: "mint",
            tokenProgram: "token_program",
          },
        ],
      ),
  },
  {
    label: "thaw_delegated",
    helper: "mpl_thaw_delegated",
    ir: () =>
      mkIR(
        "thaw",
        [
          { name: "delegate", accountType: "Signer", isSigner: true },
          { name: "token_account", accountType: "UncheckedAccount", isMut: true },
          { name: "edition", accountType: "UncheckedAccount" },
          { name: "mint", accountType: "UncheckedAccount" },
          { name: "token_program", accountType: "Program" },
          { name: "token_metadata_program", accountType: "Program" },
        ],
        [
          {
            kind: "cpi_mpl_thaw_delegated",
            delegate: "delegate",
            tokenAccount: "token_account",
            edition: "edition",
            mint: "mint",
            tokenProgram: "token_program",
          },
        ],
      ),
  },
];

describe("emitter MPL helper snapshots", () => {
  for (const slot of SLOTS) {
    test(`pinocchio: ${slot.label}`, () => {
      const ir = slot.ir();
      const emit = emitPinocchioFull(ir).singleFile;
      const helper = extractHelper(emit, slot.helper);
      // Helper must be present (regression guard on the extraction logic).
      expect(helper).toContain(`fn ${slot.helper}`);
      compareToSnap(`${slot.label}-pinocchio`, helper);
    });
    test(`native: ${slot.label}`, () => {
      const ir = slot.ir();
      const emit = emitNativeFull(ir).singleFile;
      const helper = extractHelper(emit, slot.helper);
      expect(helper).toContain(`fn ${slot.helper}`);
      compareToSnap(`${slot.label}-native`, helper);
    });
  }
});
