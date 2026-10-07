import { describe, expect, it } from "vitest";
import { isSqlTranslationError } from "../src/index.ts";
import { err } from "./helpers.ts";

describe("invalid syntax, unsupported SQL, bounds, positions", () => {
  it("reports syntax errors at the unexpected token", () => {
    const error = err("SELECT FROM logs");
    expect(error.code).toBe("syntax");
    expect(error.position).toEqual({ offset: 7, line: 1, column: 8 });
    expect(error.snippet).toMatch(/\^/);
    expect(isSqlTranslationError(error)).toBe(true);
  });

  it("points at unterminated strings", () => {
    const error = err("SELECT * FROM t WHERE name = 'oops");
    expect(error.code).toBe("syntax");
    expect(error.message).toMatch(/Unterminated string/);
    expect(error.position.column).toBe(30);
  });

  it("rejects JOIN with an unsupported error on JOIN", () => {
    const sql = "SELECT * FROM a JOIN b ON a.id = b.id";
    const error = err(sql);
    expect(error.code).toBe("unsupported");
    expect(error.message).toMatch(/JOIN/);
    expect(error.position.offset).toBe(sql.indexOf("JOIN"));
  });

  it("rejects multiple indexes, subqueries, GROUP BY, HAVING, and aggregates", () => {
    expect(err("SELECT * FROM a, b").code).toBe("unsupported");
    expect(err("SELECT * FROM a WHERE id IN (SELECT id FROM b)").message).toMatch(
      /Subqueries/,
    );
    expect(err("SELECT * FROM a GROUP BY status").message).toMatch(/GROUP BY/);
    expect(err("SELECT * FROM a HAVING COUNT(1) > 1").message).toMatch(/HAVING/);
    const count = err("SELECT COUNT(*) FROM a");
    expect(count.code).toBe("unsupported");
    expect(count.message).toMatch(/Function 'COUNT'/);
    expect(count.position.offset).toBe("SELECT COUNT".length);
  });

  it("rejects UPDATE/DELETE, DISTINCT, aliases, and field-to-field compare", () => {
    expect(err("UPDATE logs SET status = 'x'").message).toMatch(/UPDATE/);
    expect(err("DELETE FROM logs").message).toMatch(/DELETE/);
    expect(err("SELECT DISTINCT status FROM logs").message).toMatch(/DISTINCT/);
    expect(err("SELECT status AS s FROM logs").message).toMatch(/aliases/);
    const compare = err("SELECT * FROM logs WHERE status = level");
    expect(compare.code).toBe("semantic");
    expect(compare.message).toMatch(/field-to-field/);
  });

  it("rejects negative and non-integer LIMIT/OFFSET at that token", () => {
    const negative = err("SELECT * FROM logs LIMIT -1");
    expect(negative.code).toBe("semantic");
    expect(negative.message).toMatch(/LIMIT/);
    expect(negative.position.offset).toBe("SELECT * FROM logs LIMIT ".length);

    const fractional = err("SELECT * FROM logs OFFSET 1.5");
    expect(fractional.code).toBe("semantic");
    expect(fractional.position.line).toBe(1);
  });

  it("tracks multi-line column positions", () => {
    const error = err("SELECT *\nFROM logs\nWHERE MATCH(title, 'x')");
    expect(error.code).toBe("unsupported");
    expect(error.position).toEqual({ offset: 30, line: 3, column: 12 });
    expect(error.message).toMatch(/Function 'MATCH'/);
  });

  it("rejects extra tokens after a valid statement", () => {
    const error = err("SELECT * FROM logs WHERE a = 1 extra");
    expect(error.code).toBe("syntax");
    expect(error.message).toMatch(/Unexpected token 'extra'/);
  });

  it("serializes structured error fields", () => {
    const error = err("SELECT * FROM");
    const json = error.toJSON();
    expect(json.name).toBe("SqlTranslationError");
    expect(json.code).toBe("syntax");
    expect(json.position.line).toBe(1);
    expect(json.position.column).toBeGreaterThan(1);
  });
});
