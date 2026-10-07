import type {
  BetweenExpr,
  CompareOp,
  Expr,
  FieldRef,
  Identifier,
  InExpr,
  IsNullExpr,
  LikeExpr,
  Literal,
  OrderBy,
  SelectItem,
  SelectStatement,
} from "./ast.ts";
import { fail } from "./errors.ts";
import { type Token, type TokenKind, tokenize } from "./lexer.ts";
import type { SourcePosition } from "./types.ts";

const COMPARE_OPS: Partial<Record<TokenKind, CompareOp>> = {
  eq: "eq",
  neq: "neq",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
};

const MUTATING = new Set<TokenKind>(["update", "delete", "insert", "create", "drop", "alter"]);

const JOIN_KINDS = new Set<TokenKind>([
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "outer",
]);

export function parse(sql: string): SelectStatement {
  return new Parser(sql).parse();
}

class Parser {
  private readonly sql: string;
  private readonly tokens: Token[];
  private index = 0;

  constructor(sql: string) {
    this.sql = sql;
    this.tokens = tokenize(sql);
  }

  parse(): SelectStatement {
    const first = this.peek();
    if (MUTATING.has(first.kind)) {
      fail(
        "unsupported",
        `${first.lexeme.toUpperCase()} statements are not supported; only SELECT is accepted`,
        first.start,
        this.sql,
      );
    }
    if (first.kind === "with") {
      fail(
        "unsupported",
        "WITH / common table expressions are not supported",
        first.start,
        this.sql,
      );
    }
    this.expect("select", "Expected SELECT");
    if (this.peek().kind === "distinct") {
      fail("unsupported", "SELECT DISTINCT is not supported", this.peek().start, this.sql);
    }

    const loc = first.start;
    const columns = this.parseSelectList();
    this.expect("from", "Expected FROM after the select list");
    const index = this.parseIndex();
    this.rejectMultipleIndexes();

    let where: Expr | undefined;
    if (this.match("where")) {
      where = this.parseOr();
    }

    this.rejectClause("group", "GROUP BY is not supported");
    this.rejectClause("having", "HAVING is not supported");
    this.rejectClause("union", "UNION is not supported");

    const orderBy: OrderBy[] = [];
    if (this.match("order")) {
      this.expect("by", "Expected BY after ORDER");
      orderBy.push(this.parseOrderItem());
      while (this.match("comma")) {
        orderBy.push(this.parseOrderItem());
      }
    }

    let limit: SelectStatement["limit"];
    let offset: SelectStatement["offset"];
    for (;;) {
      if (this.peek().kind === "limit") {
        if (limit) {
          fail("syntax", "LIMIT specified more than once", this.peek().start, this.sql);
        }
        this.advance();
        limit = this.parseNonNegativeInt("LIMIT");
        continue;
      }
      if (this.peek().kind === "offset") {
        if (offset) {
          fail("syntax", "OFFSET specified more than once", this.peek().start, this.sql);
        }
        this.advance();
        offset = this.parseNonNegativeInt("OFFSET");
        continue;
      }
      break;
    }

    this.match("semicolon");
    if (this.peek().kind !== "eof") {
      const extra = this.peek();
      fail(
        extra.kind === "select" ? "unsupported" : "syntax",
        extra.kind === "select"
          ? "Multiple statements are not supported"
          : `Unexpected token '${extra.lexeme}'`,
        extra.start,
        this.sql,
      );
    }

    const statement: SelectStatement = {
      type: "select",
      loc,
      columns,
      index,
      orderBy,
    };
    if (where) statement.where = where;
    if (limit) statement.limit = limit;
    if (offset) statement.offset = offset;
    return statement;
  }

  private parseSelectList(): SelectItem[] {
    if (this.peek().kind === "star") {
      const star = this.advance();
      if (this.peek().kind === "comma") {
        fail(
          "syntax",
          "SELECT * must be the only select item in this SQL subset",
          this.peek().start,
          this.sql,
        );
      }
      return [{ type: "star", loc: star.start }];
    }

    const items: SelectItem[] = [this.parseSelectItem()];
    while (this.match("comma")) {
      if (this.peek().kind === "star") {
        fail(
          "syntax",
          "SELECT * must be the only select item in this SQL subset",
          this.peek().start,
          this.sql,
        );
      }
      items.push(this.parseSelectItem());
    }
    return items;
  }

  private parseSelectItem(): SelectItem {
    const field = this.parseFieldRef("Expected a field name in the select list");
    if (this.peek().kind === "lparen") {
      fail(
        "unsupported",
        `Function '${field.name}' is not supported`,
        this.peek().start,
        this.sql,
      );
    }
    if (this.match("as")) {
      fail(
        "unsupported",
        "Column aliases are not supported; SELECT items must be field names",
        this.peek().start,
        this.sql,
      );
    }
    return { type: "field", name: field.name, loc: field.loc };
  }

