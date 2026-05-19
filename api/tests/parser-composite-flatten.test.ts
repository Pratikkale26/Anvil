/**
 * H1 Layer 1 — composite Accounts flatten in parseAccountsStructFields.
 *
 * When a #[derive(Accounts)] struct has a field whose type is itself
 * another Accounts struct, Anchor's macro flattens at IDL generation:
 * the inner struct's fields become account slots in the outer struct's
 * account list, in declaration order. Pre-H1 Anvil emitted the composite
 * field as a single AccountInfo binding and surfaced the loud
 * `composite_accounts_field` warning so the validator refused emit.
 *
 * Post-H1 Layer 1: with `flattenComposites: true` + an accountsStructRegistry,
 * parseAccountsStructFields:
 * - drops the composite parent field from the outer accounts list
 * - splices the inner struct's accounts at the parent's position
 * - renames inner fields to `<outer>_<inner>` to avoid collisions
 * - populates compositeFieldPathMap with `outer.inner` dotted source paths
 *   → flat names, so body-classifier can rewrite `ctx.accounts.outer.inner`
 *   to `ctx.accounts.outer_inner`
 * - throws CompositeAccountsCycleError on transitive self-containment
 *
 * Layer 2 (body classifier rewrite) + Layer 3 (emitter slot binding) land
 * in follow-up commits; the flag stays opt-in until all 3 layers are
 * proven end-to-end via the byte-equal differential fixture.
 */
import { describe, test, expect } from "bun:test";
import {
  parseAccountsStructFields,
  CompositeAccountsCycleError,
  type AccountsStructRegistry,
} from "../src/parser/account-parser.ts";
import { getParser } from "../src/parser/ts-init.ts";

async function parseRust(source: string) {
  const parser = await getParser();
  return parser.parse(source)!;
}

function structNode(tree: ReturnType<typeof parseRust> extends Promise<infer T> ? T : never, name: string) {
  const root = tree.rootNode;
  function find(node: typeof root): typeof root | null {
    if (node.type === "struct_item" && node.childForFieldName("name")?.text === name) {
      return node;
    }
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  }
  const node = find(root);
  if (!node) throw new Error(`struct ${name} not found`);
  return node;
}

