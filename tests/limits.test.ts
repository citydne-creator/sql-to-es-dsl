import { describe, expect, it } from "vitest";
import {
  MAX_EXPRESSION_DEPTH,
  MAX_IN_TERMS,
  MAX_PREDICATE_LEAVES,
  MAX_SQL_LENGTH,
  MAX_TOKEN_COUNT,
  type FieldMapping,
} from "../src/index.ts";
import { dsl, err } from "./helpers.ts";

function andChain(count: number): string {
  return `SELECT * FROM t WHERE ${Array.from({ length: count }, () => "a = 1").join(" AND ")}`;
}

describe("input and compiler limits", () => {
  it("accepts SQL at the UTF-16 length bound and rejects one code unit more", () => {
    const prefix = "SELECT * FROM t WHERE a = 1";
    const atLimit = prefix + " ".repeat(MAX_SQL_LENGTH - prefix.length);
    expect(atLimit.length).toBe(MAX_SQL_LENGTH);
    expect(dsl(atLimit).index).toBe("t");

    const overflow = atLimit + " ";
    const error = err(overflow);
    expect(error.code).toBe("limit");
    expect(error.message).toMatch(/maximum length/);
    expect(error.message.length).toBeLessThan(400);
    expect(error.sql).toBeUndefined();
  });

  it("bounds snippets so a long line is not copied into the error", () => {
    const error = err(`SELECT * FROM t WHERE a = 1 ${"x".repeat(5000)}`);
    expect(error.code).toBe("syntax");
    expect(error.snippet!.length).toBeLessThan(200);
    expect(error.message.length).toBeLessThan(400);
    expect(error.message).not.toContain("x".repeat(200));
  });

  it("accepts the token bound and rejects one extra token", () => {
    const atLimit = `SELECT ${Array.from({ length: 4095 }, () => "a").join(",")} FROM t`;
    expect(dsl(atLimit)._source).toHaveLength(4095);

    const overflow = `SELECT ${Array.from({ length: 4096 }, () => "a").join(",")} FROM t`;
    const error = err(overflow);
    expect(error.code).toBe("limit");
    expect(error.message).toMatch(new RegExp(`maximum of ${MAX_TOKEN_COUNT} tokens`));
  });

  it("accepts nested NOT and parentheses at the depth bound", () => {
    const nots = "NOT ".repeat(MAX_EXPRESSION_DEPTH);
    expect(dsl(`SELECT * FROM t WHERE ${nots}a = 1`).query).toEqual({
      term: { a: 1 },
    });

    const open = "(".repeat(MAX_EXPRESSION_DEPTH);
    const close = ")".repeat(MAX_EXPRESSION_DEPTH);
    expect(dsl(`SELECT * FROM t WHERE ${open}a = 1${close}`).query).toEqual({
      term: { a: 1 },
    });
  });

  it("rejects one extra nested NOT or parenthesis with a limit error", () => {
    const tooDeepNot = err(
      `SELECT * FROM t WHERE ${"NOT ".repeat(MAX_EXPRESSION_DEPTH + 1)}a = 1`,
    );
    expect(tooDeepNot.code).toBe("limit");
    expect(tooDeepNot.message).toMatch(/nesting/);

    const tooDeepParen = err(
      `SELECT * FROM t WHERE ${"(".repeat(MAX_EXPRESSION_DEPTH + 1)}a = 1${")".repeat(MAX_EXPRESSION_DEPTH + 1)}`,
    );
    expect(tooDeepParen.code).toBe("limit");
    expect(tooDeepParen).not.toBeInstanceOf(RangeError);
  });

  it("compiles a left-deep AND chain at the predicate-leaf bound", () => {
    const result = dsl(andChain(MAX_PREDICATE_LEAVES));
    const must = (result.query as { bool: { must: unknown[] } }).bool.must;
    expect(must).toHaveLength(MAX_PREDICATE_LEAVES);
  });

  it("rejects one extra predicate leaf instead of overflowing", () => {
    const error = err(andChain(MAX_PREDICATE_LEAVES + 1));
    expect(error.code).toBe("limit");
    expect(error.message).toMatch(/predicates/);
    expect(error).not.toBeInstanceOf(RangeError);
  });

  it("accepts IN lists at the term bound and rejects one extra term", () => {
    const terms = Array.from({ length: MAX_IN_TERMS }, (_, i) => String(i));
    const result = dsl(`SELECT * FROM t WHERE a IN (${terms.join(", ")})`);
    expect(result.query).toEqual({ terms: { a: terms.map(Number) } });

    const overflow = err(
      `SELECT * FROM t WHERE a IN (${Array.from({ length: MAX_IN_TERMS + 1 }, () => "1").join(", ")})`,
    );
    expect(overflow.code).toBe("limit");
    expect(overflow.message).toMatch(/IN lists/);
  });
});