  private parseIndex(): Identifier {
    const token = this.peek();
    if (token.kind === "ident") {
      this.advance();
      if (this.peek().kind === "dot") {
        fail(
          "unsupported",
          "Qualified names in FROM are not supported; provide a single index name",
          this.peek().start,
          this.sql,
        );
      }
      return { name: identValue(token), loc: token.start };
    }
    if (token.kind === "star") {
      fail("unsupported", "FROM must name exactly one index", token.start, this.sql);
    }
    fail("syntax", "Expected an index name after FROM", token.start, this.sql);
  }

  private rejectMultipleIndexes(): void {
    if (this.peek().kind === "comma") {
      fail(
        "unsupported",
        "Querying multiple indexes is not supported; FROM must name exactly one index",
        this.peek().start,
        this.sql,
      );
    }
    const token = this.peek();
    if (JOIN_KINDS.has(token.kind) || token.kind === "on") {
      fail(
        "unsupported",
        "JOIN is not supported; FROM must name exactly one index",
        token.start,
        this.sql,
      );
    }
  }

  private parseOr(): Expr {
    let expr = this.parseAnd();
    while (this.match("or")) {
      const loc = this.previous().start;
      expr = { type: "or", loc, left: expr, right: this.parseAnd() };
    }
    return expr;
  }

  private parseAnd(): Expr {
    let expr = this.parseNot();
    while (this.match("and")) {
      const loc = this.previous().start;
      expr = { type: "and", loc, left: expr, right: this.parseNot() };
    }
    return expr;
  }

  private parseNot(): Expr {
    if (this.match("not")) {
      const loc = this.previous().start;
      return { type: "not", loc, expr: this.parseNot() };
    }
    return this.parsePredicate();
  }

  private parsePredicate(): Expr {
    if (this.match("lparen")) {
      if (this.peek().kind === "select") {
        fail("unsupported", "Subqueries are not supported", this.peek().start, this.sql);
      }
      const expr = this.parseOr();
      this.expect("rparen", "Expected ')' to close parenthesized expression");
      return expr;
    }
    if (this.peek().kind === "exists") {
      fail("unsupported", "EXISTS subqueries are not supported", this.peek().start, this.sql);
    }
    if (this.peek().kind === "case") {
      fail("unsupported", "CASE expressions are not supported", this.peek().start, this.sql);
    }

    const field = this.parseFieldRef("Expected a field name in the WHERE clause");
    if (this.peek().kind === "lparen") {
      fail(
        "unsupported",
        `Function '${field.name}' is not supported`,
        this.peek().start,
        this.sql,
      );
    }

    if (this.match("not")) {
      if (this.peek().kind === "in") return this.parseIn(field, true);
      if (this.peek().kind === "like") return this.parseLike(field, true);
      if (this.peek().kind === "between") return this.parseBetween(field, true);
      fail(
        "syntax",
        "Expected IN, LIKE, or BETWEEN after NOT",
        this.peek().start,
        this.sql,
      );
    }

    if (this.peek().kind === "in") return this.parseIn(field, false);
    if (this.peek().kind === "like") return this.parseLike(field, false);
    if (this.peek().kind === "between") return this.parseBetween(field, false);
    if (this.match("is")) {
      return this.parseIsNull(field);
    }

    const opKind = this.peek().kind;
    const op = COMPARE_OPS[opKind];
    if (!op) {
      fail(
        "syntax",
        `Expected a comparison operator after field '${field.name}'`,
        this.peek().start,
        this.sql,
      );
    }
    const opToken = this.advance();
    if (this.peek().kind === "null") {
      fail(
        "semantic",
        "NULL comparisons must use IS NULL or IS NOT NULL",
        this.peek().start,
        this.sql,
      );
    }
    const value = this.parseLiteral();
    return { type: "compare", loc: opToken.start, op, field, value };
  }

  private parseIn(field: FieldRef, negated: boolean): InExpr {
    const loc = this.peek().start;
    this.expect("in", "Expected IN");
    this.expect("lparen", "Expected '(' after IN");
    if (this.peek().kind === "select") {
      fail("unsupported", "Subqueries are not supported", this.peek().start, this.sql);
    }
    if (this.peek().kind === "rparen") {
      fail("semantic", "IN lists cannot be empty", this.peek().start, this.sql);
    }
    const values = [this.parseLiteral()];
    while (this.match("comma")) {
      values.push(this.parseLiteral());
    }
    this.expect("rparen", "Expected ')' after IN list");
    return { type: "in", loc, field, values, negated };
  }

