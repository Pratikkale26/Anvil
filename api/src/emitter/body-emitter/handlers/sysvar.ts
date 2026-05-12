import type { BodyStatement } from "../../../ir/schema.js";
import type { BodyWalker } from "../walker.js";

type SysvarClock = Extract<BodyStatement, { kind: "sysvar_clock" }>;
type SysvarRent = Extract<BodyStatement, { kind: "sysvar_rent" }>;

export function handleSysvarClock(w: BodyWalker, stmt: SysvarClock): void {
  w.ctx.transformedCount++;
  w.lines.push(w.emitter.emitClockGet(stmt.localVar, stmt.field));
}

export function handleSysvarRent(w: BodyWalker, stmt: SysvarRent): void {
  w.ctx.transformedCount++;
  w.lines.push(w.emitter.emitRentGet(stmt.localVar, stmt.field));
}
