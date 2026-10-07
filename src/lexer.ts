import { fail } from "./errors.ts";
import type { SourcePosition } from "./types.ts";

export type TokenKind =
  | "eof"
  | "ident"
  | "number"
  | "string"
  | "star"
  | "dot"
  | "comma"
  | "lparen"
  | "rparen"
  | "semicolon"
  | "plus"
  | "minus"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "select"
  | "from"
  | "where"
  | "and"
  | "or"
  | "not"
  | "order"
  | "by"
  | "asc"
  | "desc"
  | "limit"
  | "offset"
  | "in"
  | "between"
  | "like"
  | "is"
  | "null"
  | "true"
  | "false"
  | "as"
  | "join"
  | "inner"
  | "left"
  | "right"
  | "full"
  | "cross"
  | "outer"
  | "on"
  | "union"
  | "all"
  | "group"
  | "having"
  | "distinct"
  | "update"
  | "delete"
  | "insert"
  | "into"
  | "set"
  | "create"
  | "drop"
  | "alter"
  | "with"
  | "exists"
  | "case"
  | "when"
  | "then"
  | "else"
  | "end";

export interface Token {
  kind: TokenKind;
  lexeme: string;
  start: SourcePosition;
  end: SourcePosition;
  value?: string | number;
}

const KEYWORDS: Record<string, TokenKind> = {
  select: "select",
  from: "from",
  where: "where",
  and: "and",
  or: "or",
  not: "not",
  order: "order",
  by: "by",
  asc: "asc",
  desc: "desc",
  limit: "limit",
  offset: "offset",
  in: "in",
  between: "between",
  like: "like",
  is: "is",
  null: "null",
  true: "true",
  false: "false",
  as: "as",
  join: "join",
  inner: "inner",
  left: "left",
  right: "right",
  full: "full",
  cross: "cross",
  outer: "outer",
  on: "on",
  union: "union",
  all: "all",
  group: "group",
  having: "having",
  distinct: "distinct",
  update: "update",
  delete: "delete",
  insert: "insert",
  into: "into",
  set: "set",
  create: "create",
  drop: "drop",
  alter: "alter",
  with: "with",
  exists: "exists",
  case: "case",
  when: "when",
  then: "then",
  else: "else",
  end: "end",
};

export class Lexer {
  private readonly sql: string;
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(sql: string) {
    this.sql = sql;
  }

  next(): Token {
    this.skipTrivia();
    const start = this.position();
    if (this.offset >= this.sql.length) {
      return { kind: "eof", lexeme: "", start, end: start };
    }

    const ch = this.sql[this.offset]!;
    if (ch === "*" ) return this.single("star", start);
    if (ch === "." ) return this.single("dot", start);
    if (ch === "," ) return this.single("comma", start);
    if (ch === "(" ) return this.single("lparen", start);
    if (ch === ")" ) return this.single("rparen", start);
    if (ch === ";" ) return this.single("semicolon", start);
    if (ch === "+" ) return this.single("plus", start);
    if (ch === "-" ) return this.single("minus", start);
    if (ch === "=" ) return this.single("eq", start);
    if (ch === ">") {
      this.advance();
      if (this.peekChar() === "=") {
        this.advance();
        return this.token("gte", ">=", start);
      }
      return this.token("gt", ">", start);
    }
    if (ch === "<") {
      this.advance();
      if (this.peekChar() === "=") {
        this.advance();
        return this.token("lte", "<=", start);
      }
      if (this.peekChar() === ">") {
        this.advance();
        return this.token("neq", "<>", start);
      }
      return this.token("lt", "<", start);
    }
    if (ch === "!") {
      this.advance();
      if (this.peekChar() === "=") {
        this.advance();
        return this.token("neq", "!=", start);
      }
      fail("syntax", "Unexpected character '!'; did you mean '!='?", start, this.sql);
    }
    if (ch === "'" ) return this.scanString(start);
    if (ch === '"' || ch === "`") return this.scanQuotedIdent(ch, start);
    if (isIdentStart(ch)) return this.scanIdent(start);
    if (isDigit(ch)) return this.scanNumber(start);

    fail("syntax", `Unexpected character ${JSON.stringify(ch)}`, start, this.sql);
  }

