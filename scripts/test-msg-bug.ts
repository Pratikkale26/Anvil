#!/usr/bin/env bun
// Verify msg!() no longer drops text after a comma-inside-string.
import { emitPinocchioFull } from "../api/src/emitter/pinocchio-emitter.ts";

const ir = {
  name: "hello",
  target: "pinocchio" as const,
  instructions: [
    {
      name: "hello",
      accounts: [],
      args: [],
      rawBody: `{ msg!("Hello, Solana!"); msg!("Our program's Program ID: {}", x); Ok(()) }`,
      body: [
        { kind: "pass_through" as const, code: `msg!("Hello, Solana!");` },
        {
          kind: "pass_through" as const,
          code: `msg!("Our program's Program ID: {}", x);`,
        },
        { kind: "ok_return" as const },
      ],
    },
  ],
  accounts: [],
  constants: [],
  errors: [],
  types: [],
  helperFns: [],
  metadata: {},
};

const out = emitPinocchioFull(ir as any);
const single = out.singleFile;
const start = single.indexOf("fn hello(");
const snippet = single.slice(start, start + 700);
console.log(snippet);

// Self-check: string with comma must survive
if (!snippet.includes(`sol_log("Hello, Solana!")`)) {
  console.error("\nFAIL: \"Hello, Solana!\" was truncated at the comma.");
  process.exit(1);
}
console.log("\nPASS: comma-containing msg!() preserved.");
