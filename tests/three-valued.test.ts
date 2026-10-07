import { describe, expect, it } from "vitest";
import { ids, matchingIds } from "./helpers.ts";

const statusDocs = [
  { id: "eq", status: "x" },
  { id: "other", status: "y" },
  { id: "missing" },
  { id: "nul", status: null },
];

const abDocs = [
  { id: "both-match", a: 1, b: 2 },
  { id: "a-match-b-other", a: 1, b: 3 },
  { id: "a-other-b-match", a: 3, b: 2 },
  { id: "both-other", a: 3, b: 4 },
  { id: "a-match-b-missing", a: 1 },
  { id: "a-other-b-missing", a: 3 },
  { id: "a-missing-b-match", b: 2 },
  { id: "a-missing-b-other", b: 4 },
  { id: "both-missing" },
  { id: "a-null-b-match", a: null, b: 2 },
  { id: "a-other-b-null", a: 3, b: null },
];

const ageDocs = [
  { id: "high", age: 20 },
  { id: "low", age: 5 },
  { id: "missing" },
  { id: "nul", age: null },
];

const nameDocs = [
  { id: "ann", name: "Ann" },
  { id: "bob", name: "Bob" },
  { id: "missing" },
  { id: "nul", name: null },
];

describe("three-valued WHERE evaluation of emitted DSL", () => {
  it("keeps != from matching missing or explicit null", () => {
    expect(matchingIds("SELECT * FROM t WHERE status != 'x'", statusDocs)).toEqual(
      ids("other"),
    );
    expect(matchingIds("SELECT * FROM t WHERE NOT status = 'x'", statusDocs)).toEqual(
      ids("other"),
    );
    expect(matchingIds("SELECT * FROM t WHERE status = 'x'", statusDocs)).toEqual(
      ids("eq"),
    );
  });

  it("treats IS NULL as two-valued, including explicit null", () => {
    expect(matchingIds("SELECT * FROM t WHERE status IS NULL", statusDocs)).toEqual(
      ids("missing", "nul"),
    );
    expect(matchingIds("SELECT * FROM t WHERE status IS NOT NULL", statusDocs)).toEqual(
      ids("eq", "other"),
    );
    expect(matchingIds("SELECT * FROM t WHERE NOT status IS NULL", statusDocs)).toEqual(
      ids("eq", "other"),
    );
    expect(
      matchingIds("SELECT * FROM t WHERE NOT (status IS NOT NULL)", statusDocs),
    ).toEqual(ids("missing", "nul"));
  });

  it("cancels double NOT back to the positive comparison", () => {
    expect(
      matchingIds("SELECT * FROM t WHERE NOT NOT status = 'x'", statusDocs),
    ).toEqual(ids("eq"));
    expect(
      matchingIds("SELECT * FROM t WHERE NOT NOT (a = 1 AND b = 2)", abDocs),
    ).toEqual(ids("both-match"));
  });

  it("lets NOT AND match a nonmatching side when the other field is missing", () => {
    // AND is FALSE (hence NOT is TRUE) iff at least one conjunct is FALSE.
    expect(matchingIds("SELECT * FROM t WHERE NOT (a = 1 AND b = 2)", abDocs)).toEqual(
      ids(
        "a-match-b-other",
        "a-other-b-match",
        "both-other",
        "a-other-b-missing",
        "a-missing-b-other",
        "a-other-b-null",
      ),
    );
  });

  it("requires both sides present and nonmatching for NOT OR", () => {
    expect(matchingIds("SELECT * FROM t WHERE NOT (a = 1 OR b = 2)", abDocs)).toEqual(
      ids("both-other"),
    );
  });

  it("does not let negative range, IN, or LIKE match missing values", () => {
    expect(matchingIds("SELECT * FROM t WHERE NOT (age > 10)", ageDocs)).toEqual(
      ids("low"),
    );
    expect(matchingIds("SELECT * FROM t WHERE age NOT BETWEEN 1 AND 9", ageDocs)).toEqual(
      ids("high"),
    );
    expect(matchingIds("SELECT * FROM t WHERE status NOT IN ('x')", statusDocs)).toEqual(
      ids("other"),
    );
    expect(matchingIds("SELECT * FROM t WHERE name NOT LIKE 'A%'", nameDocs)).toEqual(
      ids("bob"),
    );
  });
});
