/**
 * PinocchioAstVisitor — entry point for pinocchio-target AST emission.
 *
 * Phase 1: empty subclass. Target-specific divergences (the regex layer
 * post-process passes that fire only on pinocchio — Pubkey associated
 * methods, T22 commentout, solana_program::invoke commentout, etc.)
 * land as overrides here in Phase 2.
 *
 * Named subclass exists today so callers (production emit, future
 * feature-flag wiring) can construct `new PinocchioAstVisitor(walker)`
 * without changing call sites when target-specific behavior is added.
 */
import { AstVisitorBase } from "./visitor-base.js";
export class PinocchioAstVisitor extends AstVisitorBase {}