  private parseLike(field: FieldRef, negated: boolean): LikeExpr {
    const loc = this.peek().start;
    this.expect("like", "Expected LIKE");
    const patternToken = this.peek();
    if (patternToken.kind !== "string") {
      fail("syntax", "LIKE requires a string pattern", patternToken.start, this.sql);
    }
    this.advance();
    return {
      type: "like",
      loc,
      field,
      pattern: String(patternToken.value ?? ""),
      negated,
    };
  }

  private parseBetween(field: FieldRef, negated: boolean): BetweenExpr {
    const loc = this.peek().start;
    this.expect("between", "Expected BETWEEN");
    const lower = this.parseLiteral();
    this.expect("and", "Expected AND in BETWEEN expression");
    const upper = this.parseLiteral();
    return { type: "between", loc, field, lower, upper, negated };
  }

  private parseIsNull(field: FieldRef): IsNullExpr {
    const loc = this.previous().start;
    let negated = false;
    if (this.match("not")) {
      negated = true;
    }
    this.expect("null", "Expected NULL after IS");
    return { type: "is_null", loc, field, negated };
  }

  private parseOrderItem(): OrderBy {
    const field = this.parseFieldRef("Expected a field name in ORDER BY");
    if (this.peek().kind === "lparen") {
      fail(
        "unsupported",
        `Function '${field.name}' is not supported in ORDER BY`,
        this.peek().start,
        this.sql,
      );
    }
    let direction: "asc" | "desc" = "asc";
    if (this.match("asc")) direction = "asc";
    else if (this.match("desc")) direction = "desc";
    return { loc: field.loc, field, direction };
  }

  private parseFieldRef(message: string): FieldRef {
    const first = this.peek();
    if (first.kind !== "ident") {
      fail("syntax", message, first.start, this.sql);
    }
    this.advance();
    const parts = [identValue(first)];
    while (this.match("dot")) {
      const next = this.peek();
      if (next.kind !== "ident") {
        fail("syntax", "Expected a field name after '.'", next.start, this.sql);
      }
      this.advance();
      parts.push(identValue(next));
    }
    return { type: "field", name: parts.join("."), loc: first.start };
  }

  private parseLiteral(): Literal {
    const token = this.peek();
    if (token.kind === "plus" || token.kind === "minus") {
      const sign = token.kind === "minus" ? -1 : 1;
      this.advance();
      const number = this.peek();
      if (number.kind !== "number") {
        fail("syntax", "Expected a numeric literal", number.start, this.sql);
      }
      this.advance();
      return {
        type: "literal",
        loc: token.start,
        value: sign * Number(number.value),
      };
    }
    if (token.kind === "number") {
      this.advance();
      return { type: "literal", loc: token.start, value: Number(token.value) };
    }
    if (token.kind === "string") {
      this.advance();
      return { type: "literal", loc: token.start, value: String(token.value ?? "") };
    }
    if (token.kind === "true" || token.kind === "false") {
      this.advance();
      return { type: "literal", loc: token.start, value: token.kind === "true" };
    }
    if (token.kind === "ident") {
      fail(
        "semantic",
        "Comparisons require a field and a literal; field-to-field predicates are not supported",
        token.start,
        this.sql,
      );
    }
    if (token.kind === "lparen" && this.lookAhead(1)?.kind === "select") {
      fail("unsupported", "Subqueries are not supported", token.start, this.sql);
    }
    fail("syntax", "Expected a literal value", token.start, this.sql);
  }

  private parseNonNegativeInt(clause: "LIMIT" | "OFFSET"): {
    value: number;
    loc: SourcePosition;
  } {
    const token = this.peek();
    if (token.kind === "minus") {
      fail("semantic", `${clause} must be a non-negative integer`, token.start, this.sql);
    }
    if (token.kind !== "number") {
      fail("syntax", `Expected an integer after ${clause}`, token.start, this.sql);
    }
    this.advance();
    const value = Number(token.value);
    if (!Number.isInteger(value) || value < 0) {
      fail("semantic", `${clause} must be a non-negative integer`, token.start, this.sql);
    }
    return { value, loc: token.start };
  }

  private rejectClause(kind: TokenKind, message: string): void {
    if (this.peek().kind === kind) {
      fail("unsupported", message, this.peek().start, this.sql);
    }
  }

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private lookAhead(distance: number): Token | undefined {
    return this.tokens[this.index + distance];
  }

  private previous(): Token {
    return this.tokens[this.index - 1]!;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== "eof") this.index += 1;
    return token;
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.advance();
      return true;
    }
    return false;
  }

  private expect(kind: TokenKind, message: string): Token {
    if (this.peek().kind === kind) return this.advance();
    fail("syntax", message, this.peek().start, this.sql);
  }
}

function identValue(token: Token): string {
  return typeof token.value === "string" ? token.value : token.lexeme;
}
