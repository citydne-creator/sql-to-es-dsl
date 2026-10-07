import { describe, expect, it } from "vitest";
import { dsl, err, logsMapping } from "./helpers.ts";

describe("ranges, IN, BETWEEN, NULL, LIKE", () => {
  it("emits range queries for inequalities", () => {
    expect(dsl("SELECT * FROM t WHERE age > 10").query).toEqual({
      range: { age: { gt: 10 } },
    });
    expect(dsl("SELECT * FROM t WHERE age >= 10").query).toEqual({
      range: { age: { gte: 10 } },
    });
    expect(dsl("SELECT * FROM t WHERE age < 10").query).toEqual({
      range: { age: { lt: 10 } },
    });
    expect(dsl("SELECT * FROM t WHERE age <= 10").query).toEqual({
      range: { age: { lte: 10 } },
    });
  });

  it("treats != and <> as exists plus must_not term", () => {
    const expected = {
      bool: {
        must: [{ exists: { field: "status" } }],
        must_not: [{ term: { status: "x" } }],
      },
    };
    expect(dsl("SELECT * FROM t WHERE status != 'x'").query).toEqual(expected);
    expect(dsl("SELECT * FROM t WHERE status <> 'x'").query).toEqual(expected);
  });

  it("emits terms for IN and NOT IN", () => {
    expect(dsl("SELECT * FROM t WHERE status IN ('a', 'b')").query).toEqual({
      terms: { status: ["a", "b"] },
    });
    expect(dsl("SELECT * FROM t WHERE status NOT IN ('a')").query).toEqual({
      bool: {
        must: [{ exists: { field: "status" } }],
        must_not: [{ terms: { status: ["a"] } }],
      },
    });
  });

  it("rejects empty IN lists", () => {
    const error = err("SELECT * FROM t WHERE status IN ()");
    expect(error.code).toBe("semantic");
    expect(error.message).toMatch(/empty/);
  });

  it("maps BETWEEN to an inclusive range", () => {
    expect(dsl("SELECT * FROM t WHERE age BETWEEN 1 AND 9").query).toEqual({
      range: { age: { gte: 1, lte: 9 } },
    });
    expect(dsl("SELECT * FROM t WHERE age NOT BETWEEN 1 AND 9").query).toEqual({
      bool: {
        must: [{ exists: { field: "age" } }],
        must_not: [{ range: { age: { gte: 1, lte: 9 } } }],
      },
    });
  });

  it("maps IS NULL / IS NOT NULL to exists", () => {
    expect(dsl("SELECT * FROM t WHERE title IS NULL").query).toEqual({
      bool: { must_not: [{ exists: { field: "title" } }] },
    });
    expect(dsl("SELECT * FROM t WHERE title IS NOT NULL").query).toEqual({
      exists: { field: "title" },
    });
  });

  it("rejects = NULL in favor of IS NULL", () => {
    const error = err("SELECT * FROM t WHERE title = NULL");
    expect(error.code).toBe("semantic");
    expect(error.message).toMatch(/IS NULL/);
  });

  it("uses term for LIKE patterns without wildcards", () => {
    expect(dsl("SELECT * FROM t WHERE name LIKE 'Ada'").query).toEqual({
      term: { name: "Ada" },
    });
  });

  it("uses prefix when the only wildcard is a trailing %", () => {
    expect(dsl("SELECT * FROM t WHERE name LIKE 'Ada%'").query).toEqual({
      prefix: { name: { value: "Ada" } },
    });
  });

  it("translates % and _ to wildcard * and ?", () => {
    expect(dsl("SELECT * FROM t WHERE name LIKE '%Ada_'").query).toEqual({
      wildcard: { name: { value: "*Ada?" } },
    });
  });

  it("escapes Elasticsearch wildcard metacharacters that appear literally", () => {
    expect(dsl("SELECT * FROM t WHERE name LIKE 'a*b?c\\%'").query).toEqual({
      term: { name: "a*b?c%" },
    });
    expect(dsl("SELECT * FROM t WHERE name LIKE '%a*b%'").query).toEqual({
      wildcard: { name: { value: "*a\\*b*" } },
    });
  });

  it("supports NOT LIKE and dangling-escape errors", () => {
    expect(dsl("SELECT * FROM t WHERE name NOT LIKE 'A%'").query).toEqual({
      bool: {
        must: [{ exists: { field: "name" } }],
        must_not: [{ prefix: { name: { value: "A" } } }],
      },
    });
    const error = err("SELECT * FROM t WHERE name LIKE 'A\\'");
    expect(error.code).toBe("semantic");
    expect(error.message).toMatch(/dangling escape/);
  });

  it("resolves LIKE onto a keyword multi-field", () => {
    const result = dsl("SELECT * FROM logs WHERE title LIKE 'Hel%'", logsMapping);
    expect(result.query).toEqual({
      prefix: { "title.keyword": { value: "Hel" } },
    });
  });

  it("rejects LIKE on numeric and date fields", () => {
    expect(err("SELECT * FROM logs WHERE age LIKE '1%'", logsMapping).code).toBe(
      "semantic",
    );
    expect(err("SELECT * FROM logs WHERE ts LIKE '2024%'", logsMapping).code).toBe(
      "semantic",
    );
  });

  it("accepts negative numeric literals and dates as range bounds", () => {
    expect(dsl("SELECT * FROM t WHERE age > -3").query).toEqual({
      range: { age: { gt: -3 } },
    });
    expect(
      dsl("SELECT * FROM logs WHERE ts >= '2024-01-01'", logsMapping).query,
    ).toEqual({
      range: { ts: { gte: "2024-01-01" } },
    });
  });

  it("compares booleans with term", () => {
    expect(
      dsl("SELECT * FROM logs WHERE active = TRUE", logsMapping).query,
    ).toEqual({ term: { active: true } });
    expect(
      dsl("SELECT * FROM logs WHERE active = false", logsMapping).query,
    ).toEqual({ term: { active: false } });
  });
});