describe("H1 Layer 1 — composite Accounts flatten", () => {
  test("opts.flattenComposites = false (default): composite field stays as single slot", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[derive(Accounts)]
      pub struct Inner<'info> {
          pub a: Signer<'info>,
          pub b: Signer<'info>,
      }

      #[derive(Accounts)]
      pub struct Outer<'info> {
          pub user: Signer<'info>,
          pub nested: Inner<'info>,
      }
    `;
    const tree = await parseRust(source);
    const outerNode = structNode(tree, "Outer");
    const accounts = parseAccountsStructFields(outerNode, [], {
      accountsStructNames: new Set(["Inner", "Outer"]),
      // No registry, no flatten flag → pre-H1 behavior
    });
    expect(accounts.length).toBe(2);
    expect(accounts.map((a) => a.name)).toEqual(["user", "nested"]);
  });

  test("flattenComposites = true: composite field is replaced by inner accounts with prefixed names", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[derive(Accounts)]
      pub struct Inner<'info> {
          pub a: Signer<'info>,
          pub b: Signer<'info>,
      }

      #[derive(Accounts)]
      pub struct Outer<'info> {
          pub user: Signer<'info>,
          pub nested: Inner<'info>,
          pub trailing: Signer<'info>,
      }
    `;
    const tree = await parseRust(source);
    const outerNode = structNode(tree, "Outer");
    const innerNode = structNode(tree, "Inner");

    const registry: AccountsStructRegistry = new Map([
      ["Outer", { node: outerNode, attrs: [] }],
      ["Inner", { node: innerNode, attrs: [] }],
    ]);
    const compositeFieldPathMap = new Map<string, string>();

    const accounts = parseAccountsStructFields(outerNode, [], {
      accountsStructNames: new Set(["Inner", "Outer"]),
      accountsStructRegistry: registry,
      flattenComposites: true,
      compositeFieldPathMap,
    });

    expect(accounts.map((a) => a.name)).toEqual([
      "user",
      "nested_a",
      "nested_b",
      "trailing",
    ]);
    expect(compositeFieldPathMap.get("nested.a")).toBe("nested_a");
    expect(compositeFieldPathMap.get("nested.b")).toBe("nested_b");
  });

  test("multi-level nesting: outer.middle.inner flattens to outer_middle_inner", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[derive(Accounts)]
      pub struct Leaf<'info> {
          pub x: Signer<'info>,
      }

      #[derive(Accounts)]
      pub struct Middle<'info> {
          pub leaf: Leaf<'info>,
          pub y: Signer<'info>,
      }

      #[derive(Accounts)]
      pub struct Outer<'info> {
          pub middle: Middle<'info>,
          pub z: Signer<'info>,
      }
    `;
    const tree = await parseRust(source);
    const registry: AccountsStructRegistry = new Map([
      ["Outer", { node: structNode(tree, "Outer"), attrs: [] }],
      ["Middle", { node: structNode(tree, "Middle"), attrs: [] }],
      ["Leaf", { node: structNode(tree, "Leaf"), attrs: [] }],
    ]);
    const compositeFieldPathMap = new Map<string, string>();

    const accounts = parseAccountsStructFields(
      structNode(tree, "Outer"),
      [],
      {
        accountsStructNames: new Set(["Outer", "Middle", "Leaf"]),
        accountsStructRegistry: registry,
        flattenComposites: true,
        compositeFieldPathMap,
      },
    );

    expect(accounts.map((a) => a.name)).toEqual([
      "middle_leaf_x",
      "middle_y",
      "z",
    ]);
    expect(compositeFieldPathMap.get("middle.leaf.x")).toBe("middle_leaf_x");
    expect(compositeFieldPathMap.get("middle.y")).toBe("middle_y");
  });

  test("direct self-reference (struct A contains A): cycle detected, throws", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[derive(Accounts)]
      pub struct Loop<'info> {
          pub child: Loop<'info>,
      }
    `;
    const tree = await parseRust(source);
    const node = structNode(tree, "Loop");
    const registry: AccountsStructRegistry = new Map([
      ["Loop", { node, attrs: [] }],
    ]);

    expect(() =>
      parseAccountsStructFields(node, [], {
        accountsStructNames: new Set(["Loop"]),
        accountsStructRegistry: registry,
        flattenComposites: true,
      }),
    ).toThrow(CompositeAccountsCycleError);
  });

  test("indirect cycle (A → B → A): cycle detected, throws", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[derive(Accounts)]
      pub struct A<'info> {
          pub b: B<'info>,
      }

      #[derive(Accounts)]
      pub struct B<'info> {
          pub a: A<'info>,
      }
    `;
    const tree = await parseRust(source);
    const registry: AccountsStructRegistry = new Map([
      ["A", { node: structNode(tree, "A"), attrs: [] }],
      ["B", { node: structNode(tree, "B"), attrs: [] }],
    ]);

    expect(() =>
      parseAccountsStructFields(structNode(tree, "A"), [], {
        accountsStructNames: new Set(["A", "B"]),
        accountsStructRegistry: registry,
        flattenComposites: true,
      }),
    ).toThrow(CompositeAccountsCycleError);
  });

  test("flatten preserves inner constraints (init, seeds, etc.)", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[derive(Accounts)]
      pub struct InnerInit<'info> {
          #[account(init, payer = signer, space = 8 + 32, seeds = [b"inner"], bump)]
          pub child: Signer<'info>,
      }

      #[derive(Accounts)]
      pub struct OuterInit<'info> {
          pub signer: Signer<'info>,
          pub inner: InnerInit<'info>,
      }
    `;
    const tree = await parseRust(source);
    const registry: AccountsStructRegistry = new Map([
      ["OuterInit", { node: structNode(tree, "OuterInit"), attrs: [] }],
      ["InnerInit", { node: structNode(tree, "InnerInit"), attrs: [] }],
    ]);

    const accounts = parseAccountsStructFields(
      structNode(tree, "OuterInit"),
      [],
      {
        accountsStructNames: new Set(["OuterInit", "InnerInit"]),
        accountsStructRegistry: registry,
        flattenComposites: true,
      },
    );

    const inner = accounts.find((a) => a.name === "inner_child");
    expect(inner).toBeDefined();
    expect(inner!.isInit).toBe(true);
    expect(inner!.isPda).toBe(true);
    expect(inner!.constraints.some((c) => c.kind === "init")).toBe(true);
    expect(inner!.constraints.some((c) => c.kind === "seeds")).toBe(true);
  });

  test("non-composite types are not flattened", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[account]
      pub struct State {
          pub data: u64,
      }

      #[derive(Accounts)]
      pub struct Outer<'info> {
          pub signer: Signer<'info>,
          pub state: Account<'info, State>,
      }
    `;
    const tree = await parseRust(source);
    const registry: AccountsStructRegistry = new Map([
      ["Outer", { node: structNode(tree, "Outer"), attrs: [] }],
      // Note: State is NOT in the registry — it's an #[account], not an Accounts struct.
    ]);

    const accounts = parseAccountsStructFields(
      structNode(tree, "Outer"),
      [],
      {
        accountsStructNames: new Set(["Outer"]),
        accountsStructRegistry: registry,
        flattenComposites: true,
      },
    );
    expect(accounts.map((a) => a.name)).toEqual(["signer", "state"]);
  });

  test("composite_accounts_field warning suppressed when flatten succeeds", async () => {
    const source = `
      use anchor_lang::prelude::*;

      #[derive(Accounts)]
      pub struct Inner<'info> { pub a: Signer<'info>, }

      #[derive(Accounts)]
      pub struct Outer<'info> {
          pub nested: Inner<'info>,
      }
    `;
    const tree = await parseRust(source);
    const registry: AccountsStructRegistry = new Map([
      ["Outer", { node: structNode(tree, "Outer"), attrs: [] }],
      ["Inner", { node: structNode(tree, "Inner"), attrs: [] }],
    ]);
    const collector = {
      _warnings: [] as Array<{ code: string }>,
      add(input: { code: string }) {
        this._warnings.push(input);
      },
      drain() { return this._warnings.slice(); },
      forInstruction() { return this; },
    } as never as Parameters<typeof parseAccountsStructFields>[2] extends infer T
      ? T extends { collector?: infer C } ? NonNullable<C> : never
      : never;

    parseAccountsStructFields(structNode(tree, "Outer"), [], {
      accountsStructNames: new Set(["Outer", "Inner"]),
      accountsStructRegistry: registry,
      flattenComposites: true,
      collector,
    });
    const composite = (collector as unknown as { _warnings: Array<{ code: string }> })._warnings.filter(
      (w) => w.code === "composite_accounts_field",
    );
    expect(composite.length).toBe(0);
  });
});
