import { describe, expect, it } from "vitest";
import { dsl } from "./helpers.ts";

describe("projection, order, pagination", () => {
  it("omits _source for SELECT * and match_all without WHERE", () => {
    const result = dsl("SELECT * FROM events");
    expect(result).toEqual({
      index: "events",
      query: { match_all: {} },
    });
    expect(result._source).toBeUndefined();
  });

  it("projects selected fields into _source", () => {
    const result = dsl("SELECT title, status FROM logs");
    expect(result._source).toEqual(["title", "status"]);
    expect(result.index).toBe("logs");
  });

  it("emits sort clauses with default ASC and explicit DESC", () => {
    const result = dsl("SELECT * FROM logs ORDER BY ts DESC, status");
    expect(result.sort).toEqual([
      { ts: { order: "desc" } },
      { status: { order: "asc" } },
    ]);
  });

  it("maps LIMIT to size and OFFSET to from", () => {
    expect(dsl("SELECT * FROM logs LIMIT 10").size).toBe(10);
    expect(dsl("SELECT * FROM logs OFFSET 5").from).toBe(5);
    const both = dsl("SELECT * FROM logs LIMIT 10 OFFSET 5");
    expect(both.size).toBe(10);
    expect(both.from).toBe(5);
    const swapped = dsl("SELECT * FROM logs OFFSET 2 LIMIT 3");
    expect(swapped.from).toBe(2);
    expect(swapped.size).toBe(3);
  });

  it("accepts quoted index names and dotted select fields", () => {
    const result = dsl('SELECT "user.name" FROM "logs-2024"');
    expect(result.index).toBe("logs-2024");
    expect(result._source).toEqual(["user.name"]);
  });

  it("ignores comments and an optional semicolon", () => {
    const result = dsl(`
      -- fetch errors
      SELECT status /* projected */ FROM logs
      WHERE status = 'error'; -- done
    `);
    expect(result.query).toEqual({ term: { status: "error" } });
    expect(result._source).toEqual(["status"]);
  });
});
