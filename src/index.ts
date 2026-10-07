import { isSqlTranslationError, SqlTranslationError } from "./errors.ts";
import { compile } from "./translate.ts";
import { MAX_SQL_LENGTH } from "./types.ts";
import type { TranslateOptions, TranslateResult } from "./types.ts";

export { isSqlTranslationError, SqlTranslationError } from "./errors.ts";
export {
  MAX_EXPRESSION_DEPTH,
  MAX_IN_TERMS,
  MAX_PREDICATE_LEAVES,
  MAX_SQL_LENGTH,
  MAX_TOKEN_COUNT,
} from "./types.ts";
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
  if (sql.length > MAX_SQL_LENGTH) {
    throw new SqlTranslationError({
      code: "limit",
      message: `SQL exceeds the maximum length of ${MAX_SQL_LENGTH} UTF-16 code units`,
      position: { offset: 0, line: 1, column: 1 },
      sql,
    });
  }
  try {
    return compile(sql, options.mapping);
  } catch (caught) {
    if (isSqlTranslationError(caught)) throw caught;
    if (caught instanceof RangeError) {
      throw new SqlTranslationError({
        code: "limit",
        message: "SQL exceeds compiler limits",
        position: { offset: 0, line: 1, column: 1 },
      });
    }
    throw caught;
  }
}
