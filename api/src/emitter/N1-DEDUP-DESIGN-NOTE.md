# N1: De-dup three target emitters — design note

## Why this is deferred (not just a tech-debt punt)

`pinocchio-emitter.ts` (1974 LoC), `native-emitter.ts` (1318 LoC), and
`quasar-emitter.ts` (1248 LoC) share ~30% structural logic (per the
2026-05-04 architecture review): per-instruction shape, PDA seed
construction, system / SPL / memo CPI emit, helper-fn carry-over,
account binding prelude.

But the duplication is **target-specific in surface** even when
structural in skeleton:

- Logging: `solana_program::msg!` (native) vs `pinocchio::log::sol_log` (pinocchio) vs `msg!` (quasar via prelude)
- CPI invocation: `solana_program::program::invoke` (native) vs `pinocchio_system::instructions::Transfer{...}.invoke()` (pinocchio) vs Anchor-style sugar (quasar)
- Account access: `&accounts[N]` (native + pinocchio) vs `ctx.accounts.X` (quasar)
- Error type: `ProgramError` (native + pinocchio) vs `ErrorCode` (quasar)
- Owner check: `account.owner != program_id` (native) vs `account.owner() != program_id` (pinocchio — method!) vs `account.owner == program_id` (quasar)

A "shared helper" that takes a target enum and switches on it inside
gets you the worst of both worlds: harder to read AND harder to change
than the current "duplicated but locally-clear" shape.

## Right-shape refactor (when it's worth doing)

Build a **target vocabulary** abstraction:

```ts
interface TargetVocab {
  logFn(msg: string): string;                  // sol_log | msg!
  ownerCheck(acc: string, programId: string): string;
  invokeSystemTransfer(from, to, amount, signers?): string;
  invokeSplToken(op: SplOp, ...): string;
  // ...
}
```

Each target ships a `TargetVocab` impl; `BaseEmitter` calls into it.
The current per-target emitter classes shrink to vocab-instantiation +
target-specific overrides for shapes that don't fit the vocab.

## What this unlocks

1. **4th target** (e.g. SBF-cli, Solana-Kit) becomes "implement TargetVocab."
2. **CU-optimization** can be applied across all three emitters via a
   single vocab tweak.
3. **Test surface** drops: each behaviour gets one vocab test, not three
   per-emitter integration tests.

## Estimated effort

~1-2 weeks of careful refactoring with the full differential corpus
gating each step. Premature without a 4th target requirement.

## Triggers for "do this now"

- A 4th emit target is requested (Solana-Kit migration is likely candidate per task #34).
- A bug fix needed in 3+ emitters in one session (signal the duplication is now active maintenance burden, not dormant).
- Adding a new IR kind requires touching all three emitters identically (signal the dispatch shape needs the vocab abstraction).

Until then: do small, surgical extractions when a specific helper is
provably duplicated across all three (e.g. seed-shape predicates), not
big rewrites.
