/**
 * NativeAstVisitor — entry point for native-target AST emission.
 *
 * Phase 1: empty subclass. Target-specific divergences (auto-import of
 * spl_token_2022 ext types, AccountMeta/Instruction auto-import, etc.)
 * land as overrides here in Phase 2.
 *
 * Sibling of PinocchioAstVisitor — see that file for the subclass-shape
 * rationale. Two separate classes keep target-specific overrides
 * structurally separated.
 */
import { AstVisitorBase } from "./visitor-base.js";
export class NativeAstVisitor extends AstVisitorBase {}
