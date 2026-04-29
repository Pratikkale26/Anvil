/**
 * Workbench state persistence — localStorage with versioned schema.
 *
 * Preserves the user's current input across page refreshes so a stray
 * F5 or accidental tab-close doesn't lose work. Output is intentionally
 * NOT persisted — re-emit is fast and stale output would confuse the
 * "what's currently in the workbench" mental model.
 *
 * Versioned key: bumping STORAGE_VERSION invalidates older stored state
 * automatically, so a future schema change can't crash the page on load.
 */
import type { InputMode, Target } from "./constants";

const STORAGE_KEY = "anvil:workbench:v1";

export interface PersistedWorkbench {
  mode: InputMode;
  target: Target;
  demoName: string;
  sourceText: string;
  repoUrl: string;
  repoRef: string;
  repoSubpath: string;
  folderCandidate: string;
}

export function loadWorkbenchState(): Partial<PersistedWorkbench> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    // Shape-check each field so a corrupt entry can't crash hydration.
    const p = parsed as Record<string, unknown>;
    const out: Partial<PersistedWorkbench> = {};
    if (isInputMode(p.mode)) out.mode = p.mode;
    // Drop stored experimental targets at hydration so a previous selection
    // of (now-disabled) quasar doesn't leave the workbench stuck on a
    // target the user can no longer toggle off via the disabled button.
    if (isTarget(p.target) && p.target !== "quasar") out.target = p.target;
    if (typeof p.demoName === "string") out.demoName = p.demoName;
    if (typeof p.sourceText === "string") out.sourceText = p.sourceText;
    if (typeof p.repoUrl === "string") out.repoUrl = p.repoUrl;
    if (typeof p.repoRef === "string") out.repoRef = p.repoRef;
    if (typeof p.repoSubpath === "string") out.repoSubpath = p.repoSubpath;
    if (typeof p.folderCandidate === "string") out.folderCandidate = p.folderCandidate;
    return out;
  } catch {
    return null;
  }
}

export function saveWorkbenchState(state: PersistedWorkbench): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded / private mode / disabled storage — silent skip is
    // correct here, persistence is a nice-to-have, not load-bearing.
  }
}

export function clearWorkbenchState(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function isInputMode(v: unknown): v is InputMode {
  return v === "demo" || v === "source" || v === "file" || v === "folder" || v === "repo";
}
function isTarget(v: unknown): v is Target {
  return v === "pinocchio" || v === "native" || v === "quasar";
}
