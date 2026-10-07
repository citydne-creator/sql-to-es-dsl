import type { EsQuery } from "../src/index.ts";

/**
 * Test-only evaluator for the Query DSL subset this compiler emits.
 *
 * Scope is explicit: `match_all`, `term`, `terms`, `range`, `exists`,
 * `prefix`, `wildcard`, and `bool` (`must` / `must_not` / `should` /
 * `minimum_should_match`). Leaf semantics follow Elasticsearch: missing and
 * JSON-null values do not match `term`/`terms`/`range`/`prefix`/`wildcard`,
 * while `must_not` of those clauses does match them. This is not a general
 * Elasticsearch simulator.
 */
export function matchesQuery(query: EsQuery, doc: Record<string, unknown>): boolean {
  if ("match_all" in query) return true;
  if (query.term) return matchTerm(query.term, doc);
  if (query.terms) return matchTerms(query.terms, doc);
  if (query.range) return matchRange(query.range, doc);
  if (query.exists) {
    const field = fieldName(query.exists);
    return !isMissing(getField(doc, field));
  }
  if (query.prefix) return matchPrefix(query.prefix, doc);
  if (query.wildcard) return matchWildcard(query.wildcard, doc);
  if (query.bool) return matchBool(query.bool, doc);
  throw new Error(`unsupported test DSL clause: ${JSON.stringify(query)}`);
}

export function matchIds(
  query: EsQuery,
  docs: Array<Record<string, unknown> & { id: string }>,
): string[] {
  return docs.filter((doc) => matchesQuery(query, doc)).map((doc) => doc.id);
}

function matchTerm(body: unknown, doc: Record<string, unknown>): boolean {
  const [field, value] = onlyEntry(body);
  return sameValue(getField(doc, field), value);
}

function matchTerms(body: unknown, doc: Record<string, unknown>): boolean {
  const [field, values] = onlyEntry(body);
  if (!Array.isArray(values)) {
    throw new Error(`terms query expects an array: ${JSON.stringify(body)}`);
  }
  const actual = getField(doc, field);
  if (isMissing(actual)) return false;
  return values.some((value) => sameValue(actual, value));
}

function matchRange(body: unknown, doc: Record<string, unknown>): boolean {
  const [field, bounds] = onlyEntry(body);
  if (!isRecord(bounds)) {
    throw new Error(`range query expects bounds: ${JSON.stringify(body)}`);
  }
  const actual = getField(doc, field);
  if (!isOrdered(actual)) return false;
  if (bounds.gt !== undefined && !(isOrdered(bounds.gt) && actual > bounds.gt)) return false;
  if (bounds.gte !== undefined && !(isOrdered(bounds.gte) && actual >= bounds.gte)) return false;
  if (bounds.lt !== undefined && !(isOrdered(bounds.lt) && actual < bounds.lt)) return false;
  if (bounds.lte !== undefined && !(isOrdered(bounds.lte) && actual <= bounds.lte)) return false;
  return true;
}

function isOrdered(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

function matchPrefix(body: unknown, doc: Record<string, unknown>): boolean {
  const [field, spec] = onlyEntry(body);
  const actual = getField(doc, field);
  if (typeof actual !== "string") return false;
  return actual.startsWith(prefixValue(spec));
}

function matchWildcard(body: unknown, doc: Record<string, unknown>): boolean {
  const [field, spec] = onlyEntry(body);
  const actual = getField(doc, field);
  if (typeof actual !== "string") return false;
  return wildcardMatches(actual, prefixValue(spec));
}

function matchBool(body: unknown, doc: Record<string, unknown>): boolean {
  if (!isRecord(body)) {
    throw new Error(`bool query expects an object: ${JSON.stringify(body)}`);
  }
  const must = asQueries(body.must);
  const mustNot = asQueries(body.must_not);
  const should = asQueries(body.should);
  if (must.some((clause) => !matchesQuery(clause, doc))) return false;
  if (mustNot.some((clause) => matchesQuery(clause, doc))) return false;
  if (should.length > 0) {
    const required =
      typeof body.minimum_should_match === "number" ? body.minimum_should_match : 0;
    const hits = should.filter((clause) => matchesQuery(clause, doc)).length;
    if (hits < required) return false;
  }
  return true;
}

function asQueries(value: unknown): EsQuery[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value as EsQuery[];
  return [value as EsQuery];
}

function prefixValue(spec: unknown): string {
  if (typeof spec === "string") return spec;
  if (isRecord(spec) && typeof spec.value === "string") return spec.value;
  throw new Error(`expected { value: string }, got ${JSON.stringify(spec)}`);
}

function fieldName(body: unknown): string {
  if (isRecord(body) && typeof body.field === "string") return body.field;
  throw new Error(`exists query expects { field: string }, got ${JSON.stringify(body)}`);
}

function onlyEntry(body: unknown): [string, unknown] {
  if (!isRecord(body)) {
    throw new Error(`expected a single-field object, got ${JSON.stringify(body)}`);
  }
  const entries = Object.entries(body);
  if (entries.length !== 1) {
    throw new Error(`expected a single-field object, got ${JSON.stringify(body)}`);
  }
  return entries[0]!;
}

function getField(doc: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(doc, path)) return doc[path];
  let current: unknown = doc;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isMissing(value: unknown): boolean {
  return value === undefined || value === null;
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (isMissing(actual)) return false;
  return actual === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function wildcardMatches(text: string, pattern: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) {
        throw new Error(`dangling wildcard escape in ${pattern}`);
      }
      regex += escapeRegex(next);
      i += 1;
      continue;
    }
    if (ch === "*") regex += ".*";
    else if (ch === "?") regex += ".";
    else regex += escapeRegex(ch);
  }
  regex += "$";
  return new RegExp(regex).test(text);
}

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
