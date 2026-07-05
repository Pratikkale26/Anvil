/**
 * Shared scratch root for tests that build cargo projects or clone
 * reference repos. Hardcoded "/tmp" filled the 3.7G tmpfs on a full
 * corpus run (2026-07-05: 2.8G of repo clones + ~192MB per caller
 * project → 406 ENOSPC-driven failures, zero real divergences).
 * os.tmpdir() honors $TMPDIR, so pointing TMPDIR at a big disk now
 * actually redirects ALL test scratch; ANVIL_TEST_SCRATCH overrides
 * both when you want test scratch separated from generic tmp.
 */
import { tmpdir } from "node:os";

export const TEST_SCRATCH: string = process.env.ANVIL_TEST_SCRATCH ?? tmpdir();
