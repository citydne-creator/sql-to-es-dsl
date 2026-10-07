import type { SourcePosition } from "./types.ts";

export interface Node {
  loc: SourcePosition;
}

export interface Identifier extends Node {
  name: string;
}

export interface FieldRef extends Node {
  type: "field";
  name: string;
}

export type LiteralValue = string | number | boolean;

export interface Literal extends Node {
  type: "literal";
  value: LiteralValue;
}

export interface AndExpr extends Node {
  type: "and";
  left: Expr;
  right: Expr;
}

export interface OrExpr extends Node {
  type: "or";
  left: Expr;
  right: Expr;
}

export interface NotExpr extends Node {
  type: "not";
  expr: Expr;
}

export type CompareOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

export interface CompareExpr extends Node {
  type: "compare";
  op: CompareOp;
  field: FieldRef;
  value: Literal;
}

export interface InExpr extends Node {
  type: "in";
  field: FieldRef;
  values: Literal[];
  negated: boolean;
}

export interface BetweenExpr extends Node {
  type: "between";
  field: FieldRef;
  lower: Literal;
  upper: Literal;
  negated: boolean;
}

export interface LikeExpr extends Node {
  type: "like";
  field: FieldRef;
  pattern: string;
  negated: boolean;
}

export interface IsNullExpr extends Node {
  type: "is_null";
  field: FieldRef;
  negated: boolean;
}

export type Expr =
  | AndExpr
  | OrExpr
  | NotExpr
  | CompareExpr
  | InExpr
  | BetweenExpr
  | LikeExpr
  | IsNullExpr;

export type SelectItem =
  | { type: "star"; loc: SourcePosition }
  | { type: "field"; name: string; loc: SourcePosition };

export interface OrderBy extends Node {
  field: FieldRef;
  direction: "asc" | "desc";
}

export interface SelectStatement extends Node {
  type: "select";
  columns: SelectItem[];
  index: Identifier;
  where?: Expr;
  orderBy: OrderBy[];
  limit?: { value: number; loc: SourcePosition };
  offset?: { value: number; loc: SourcePosition };
}
