import { expect } from "vitest";
import { SqlTranslationError, translate } from "../src/index.ts";
import type { MappingInput, TranslateResult } from "../src/index.ts";
import { matchIds } from "./evaluate.ts";

export function dsl(sql: string, mapping?: MappingInput): TranslateResult {
  return mapping ? translate(sql, { mapping }) : translate(sql);
}

export function matchingIds(
  sql: string,
  docs: Array<Record<string, unknown> & { id: string }>,
  mapping?: MappingInput,
): string[] {
  return matchIds(dsl(sql, mapping).query, docs).slice().sort();
}

export function ids(...values: string[]): string[] {
  return values.slice().sort();
}

export function err(sql: string, mapping?: MappingInput): SqlTranslationError {
  try {
    dsl(sql, mapping);
  } catch (caught) {
    expect(caught).toBeInstanceOf(SqlTranslationError);
    return caught as SqlTranslationError;
  }
  throw new Error(`expected SQL to fail: ${sql}`);
}

export const logsMapping: MappingInput = {
  properties: {
    status: { type: "keyword" },
    title: { type: "text", fields: { keyword: { type: "keyword" } } },
    body: { type: "text" },
    age: { type: "integer" },
    active: { type: "boolean" },
    ts: { type: "date" },
    user: {
      type: "object",
      properties: {
        name: { type: "keyword" },
        id: { type: "long" },
      },
    },
    tags: { type: "keyword" },
    comments: {
      type: "nested",
      properties: {
        text: { type: "keyword" },
      },
    },
    title_multi: {
      type: "text",
      fields: {
        raw: { type: "keyword" },
        exact: { type: "keyword" },
      },
    },
  },
};
