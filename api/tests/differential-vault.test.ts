/**
 * Vault differential — second fixture, distinct surface from counter.
 *
 * Exercises that counter doesn't:
 *   - PDA-as-vault holding raw lamports (UncheckedAccount, system-owned)
 *   - system_program::transfer CPI (authority → vault, then vault → authority)
 *   - Signer-seeded CPI on withdraw (the PDA "signs" via seeds + bump)
 *   - Cached vault_bump persisted in vault_state
 *
 * If Anvil's emit gets ANY of these wrong, byte-equality on the
 * vault_state PDA + lamport-equality on the vault PDA will catch it.
 * Both anchor and anvil scenarios use the same authority Keypair so PDAs
 * and bumps derive identically.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transaction, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  defineDifferential,
  anchorIxDiscriminator,
  encodeU64LE,
  concatBytes,
  Keypair,
  PublicKey,
  LiteSVM,
} from "./differential-harness.ts";

const VAULT_SRC = join(import.meta.dir, "..", "src", "demo-programs", "vault.rs");
// Different program ID than counter so the on-chain owner check passes
// when the same litesvm process loads multiple test fixtures in series.
const PROGRAM_ID = "Vau1t11111111111111111111111111111111111111";

defineDifferential({
  fixtureName: "vault",
  programIdBase58: PROGRAM_ID,
  anchorSource: readFileSync(VAULT_SRC, "utf-8"),
  anchorPackageName: "vault_anchor_diff",

  setup: async () => {
    const authority = Keypair.generate();
    const programId = new PublicKey(PROGRAM_ID);
    const [vaultState] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_state"), authority.publicKey.toBuffer()],
      programId,
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), authority.publicKey.toBuffer()],
      programId,
    );
    return { authority, vaultState, vaultPda };
  },

  callScript: async (svm: LiteSVM, ctx, programId: PublicKey) => {
    // 2 SOL — enough to cover rent-exempt for vault_state + the deposit
    // amount + transaction fees. Picking a round number > minimum lets us
    // tolerate small rent-calc differences without false negatives.
    svm.airdrop(ctx.authority.publicKey, BigInt(2_000_000_000));

    const initIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vaultState, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(anchorIxDiscriminator("initialize")),
    });

    const depositIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vaultState, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("deposit"), encodeU64LE(100_000_000n))),
    });

    const withdrawIx = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: ctx.vaultState, isSigner: false, isWritable: true },
        { pubkey: ctx.vaultPda, isSigner: false, isWritable: true },
        { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(concatBytes(anchorIxDiscriminator("withdraw"), encodeU64LE(40_000_000n))),
    });

    for (const ix of [initIx, depositIx, withdrawIx]) {
      const tx = new Transaction().add(ix);
      tx.recentBlockhash = svm.latestBlockhash();
      tx.feePayer = ctx.authority.publicKey;
      tx.sign(ctx.authority);
      const r = svm.sendTransaction(tx);
      if ("err" in r) throw new Error(`vault tx failed: ${JSON.stringify(r.err)}`);
    }
  },

  accountsToCompare: (ctx) => [
    // vault_state — the program's state account; data + lamport equality
    // catches both layout drift and rent-allocation drift.
    { pubkey: ctx.vaultState, label: "vault_state" },
    // vault — system-owned PDA holding the residual SOL after deposit/
    // withdraw. Data is empty; lamport equality is the assertion that
    // counts. If Anvil's signer-seeded transfer is wrong, this diverges.
    { pubkey: ctx.vaultPda, label: "vault_pda" },
  ],
});
