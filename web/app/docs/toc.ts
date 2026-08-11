// Shared table of contents — the sidebar (layout) and the section anchors
// (page) both read from this so ids never drift.
export const TOC = [
  { id: "getting-started", label: "Getting started" },
  { id: "byte-equal", label: "The byte-equal gate" },
  { id: "cli", label: "CLI reference" },
  { id: "targets", label: "Targets & coverage" },
  { id: "audit", label: "Security audit" },
  { id: "api", label: "Public API" },
  { id: "architecture", label: "Architecture" },
  { id: "deep-dives", label: "Deep dives" },
] as const;