describe("numeric literals and pagination bounds", () => {
  it("keeps safe integers and finite fractional Number semantics", () => {
    expect(dsl("SELECT * FROM t WHERE age = 9007199254740991").query).toEqual({
      term: { age: 9007199254740991 },
    });
    expect(dsl("SELECT * FROM t WHERE age = 1.5").query).toEqual({
      term: { age: 1.5 },
    });
    expect(dsl("SELECT * FROM t WHERE x = 0.1").query).toEqual({
      term: { x: 0.1 },
    });
    expect(dsl("SELECT * FROM t LIMIT 9007199254740991").size).toBe(9007199254740991);
  });

  it("rejects integer literals that Number would round", () => {
    const query = err("SELECT * FROM t WHERE age = 9007199254740993");
    expect(query.code).toBe("syntax");
    expect(query.message).toMatch(/safe integer/);
    expect(Number("9007199254740993")).toBe(9007199254740992);
  });

  it("rejects LIMIT and OFFSET outside the safe integer range", () => {
    const limit = err("SELECT * FROM t LIMIT 9007199254740993");
    expect(limit.code).toBe("syntax");
    expect(limit.message).toMatch(/safe integer/);

    const offset = err("SELECT * FROM t OFFSET 9007199254740993");
    expect(offset.code).toBe("syntax");
  });
});

describe("FROM index contract", () => {
  it("preserves quoted hyphen and dotted index names", () => {
    expect(dsl('SELECT * FROM "logs-2024"').index).toBe("logs-2024");
    expect(dsl("SELECT * FROM `my.index`").index).toBe("my.index");
  });

  it("rejects hostile quoted selectors and path characters", () => {
    expect(err('SELECT * FROM "*"').code).toBe("unsupported");
    expect(err('SELECT * FROM "a,b"').code).toBe("unsupported");
    expect(err('SELECT * FROM "a/b"').code).toBe("unsupported");
    expect(err('SELECT * FROM "a\\b"').code).toBe("unsupported");
    expect(err('SELECT * FROM "cluster:index"').code).toBe("unsupported");
    expect(err('SELECT * FROM "."').code).toBe("unsupported");
    expect(err('SELECT * FROM ".."').code).toBe("unsupported");
    expect(err('SELECT * FROM "a\u0001b"').code).toBe("unsupported");
  });
});

describe("own-property keyword and mapping lookup", () => {
  it("treats constructor and __proto__ as identifiers, not inherited keywords", () => {
    expect(dsl("SELECT constructor FROM t WHERE constructor = 1")).toEqual({
      index: "t",
      query: { term: { constructor: 1 } },
      _source: ["constructor"],
    });
    const protoQuery = dsl("SELECT * FROM t WHERE __proto__ = 1").query as {
      term: Record<string, unknown>;
    };
    expect(Object.getOwnPropertyDescriptor(protoQuery.term, "__proto__")?.value).toBe(1);
  });

  it("resolves own constructor and __proto__ fields and ignores inherited keys", () => {
    const inherited = { polluted: { type: "keyword" as const } };
    const properties = Object.create(inherited) as Record<string, FieldMapping>;
    Object.defineProperty(properties, "constructor", {
      value: { type: "keyword" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(properties, "__proto__", {
      value: { type: "keyword" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const mapping = { properties };

    expect(dsl("SELECT * FROM t WHERE constructor = 'a'", mapping).query).toEqual({
      term: { constructor: "a" },
    });
    const protoQuery = dsl("SELECT * FROM t WHERE __proto__ = 'a'", mapping).query as {
      term: Record<string, unknown>;
    };
    expect(Object.getOwnPropertyDescriptor(protoQuery.term, "__proto__")?.value).toBe("a");
    const inheritedField = err("SELECT * FROM t WHERE polluted = 'a'", mapping);
    expect(inheritedField.code).toBe("semantic");
    expect(inheritedField.message).toMatch(/Unknown field 'polluted'/);
  });
});
