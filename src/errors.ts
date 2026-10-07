import type { SourcePosition, SqlTranslationErrorCode } from "./types.ts";

export interface SqlTranslationErrorOptions {
  code: SqlTranslationErrorCode;
  message: string;
  position: SourcePosition;
  sql?: string;
}

const MAX_SNIPPET_CHARS = 80;
const MAX_STORED_SQL = 256;
const MAX_MESSAGE = 240;

function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function snippet(sql: string, position: SourcePosition): string {
  const lines = sql.split(/\r?\n/);
  let line = lines[position.line - 1] ?? "";
  let column = position.column;
  if (line.length > MAX_SNIPPET_CHARS) {
    const col0 = Math.max(0, column - 1);
    const half = Math.floor(MAX_SNIPPET_CHARS / 2);
    let start = Math.max(0, col0 - half);
    let end = start + MAX_SNIPPET_CHARS;
    if (end > line.length) {
      end = line.length;
      start = Math.max(0, end - MAX_SNIPPET_CHARS);
    }
    const prefix = start > 0 ? "…" : "";
    const suffix = end < line.length ? "…" : "";
    line = `${prefix}${line.slice(start, end)}${suffix}`;
    column = prefix.length + (col0 - start) + 1;
  }
  const caretPad = " ".repeat(Math.max(0, column - 1));
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
    const message = boundText(options.message, MAX_MESSAGE);
    super(
      snippetText
        ? `${message} at ${where}\n${snippetText}`
        : `${message} at ${where}`,
    );
    this.name = "SqlTranslationError";
    this.code = options.code;
    this.position = options.position;
    this.sql =
      options.sql !== undefined && options.sql.length <= MAX_STORED_SQL
        ? options.sql
        : undefined;
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
