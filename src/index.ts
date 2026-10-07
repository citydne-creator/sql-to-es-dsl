import { SqlTranslationError } from "./errors.ts";
import { compile } from "./translate.ts";
import type { TranslateOptions, TranslateResult } from "./types.ts";

export { isSqlTranslationError, SqlTranslationError } from "./errors.ts";
export type {
  EsQuery,
  EsSortClause,
  FieldMapping,
  MappingInput,
  SourcePosition,
  SqlTranslationErrorCode,
  TranslateOptions,
  TranslateResult,
} from "./types.ts";

/**
 * Compile a bounded SQL SELECT statement into Elasticsearch Query DSL.
 *
 * This function is synchronous and side-effect free: it does not contact
 * Elasticsearch, load files, or execute SQL on an Elasticsearch SQL server.
 */
export function translate(sql: string, options: TranslateOptions = {}): TranslateResult {
  if (typeof sql !== "string") {
    throw new SqlTranslationError({
      code: "syntax",
      message: "SQL must be a string",
      position: { offset: 0, line: 1, column: 1 },
    });
  }
  return compile(sql, options.mapping);
}
