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

  it("uses the keyword multi-field for negative equality exists guards", () => {
    const result = dsl(
      "SELECT * FROM logs WHERE title != 'hello'",
      logsMapping,
    );
    expect(result.query).toEqual({
      bool: {
        must: [{ exists: { field: "title.keyword" } }],
        must_not: [{ term: { "title.keyword": "hello" } }],
      },
    });
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

const typedMapping = {
  properties: {
    status: { type: "keyword" },
    addr: { type: "ip" },
    semver: { type: "version" },
    active: { type: "boolean" },
    path: { type: "wildcard" },
    title: { type: "text", fields: { keyword: { type: "keyword" } } },
  },
};

describe("mapped type usage", () => {
  it("still uses term on ip, version, boolean, and wildcard", () => {
    expect(dsl("SELECT * FROM t WHERE addr = '10.0.0.1'", typedMapping).query).toEqual({
      term: { addr: "10.0.0.1" },
    });
    expect(dsl("SELECT * FROM t WHERE semver = '1.2.3'", typedMapping).query).toEqual({
      term: { semver: "1.2.3" },
    });
    expect(dsl("SELECT * FROM t WHERE active = TRUE", typedMapping).query).toEqual({
      term: { active: true },
    });
    expect(dsl("SELECT * FROM t WHERE path = 'a/b'", typedMapping).query).toEqual({
      term: { path: "a/b" },
    });
  });

  it("rejects LIKE on ip and version fields", () => {
    expect(err("SELECT * FROM t WHERE addr LIKE '10.%'", typedMapping).code).toBe(
      "semantic",
    );
    expect(err("SELECT * FROM t WHERE semver LIKE '1.%'", typedMapping).code).toBe(
      "semantic",
    );
  });

  it("allows LIKE on wildcard and keyword multi-fields", () => {
    expect(dsl("SELECT * FROM t WHERE path LIKE 'a%'", typedMapping).query).toEqual({
      prefix: { path: { value: "a" } },
    });
    expect(dsl("SELECT * FROM t WHERE title LIKE 'Hel%'", typedMapping).query).toEqual({
      prefix: { "title.keyword": { value: "Hel" } },
    });
  });

  it("rejects boolean range and wildcard range", () => {
    const booleanRange = err("SELECT * FROM t WHERE active > TRUE", typedMapping);
    expect(booleanRange.code).toBe("semantic");
    expect(booleanRange.message).toMatch(/boolean/);
    const wildcardRange = err("SELECT * FROM t WHERE path > 'a'", typedMapping);
    expect(wildcardRange.code).toBe("semantic");
    expect(wildcardRange.message).toMatch(/wildcard/);
  });

  it("rejects wildcard sort while allowing ip, version, and boolean sort", () => {
    const wildcardSort = err("SELECT * FROM t ORDER BY path", typedMapping);
    expect(wildcardSort.code).toBe("semantic");
    expect(wildcardSort.message).toMatch(/wildcard/);
    expect(dsl("SELECT * FROM t ORDER BY addr", typedMapping).sort).toEqual([
      { addr: { order: "asc" } },
    ]);
    expect(dsl("SELECT * FROM t ORDER BY semver DESC", typedMapping).sort).toEqual([
      { semver: { order: "desc" } },
    ]);
    expect(dsl("SELECT * FROM t ORDER BY active", typedMapping).sort).toEqual([
      { active: { order: "asc" } },
    ]);
  });

  it("still allows range on ip, version, and keyword", () => {
    expect(dsl("SELECT * FROM t WHERE addr > '10.0.0.0'", typedMapping).query).toEqual({
      range: { addr: { gt: "10.0.0.0" } },
    });
    expect(dsl("SELECT * FROM t WHERE semver >= '1.0.0'", typedMapping).query).toEqual({
      range: { semver: { gte: "1.0.0" } },
    });
    expect(dsl("SELECT * FROM t WHERE status < 'z'", typedMapping).query).toEqual({
      range: { status: { lt: "z" } },
    });
  });

  it("does not invent types when mapping is omitted", () => {
    expect(dsl("SELECT * FROM t WHERE addr LIKE '10.%'").query).toEqual({
      prefix: { addr: { value: "10." } },
    });
  });
});
