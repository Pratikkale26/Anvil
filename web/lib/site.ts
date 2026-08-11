// Single source of truth for brand facts + external links.
// Referenced by the landing page, docs, footer, and metadata so a version
// or URL only ever changes in one place.

export const SITE = {
  name: "Anvil",
  tagline: "Anchor → Pinocchio, proven.",
  description:
    "Compile Anchor programs to Pinocchio or Native Rust, then prove the port is deploy-safe with a byte-equal differential gate that runs both inside a real VM.",
  version: "0.9.0",

  url: "https://anvilsol.xyz",
  npm: "anvil-sol",
  npmUrl: "https://www.npmjs.com/package/anvil-sol",
  install: "npm install -g anvil-sol",
  github: "https://github.com/Pratikkale26/Anvil",
  api: "https://anvil-app-nrjdl.ondigitalocean.app",
  x: "https://x.com/pratikkale26",
  xHandle: "@pratikkale26",
} as const;

// Nav / footer link sets — kept here so both share one definition.
export const NAV_LINKS = [
  { href: "/#proof", label: "Proof" },
  { href: "/#how", label: "How it works" },
  { href: "/#verified", label: "Verified" },
  { href: "/docs", label: "Docs" },
] as const;