  private skipTrivia(): void {
    while (this.offset < this.sql.length) {
      const ch = this.sql[this.offset]!;
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }
      if (ch === "-" && this.sql[this.offset + 1] === "-") {
        this.advance();
        this.advance();
        while (this.offset < this.sql.length && this.sql[this.offset] !== "\n") {
          this.advance();
        }
        continue;
      }
      if (ch === "/" && this.sql[this.offset + 1] === "*") {
        const start = this.position();
        this.advance();
        this.advance();
        let closed = false;
        while (this.offset < this.sql.length) {
          if (this.sql[this.offset] === "*" && this.sql[this.offset + 1] === "/") {
            this.advance();
            this.advance();
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) {
          fail("syntax", "Unterminated block comment", start, this.sql);
        }
        continue;
      }
      break;
    }
  }

  private scanIdent(start: SourcePosition): Token {
    while (this.offset < this.sql.length && isIdentPart(this.sql[this.offset]!)) {
      this.advance();
    }
    const lexeme = this.sql.slice(start.offset, this.offset);
    const keyword = KEYWORDS[lexeme.toLowerCase()];
    if (keyword) {
      return this.token(keyword, lexeme, start);
    }
    return this.token("ident", lexeme, start);
  }

  private scanQuotedIdent(quote: string, start: SourcePosition): Token {
    this.advance();
    let value = "";
    while (this.offset < this.sql.length) {
      const ch = this.sql[this.offset]!;
      if (ch === quote) {
        if (this.sql[this.offset + 1] === quote) {
          value += quote;
          this.advance();
          this.advance();
          continue;
        }
        this.advance();
        if (value.length === 0) {
          fail("syntax", "Quoted identifier cannot be empty", start, this.sql);
        }
        return { kind: "ident", lexeme: value, start, end: this.position(), value };
      }
      if (ch === "\n") {
        fail("syntax", "Unterminated quoted identifier", start, this.sql);
      }
      value += ch;
      this.advance();
    }
    fail("syntax", "Unterminated quoted identifier", start, this.sql);
  }

  private scanString(start: SourcePosition): Token {
    this.advance();
    let value = "";
    while (this.offset < this.sql.length) {
      const ch = this.sql[this.offset]!;
      if (ch === "'") {
        if (this.sql[this.offset + 1] === "'") {
          value += "'";
          this.advance();
          this.advance();
          continue;
        }
        this.advance();
        return { kind: "string", lexeme: value, start, end: this.position(), value };
      }
      if (ch === "\n") {
        fail("syntax", "Unterminated string literal", start, this.sql);
      }
      value += ch;
      this.advance();
    }
    fail("syntax", "Unterminated string literal", start, this.sql);
  }

  private scanNumber(start: SourcePosition): Token {
    while (this.offset < this.sql.length && isDigit(this.sql[this.offset]!)) {
      this.advance();
    }
    if (
      this.sql[this.offset] === "." &&
      isDigit(this.sql[this.offset + 1] ?? "")
    ) {
      this.advance();
      while (this.offset < this.sql.length && isDigit(this.sql[this.offset]!)) {
        this.advance();
      }
    }
    const lexeme = this.sql.slice(start.offset, this.offset);
    const value = Number(lexeme);
    if (!Number.isFinite(value)) {
      fail("syntax", `Invalid numeric literal '${lexeme}'`, start, this.sql);
    }
    return { kind: "number", lexeme, start, end: this.position(), value };
  }

  private single(kind: TokenKind, start: SourcePosition): Token {
    const lexeme = this.sql[this.offset]!;
    this.advance();
    return this.token(kind, lexeme, start);
  }

  private token(kind: TokenKind, lexeme: string, start: SourcePosition): Token {
    return { kind, lexeme, start, end: this.position() };
  }

  private peekChar(): string {
    return this.sql[this.offset] ?? "";
  }

  private advance(): void {
    const ch = this.sql[this.offset]!;
    this.offset += 1;
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
  }

  private position(): SourcePosition {
    return { offset: this.offset, line: this.line, column: this.column };
  }
}

function isIdentStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

export function tokenize(sql: string): Token[] {
  const lexer = new Lexer(sql);
  const tokens: Token[] = [];
  for (;;) {
    const token = lexer.next();
    tokens.push(token);
    if (token.kind === "eof") break;
  }
  return tokens;
}
