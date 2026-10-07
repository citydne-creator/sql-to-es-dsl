import { describe, expect, it } from "vitest";
import { dsl } from "./helpers.ts";

describe("boolean precedence", () => {
  it("gives AND higher precedence than OR", () => {
    const result = dsl(
      "SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3",
    );
    expect(result.query).toEqual({
      bool: {
        should: [
          { term: { a: 1 } },
          {
            bool: {
              must: [{ term: { b: 2 } }, { term: { c: 3 } }],
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it("lets parentheses override precedence", () => {
    const result = dsl(
      "SELECT * FROM t WHERE (a = 1 OR b = 2) AND c = 3",
    );
    expect(result.query).toEqual({
      bool: {
        must: [
          {
            bool: {
              should: [{ term: { a: 1 } }, { term: { b: 2 } }],
              minimum_should_match: 1,
            },
          },
          { term: { c: 3 } },
        ],
      },
    });
  });

  it("applies NOT to the following predicate, not only the field", () => {
    const result = dsl("SELECT * FROM t WHERE NOT status = 'open'");
    expect(result.query).toEqual({
      bool: {
        must: [{ exists: { field: "status" } }],
        must_not: [{ term: { status: "open" } }],
      },
    });
  });

  it("uses De Morgan for NOT around parenthesized OR", () => {
    const result = dsl(
      "SELECT * FROM t WHERE NOT (a = 1 OR b = 2)",
    );
    expect(result.query).toEqual({
      bool: {
        must: [
          {
            bool: {
              must: [{ exists: { field: "a" } }],
              must_not: [{ term: { a: 1 } }],
            },
          },
          {
            bool: {
              must: [{ exists: { field: "b" } }],
              must_not: [{ term: { b: 2 } }],
            },
          },
        ],
      },
    });
  });

  it("cancels double NOT and De-Morgans NOT AND without a global exists", () => {
    expect(dsl("SELECT * FROM t WHERE NOT NOT status = 'open'").query).toEqual({
      term: { status: "open" },
    });
    expect(dsl("SELECT * FROM t WHERE NOT (a = 1 AND b = 2)").query).toEqual({
      bool: {
        should: [
          {
            bool: {
              must: [{ exists: { field: "a" } }],
              must_not: [{ term: { a: 1 } }],
            },
          },
          {
            bool: {
              must: [{ exists: { field: "b" } }],
              must_not: [{ term: { b: 2 } }],
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  });

  it("flattens chained AND and OR", () => {
    expect(dsl("SELECT * FROM t WHERE a = 1 AND b = 2 AND c = 3").query).toEqual({
      bool: {
        must: [{ term: { a: 1 } }, { term: { b: 2 } }, { term: { c: 3 } }],
      },
    });
    expect(dsl("SELECT * FROM t WHERE a = 1 OR b = 2 OR c = 3").query).toEqual({
      bool: {
        should: [{ term: { a: 1 } }, { term: { b: 2 } }, { term: { c: 3 } }],
        minimum_should_match: 1,
      },
    });
  });

  it("binds AND tighter on the left of OR as well", () => {
    const result = dsl("SELECT * FROM t WHERE a = 1 AND b = 2 OR c = 3");
    expect(result.query).toEqual({
      bool: {
        should: [
          {
            bool: {
              must: [{ term: { a: 1 } }, { term: { b: 2 } }],
            },
          },
          { term: { c: 3 } },
        ],
        minimum_should_match: 1,
      },
    });
  });
});
