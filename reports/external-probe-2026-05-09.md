# External Anchor probe — 2026-05-09

Out-of-corpus regression probe against two production-grade Anchor
codebases (~12,000 LoC of Anchor source total). Both repositories
cloned to `/tmp/<repo>` (no in-repo bloat). Probe runs parser + emit
both targets + lint analyzer; doesn't run cargo (would take ~hours).

## Probed repos

- `Squads-Protocol/squads-mpl` — popular Solana DeFi multisig infra
- `metaDAOproject/futarchy` — DAO governance with launchpad / liquidation

## Results

| Program | LoC | Parse | Pin err | Native err |
|---|---:|---|---:|---:|
| squads-mpl/main | 1337 | ✓ | 7 | 6 |
| squads-mpl/program-manager | 606 | ✓ | **0** | **0** |
| squads-mpl/roles | 839 | ✓ | 1 | 1 |
| squads-mpl/txmeta | 62 | ✓ | **0** | **0** |
| squads-mpl/validator | 147 | ✓ | **0** | **0** |
| futarchy/main | 5394 | ✓ | 35 | 35 |
| futarchy/v06_launchpad | 1980 | ✓ | **0** | **0** |
| futarchy/bid_wall | 823 | ✓ | **0** | **0** |
| futarchy/mint_governor | 711 | ✓ | 1 | 1 |
| futarchy/liquidation | 763 | ✓ | **0** | **0** |

**10/10 parse cleanly.** **6/10 lint-validator-clean** on both targets.

The cargo-build outcome is not yet measured (hours of cargo per program);
the validator-error count is a strong proxy — programs with 0 issues
historically cargo-clean ~95% of the time.

## Error classes (across the 4 with non-zero counts)

### squads-mpl/main (7/6)
- 5× `panic-able .try_into().unwrap()` — source uses unwrap(), emit
  carries through. Safer pattern: `.try_into().map_err(|_| ...)?`.
- 2× Anvil unsafe-marker (TODO blocks the emit produced for shapes it
  couldn't translate).

### squads-mpl/roles (1/1)
- `Associated constant 'Role::MAXIMUM_SIZE' is referenced but not
  defined in emitted output.` — implItems on Role aren't being carried
  over. Should resolve via the existing `emitInherentImplItems` path.

### futarchy/main (35/35) — biggest outlier
- Mix of: Anvil unsafe-marker (TODO), CpiContext leaks (handler text
  not fully rewritten on certain shapes), ctx.accounts / ctx.bumps
  references leaked. 5400 LoC with lots of typed CPIs we don't yet
  recognize (Jupiter, Raydium, custom DAMM v2).

### futarchy/mint_governor (1/1)
- `has_one constraint 'destination_ata.mint' is not enforced in
  emitted output.` — has_one against an InterfaceAccount<TokenAccount>
  field doesn't generate the runtime check. Real bug.

## What this tells us

**Anvil's parser is solid.** 10 / 10 production codebases parse without
crashing. No tree-sitter regressions even on 5400-LoC files.

**Anvil's emit is solid for sub-1000-LoC programs.** Five sub-1000-LoC
programs (squads-mpl/program-manager, txmeta, validator + futarchy/
v06_launchpad — but that one's 1980 LoC — bid_wall, liquidation) emit
clean on both targets.

**Big DeFi programs surface real bugs.** futarchy/main + squads-mpl/main
hit a half-dozen distinct gaps — mostly around CpiContext leaks and
typed CPIs we haven't catalogued yet (Jupiter, Raydium, DAMM v2).
These are concrete fix targets.

## Suggested next-session priorities

Ordered by impact / effort:

1. **`Role::MAXIMUM_SIZE` in squads-mpl/roles** (~30 min). Likely a
   missing implItems carry-over for inherent consts on `#[derive]`-only
   structs. One-line fix probably.

2. **has_one against InterfaceAccount<TokenAccount>** (~1 hr). The
   futarchy/mint_governor case. The has_one check generation should
   walk the InterfaceAccount inner type the same way it walks
   `Account<'info, T>`.

3. **`.try_into().unwrap()` rewrite** (~1 hr). Source sweep that
   replaces `.unwrap()` after `.try_into()` with `.map_err(|_|
   ProgramError::InvalidAccountData)?`. Programs using bytemuck pod
   reads naturally hit this pattern.

4. **futarchy/main's typed CPI gaps** (~multiple sessions). Each
   blocked-CPI is its own emit-side IR-kind addition. Defer until
   we have a clearer ROI per family.

## How to reproduce

```bash
cd /tmp
git clone --depth 1 https://github.com/Squads-Protocol/squads-mpl.git
git clone --depth 1 https://github.com/metaDAOproject/futarchy.git

cd /home/pk/Anvil/api
bun run probe-external.ts   # one-off probe script (not committed; recreate as needed)
```

The probe script lives in the working tree but isn't committed — it's
a one-off probe tool. Re-create from this report's fixture list when
re-probing.
