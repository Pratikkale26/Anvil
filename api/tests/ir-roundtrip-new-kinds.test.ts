/**
 * N2 — IR roundtrip sweep for IR kinds shipped 2026-05-18.
 *
 * The on-disk roundtrip suite (ir-roundtrip.test.ts) covers demo
 * fixtures + emitter snapshot JSONs but none of them exercise the
 * new kinds. Without this in-memory sweep, a Zod schema regression
 * on any new field (e.g. accidentally non-optional, missing
 * .default(), wrong discriminator literal) silently slips through
 * because the on-disk fixtures don't contain those kinds.
 *
 * Each test constructs a minimal IR carrying ONE of the new kinds,
 * then asserts:
 *   - SolanaIRSchema.parse accepts it
 *   - stringify → parse roundtrip is deep-equal
 *
 * Coverage (11 kinds, 2026-05-18):
 *   cpi_t22_metadata_pointer_update           (E1)
 *   cpi_mpl_update_metadata_accounts_v2       (M1)
 *   cpi_mpl_verify_collection                 (M1b)
 *   cpi_mpl_sign_metadata                     (M1c)
 *   cpi_mpl_unverify_collection               (M1d)
 *   cpi_mpl_set_and_verify_collection         (M1e)
 *   cpi_mpl_approve_collection_authority      (M1f)
 *   cpi_mpl_revoke_collection_authority       (M1g)
 *   cpi_mpl_mint_new_edition_from_master      (M1h)
 *   cpi_mpl_freeze_delegated                  (M1i)
 *   cpi_mpl_thaw_delegated                    (M1j)
 */
import { describe, test, expect } from "bun:test";
import { SolanaIRSchema, type SolanaIR, type BodyStatement } from "../src/ir/schema.ts";

