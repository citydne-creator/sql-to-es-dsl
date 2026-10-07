import type { SourcePosition, SqlTranslationErrorCode } from "./types.ts";

export interface SqlTranslationErrorOptions {
  code: SqlTranslationErrorCode;
  message: string;
  position: SourcePosition;
  sql?: string;
}

function snippet(sql: string, position: SourcePosition): string {
  const lines = sql.split(/\r?\n/);
  const line = lines[position.line - 1] ?? "";
  const caretPad = " ".repeat(Math.max(0, position.column - 1));
  return `${position.line}| ${line}\n${" ".repeat(String(position.line).length)}| ${caretPad}^`;
}

/** Structured compiler error with a source position. */
export class SqlTranslationError extends Error {
  readonly code: SqlTranslationErrorCode;
  readonly position: SourcePosition;
  readonly sql?: string;
  readonly snippet?: string;

  constructor(options: SqlTranslationErrorOptions) {
    const where = `${options.position.line}:${options.position.column}`;
    const snippetText =
      options.sql !== undefined ? snippet(options.sql, options.position) : undefined;
    super(
      snippetText
        ? `${options.message} at ${where}\n${snippetText}`
        : `${options.message} at ${where}`,
    );
    this.name = "SqlTranslationError";
    this.code = options.code;
    this.position = options.position;
    this.sql = options.sql;
    this.snippet = snippetText;
  }

  toJSON(): {
    name: string;
    code: SqlTranslationErrorCode;
    message: string;
    position: SourcePosition;
  } {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      position: this.position,
    };
  }
}

export function isSqlTranslationError(value: unknown): value is SqlTranslationError {
  return value instanceof SqlTranslationError;
}

export function fail(
  code: SqlTranslationErrorCode,
  message: string,
  position: SourcePosition,
  sql?: string,
): never {
  throw new SqlTranslationError({ code, message, position, sql });
}
