import { fail } from "./errors.ts";
import type { SourcePosition } from "./types.ts";

export type LikePlan =
  | { kind: "term"; value: string }
  | { kind: "prefix"; value: string }
  | { kind: "wildcard"; value: string };

type Piece = { kind: "lit"; char: string } | { kind: "any" } | { kind: "star" };

/**
 * Translate SQL LIKE wildcards to an exact term, prefix, or ES wildcard.
 *
 * SQL semantics (escape is backslash, no ESCAPE clause):
 * - `%` matches any sequence of characters
 * - `_` matches a single character
 * - `\` escapes the next character so it is matched literally
 *
 * Elasticsearch wildcard mapping:
 * - SQL `%` → `*`
 * - SQL `_` → `?`
 * - literal `*`, `?`, and `\` in the pattern are escaped for the wildcard query
 *
 * A pattern with no wildcards becomes a `term` query.
 * A pattern that is a literal prefix followed by a single trailing `%`
 * becomes a `prefix` query.
 */
export function planLike(pattern: string, loc: SourcePosition, sql: string): LikePlan {
  const pieces = parseLike(pattern, loc, sql);
  const wildcards = pieces.filter((piece) => piece.kind !== "lit");
  const literal = pieces
    .filter((piece): piece is { kind: "lit"; char: string } => piece.kind === "lit")
    .map((piece) => piece.char)
    .join("");

  if (wildcards.length === 0) {
    return { kind: "term", value: literal };
  }

  const last = pieces[pieces.length - 1];
  const onlyTrailingStar =
    last?.kind === "star" && pieces.slice(0, -1).every((piece) => piece.kind === "lit");
  if (onlyTrailingStar) {
    return { kind: "prefix", value: literal };
  }

  let value = "";
  for (const piece of pieces) {
    if (piece.kind === "star") value += "*";
    else if (piece.kind === "any") value += "?";
    else value += escapeWildcard(piece.char);
  }
  return { kind: "wildcard", value };
}

function parseLike(pattern: string, loc: SourcePosition, sql: string): Piece[] {
  const pieces: Piece[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        fail("semantic", "LIKE pattern ends with a dangling escape", loc, sql);
      }
      pieces.push({ kind: "lit", char: next });
      i += 1;
      continue;
    }
    if (ch === "%") {
      pieces.push({ kind: "star" });
      continue;
    }
    if (ch === "_") {
      pieces.push({ kind: "any" });
      continue;
    }
    pieces.push({ kind: "lit", char: ch });
  }
  return pieces;
}

function escapeWildcard(char: string): string {
  if (char === "*" || char === "?" || char === "\\") return `\\${char}`;
  return char;
}