function buildIR(stmt: BodyStatement): SolanaIR {
  return {
    name: "roundtrip_test",
    instructions: [
      {
        name: "ix",
        accounts: [],
        args: [],
        body: [stmt, { kind: "return_ok" }],
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
      parsedAt: "2026-05-18T00:00:00Z",
    },
  };
}

function roundtrip(ir: SolanaIR): SolanaIR {
  return SolanaIRSchema.parse(JSON.parse(JSON.stringify(ir)));
}

const NEW_KIND_FIXTURES: Array<{
  name: string;
  stmt: BodyStatement;
}> = [
  {
    name: "cpi_t22_metadata_pointer_update (E1)",
    stmt: {
      kind: "cpi_t22_metadata_pointer_update",
      mint: "mint",
      tokenProgram: "token_program",
      authority: "authority",
      metadataAddress: "None",
    },
  },
  {
    name: "cpi_mpl_update_metadata_accounts_v2 (M1)",
    stmt: {
      kind: "cpi_mpl_update_metadata_accounts_v2",
      metadata: "metadata",
      updateAuthority: "update_authority",
      newUpdateAuthority: "None",
      newName: "Some(\"name\".to_string())",
      newSymbol: "Some(\"SYM\".to_string())",
      newUri: "Some(\"https://uri\".to_string())",
      newSellerFeeBasisPoints: "500",
      primarySaleHappened: "None",
      isMutable: "None",
    },
  },
  {
    name: "cpi_mpl_verify_collection (M1b)",
    stmt: {
      kind: "cpi_mpl_verify_collection",
      metadata: "metadata",
      collectionAuthority: "collection_authority",
      payer: "payer",
      collectionMint: "collection_mint",
      collection: "collection",
      collectionMasterEdition: "collection_master_edition",
      collectionAuthorityRecord: "None",
    },
  },
  {
    name: "cpi_mpl_sign_metadata (M1c)",
    stmt: {
      kind: "cpi_mpl_sign_metadata",
      metadata: "metadata",
      creator: "creator",
    },
  },
  {
    name: "cpi_mpl_unverify_collection (M1d)",
    stmt: {
      kind: "cpi_mpl_unverify_collection",
      metadata: "metadata",
      collectionAuthority: "collection_authority",
      payer: "payer",
      collectionMint: "collection_mint",
      collection: "collection",
      collectionMasterEdition: "collection_master_edition",
      collectionAuthorityRecord: "None",
    },
  },
  {
    name: "cpi_mpl_set_and_verify_collection (M1e)",
    stmt: {
      kind: "cpi_mpl_set_and_verify_collection",
      metadata: "metadata",
      collectionAuthority: "collection_authority",
      payer: "payer",
      updateAuthority: "update_authority",
      collectionMint: "collection_mint",
      collection: "collection",
      collectionMasterEdition: "collection_master_edition",
      collectionAuthorityRecord: "None",
    },
  },
  {
    name: "cpi_mpl_approve_collection_authority (M1f)",
    stmt: {
      kind: "cpi_mpl_approve_collection_authority",
      collectionAuthorityRecord: "collection_authority_record",
      newCollectionAuthority: "new_collection_authority",
      updateAuthority: "update_authority",
      payer: "payer",
      metadata: "metadata",
      mint: "mint",
    },
  },
  {
    name: "cpi_mpl_revoke_collection_authority (M1g)",
    stmt: {
      kind: "cpi_mpl_revoke_collection_authority",
      collectionAuthorityRecord: "collection_authority_record",
      delegateAuthority: "delegate_authority",
      revokeAuthority: "revoke_authority",
      metadata: "metadata",
      mint: "mint",
    },
  },
  {
    name: "cpi_mpl_mint_new_edition_from_master (M1h)",
    stmt: {
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
      edition: "1u64",
    },
  },
  {
    name: "cpi_mpl_freeze_delegated (M1i)",
    stmt: {
      kind: "cpi_mpl_freeze_delegated",
      delegate: "delegate",
      tokenAccount: "token_account",
      edition: "edition",
      mint: "mint",
    },
  },
  {
    name: "cpi_mpl_thaw_delegated (M1j)",
    stmt: {
      kind: "cpi_mpl_thaw_delegated",
      delegate: "delegate",
      tokenAccount: "token_account",
      edition: "edition",
      mint: "mint",
    },
  },
  {
    name: "cpi_mpl_core_create_v2 (task #48 S1)",
    stmt: {
      kind: "cpi_mpl_core_create_v2",
      programAccount: "mpl_core_program",
      asset: "asset",
      collection: "None",
      authority: "None",
      payer: "payer",
      owner: "None",
      updateAuthority: "None",
      systemProgram: "system_program",
      logWrapper: "None",
      name: "name",
      uri: "uri",
      dataState: "DataState::AccountState",
    },
  },
  {
    name: "cpi_mpl_core_update_v2 (task #48 S2)",
    stmt: {
      kind: "cpi_mpl_core_update_v2",
      programAccount: "mpl_core_program",
      asset: "asset",
      collection: "None",
      payer: "payer",
      authority: "Some(authority)",
      newCollection: "None",
      systemProgram: "system_program",
      logWrapper: "None",
      newName: "Some(new_name)",
      newUri: "Some(new_uri)",
    },
  },
  {
    name: "cpi_mpl_core_transfer_v1 (task #48 S3)",
    stmt: {
      kind: "cpi_mpl_core_transfer_v1",
      programAccount: "mpl_core_program",
      asset: "asset",
      collection: "None",
      payer: "payer",
      authority: "Some(owner)",
      newOwner: "recipient",
      systemProgram: "system_program",
      logWrapper: "None",
    },
  },
  {
    name: "cpi_mpl_core_burn_v1 (task #48 S4)",
    stmt: {
      kind: "cpi_mpl_core_burn_v1",
      programAccount: "mpl_core_program",
      asset: "asset",
      collection: "Some(collection)",
      payer: "payer",
      authority: "Some(owner)",
      systemProgram: "system_program",
      logWrapper: "None",
    },
  },
];

describe("IR roundtrip — new kinds shipped 2026-05-18", () => {
  for (const { name, stmt } of NEW_KIND_FIXTURES) {
    test(`${name}: schema accepts`, () => {
      const ir = buildIR(stmt);
      expect(() => SolanaIRSchema.parse(ir)).not.toThrow();
    });

    test(`${name}: stringify → parse is stable`, () => {
      const ir1 = SolanaIRSchema.parse(buildIR(stmt));
      const ir2 = roundtrip(ir1);
      expect(ir2).toEqual(ir1);
    });

    test(`${name}: kind discriminator survives roundtrip`, () => {
      const ir = SolanaIRSchema.parse(buildIR(stmt));
      const got = ir.instructions[0]?.body[0];
      expect(got?.kind).toBe(stmt.kind);
    });

    test(`${name}: with signerSeeds attached`, () => {
      const stmtWithSeeds = { ...stmt, signerSeeds: "&[&[b\"seed\", &[bump]]]" } as BodyStatement;
      const ir = buildIR(stmtWithSeeds);
      const parsed = SolanaIRSchema.parse(ir);
      const after = roundtrip(parsed);
      expect(after).toEqual(parsed);
      const stmtAfter = after.instructions[0]?.body[0] as { signerSeeds?: string } | undefined;
      expect(stmtAfter?.signerSeeds).toBe("&[&[b\"seed\", &[bump]]]");
    });
  }
});
