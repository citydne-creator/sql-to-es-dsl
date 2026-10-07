import type {
  BetweenExpr,
  CompareExpr,
  Expr,
  InExpr,
  IsNullExpr,
  LikeExpr,
  Literal,
  SelectStatement,
} from "./ast.ts";
import { fail } from "./errors.ts";
import { planLike } from "./like.ts";
import {
  assertLiteralType,
  isDate,
  isNumeric,
  resolveField,
  type ResolvedField,
} from "./mapping.ts";
import { parse } from "./parser.ts";
import type { EsQuery, EsSortClause, MappingInput, TranslateResult } from "./types.ts";

export function compile(sql: string, mapping?: MappingInput): TranslateResult {
  const statement = parse(sql);
  return emit(statement, sql, mapping);
}

function emit(statement: SelectStatement, sql: string, mapping?: MappingInput): TranslateResult {
  for (const column of statement.columns) {
    if (column.type === "field") {
      resolveField(
        { type: "field", name: column.name, loc: column.loc },
        mapping,
        "source",
        sql,
      );
    }
  }

  const result: TranslateResult = {
    index: statement.index.name,
    query: statement.where
      ? compileExpr(statement.where, sql, mapping)
      : { match_all: {} },
  };

  const source = projectSource(statement);
  if (source !== undefined) result._source = source;

  if (statement.orderBy.length > 0) {
    result.sort = statement.orderBy.map((item) => {
      const field = resolveField(item.field, mapping, "sort", sql);
      const clause: EsSortClause = { [field.path]: { order: item.direction } };
      return clause;
    });
  }

  if (statement.offset) result.from = statement.offset.value;
  if (statement.limit) result.size = statement.limit.value;
  return result;
}

function projectSource(statement: SelectStatement): true | string[] | undefined {
  if (statement.columns.length === 1 && statement.columns[0]?.type === "star") {
    return undefined;
  }
  return statement.columns.map((column) => {
    if (column.type === "star") return "*";
    return column.name;
  });
}

function compileExpr(expr: Expr, sql: string, mapping?: MappingInput): EsQuery {
  switch (expr.type) {
    case "and":
      return bool("must", [
        compileExpr(expr.left, sql, mapping),
        compileExpr(expr.right, sql, mapping),
      ]);
    case "or":
      return bool("should", [
        compileExpr(expr.left, sql, mapping),
        compileExpr(expr.right, sql, mapping),
      ]);
    case "not":
      return { bool: { must_not: [compileExpr(expr.expr, sql, mapping)] } };
    case "compare":
      return compileCompare(expr, sql, mapping);
    case "in":
      return compileIn(expr, sql, mapping);
    case "between":
      return compileBetween(expr, sql, mapping);
    case "like":
      return compileLike(expr, sql, mapping);
    case "is_null":
      return compileIsNull(expr, sql, mapping);
  }
}

function compileCompare(expr: CompareExpr, sql: string, mapping?: MappingInput): EsQuery {
  const usage = expr.op === "eq" || expr.op === "neq" ? "exact" : "range";
  const field = resolveField(expr.field, mapping, usage, sql);
  assertLiteralType(field, expr.value.value, expr.value.loc, sql);
  const query = compareQuery(field, expr.op, expr.value.value);
  return expr.op === "neq" ? { bool: { must_not: [query] } } : query;
}

function compareQuery(
  field: ResolvedField,
  op: CompareExpr["op"],
  value: Literal["value"],
): EsQuery {
  if (op === "eq" || op === "neq") {
    return { term: { [field.path]: value } };
  }
  const bound =
    op === "gt" ? "gt" : op === "gte" ? "gte" : op === "lt" ? "lt" : "lte";
  return { range: { [field.path]: { [bound]: value } } };
}

function compileIn(expr: InExpr, sql: string, mapping?: MappingInput): EsQuery {
  const field = resolveField(expr.field, mapping, "exact", sql);
  for (const literal of expr.values) {
    assertLiteralType(field, literal.value, literal.loc, sql);
  }
  const values = expr.values.map((literal) => literal.value);
  const query = { terms: { [field.path]: values } };
  return expr.negated ? { bool: { must_not: [query] } } : query;
}

function compileBetween(expr: BetweenExpr, sql: string, mapping?: MappingInput): EsQuery {
  const field = resolveField(expr.field, mapping, "range", sql);
  assertLiteralType(field, expr.lower.value, expr.lower.loc, sql);
  assertLiteralType(field, expr.upper.value, expr.upper.loc, sql);
  const query = {
    range: { [field.path]: { gte: expr.lower.value, lte: expr.upper.value } },
  };
  return expr.negated ? { bool: { must_not: [query] } } : query;
}

function compileLike(expr: LikeExpr, sql: string, mapping?: MappingInput): EsQuery {
  const field = resolveField(expr.field, mapping, "like", sql);
  if (
    field.type !== "unmapped" &&
    (isNumeric(field.type) || field.type === "boolean" || isDate(field.type))
  ) {
    fail(
      "semantic",
      `LIKE is not supported on ${field.type} field '${field.requested}'`,
      expr.loc,
      sql,
    );
  }
  const plan = planLike(expr.pattern, expr.loc, sql);
  const query =
    plan.kind === "term"
      ? { term: { [field.path]: plan.value } }
      : plan.kind === "prefix"
        ? { prefix: { [field.path]: { value: plan.value } } }
        : { wildcard: { [field.path]: { value: plan.value } } };
  return expr.negated ? { bool: { must_not: [query] } } : query;
}

function compileIsNull(expr: IsNullExpr, sql: string, mapping?: MappingInput): EsQuery {
  const field = resolveField(expr.field, mapping, "exists", sql);
  const exists = { exists: { field: field.path } };
  return expr.negated ? exists : { bool: { must_not: [exists] } };
}

function bool(kind: "must" | "should", clauses: EsQuery[]): EsQuery {
  const flattened: EsQuery[] = [];
  for (const clause of clauses) {
    const inner = unwrapBool(clause, kind);
    if (inner) flattened.push(...inner);
    else flattened.push(clause);
  }
  if (kind === "should") {
    return { bool: { should: flattened, minimum_should_match: 1 } };
  }
  return { bool: { must: flattened } };
}

function unwrapBool(query: EsQuery, kind: "must" | "should"): EsQuery[] | undefined {
  const boolQuery = query.bool;
  if (!boolQuery || typeof boolQuery !== "object") return undefined;
  const body = boolQuery as Record<string, unknown>;
  const keys = Object.keys(body);
  if (kind === "must" && keys.length === 1 && Array.isArray(body.must)) {
    return body.must as EsQuery[];
  }
  if (
    kind === "should" &&
    keys.length === 2 &&
    Array.isArray(body.should) &&
    body.minimum_should_match === 1
  ) {
    return body.should as EsQuery[];
  }
  return undefined;
}
