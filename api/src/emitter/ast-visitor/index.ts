/**
 * AST visitor public surface — used by tests today and by the production
 * emit path in Phase 3 (when the feature flag flips).
 */
export {
  type RustStmt,
  type RustExpr,
  ident,
  lit,
  field,
  methodCall,
  call,
  ref,
  deref,
  tryPostfix,
  path,
  rawExpr,
  letStmt,
  assign,
  exprStmt,
  rawLine,
} from "./nodes.js";
export { printStmts, printStmt, printStmtAt, printExpr, countRawNodes } from "./printer.js";
export { AstVisitorBase, VISITOR_SUPPORTED_KINDS } from "./visitor-base.js";
export { PinocchioAstVisitor } from "./pinocchio-visitor.js";
export { NativeAstVisitor } from "./native-visitor.js";
