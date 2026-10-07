import { describe, expect, it } from "vitest";
import { dsl, err, logsMapping } from "./helpers.ts";

describe("mapping-aware equality", () => {
  it("uses a keyword field as written", () => {
    const result = dsl(
      "SELECT * FROM logs WHERE status = 'active'",
      logsMapping,
    );
    expect(result.query).toEqual({ term: { status: "active" } });
  });

  it("rewrites text equality onto .keyword", () => {
    const result = dsl(
      "SELECT * FROM logs WHERE title = 'hello'",
      logsMapping,
    );
    expect(result.query).toEqual({ term: { "title.keyword": "hello" } });
  });

  it("rejects equality on text without a keyword multi-field", () => {
    const error = err("SELECT * FROM logs WHERE body = 'x'", logsMapping);
    expect(error.code).toBe("semantic");
    expect(error.message).toMatch(/text field 'body'/);
    expect(error.position.line).toBe(1);
    expect(error.position.column).toBeGreaterThan(1);
  });

  it("rejects ambiguous keyword multi-fields instead of guessing", () => {
    const error = err(
      "SELECT * FROM logs WHERE title_multi = 'x'",
      logsMapping,
    );
    expect(error.code).toBe("semantic");
    expect(error.message).toMatch(/title_multi\.raw/);
    expect(error.message).toMatch(/title_multi\.exact/);
    expect(error.position.offset).toBeGreaterThan(0);
  });

  it("accepts an explicit multi-field path", () => {
    const result = dsl(
      "SELECT * FROM logs WHERE title_multi.raw = 'x'",
      logsMapping,
    );
    expect(result.query).toEqual({ term: { "title_multi.raw": "x" } });
  });

  it("walks object properties", () => {
    const result = dsl(
      "SELECT * FROM logs WHERE user.name = 'ada'",
      logsMapping,
    );
    expect(result.query).toEqual({ term: { "user.name": "ada" } });
  });

  it("rejects unknown fields when a mapping is provided", () => {
    const error = err("SELECT * FROM logs WHERE missing = 1", logsMapping);
    expect(error.code).toBe("semantic");
    expect(error.message).toMatch(/Unknown field 'missing'/);
  });

  it("rejects nested inner fields rather than emitting a plain term", () => {
    const error = err(
      "SELECT * FROM logs WHERE comments.text = 'hi'",
      logsMapping,
    );
    expect(error.code).toBe("unsupported");
    expect(error.message).toMatch(/Nested field/);
  });

  it("uses the keyword multi-field for ORDER BY on text", () => {
    const result = dsl("SELECT * FROM logs ORDER BY title DESC", logsMapping);
    expect(result.sort).toEqual([{ "title.keyword": { order: "desc" } }]);
  });

  it("rejects boolean literals on keyword fields", () => {
    const error = err("SELECT * FROM logs WHERE status = TRUE", logsMapping);
    expect(error.code).toBe("semantic");
  });

  it("type-checks numeric equality", () => {
    const error = err("SELECT * FROM logs WHERE age = '1'", logsMapping);
    expect(error.code).toBe("semantic");
    expect(error.message).toMatch(/numeric/);
  });

  it("allows SELECT of mapped object fields in _source", () => {
    const result = dsl("SELECT user FROM logs", logsMapping);
    expect(result._source).toEqual(["user"]);
  });

  it("leaves names unchanged when no mapping is provided", () => {
    const result = dsl("SELECT * FROM logs WHERE body = 'x'");
    expect(result.query).toEqual({ term: { body: "x" } });
  });
});
