import type { FieldRef } from "./ast.ts";
import { fail } from "./errors.ts";
import type { FieldMapping, MappingInput, SourcePosition } from "./types.ts";

export type FieldUsage = "exact" | "range" | "sort" | "like" | "exists" | "source";

export interface ResolvedField {
  path: string;
  type: string;
  requested: string;
}

const KEYWORD_LIKE = new Set(["keyword", "constant_keyword"]);

const NUMERIC = new Set([
  "long",
  "integer",
  "short",
  "byte",
  "double",
  "float",
  "half_float",
  "scaled_float",
  "unsigned_long",
]);

const DATE = new Set(["date", "date_nanos"]);

export function isKeywordLike(type: string): boolean {
  return KEYWORD_LIKE.has(type);
}

export function isNumeric(type: string): boolean {
  return NUMERIC.has(type);
}

export function isDate(type: string): boolean {
  return DATE.has(type);
}

export function isText(type: string): boolean {
  return type === "text" || type === "match_only_text" || type === "search_as_you_type";
}

function isExactLeaf(type: string): boolean {
  return (
    isKeywordLike(type) ||
    type === "wildcard" ||
    type === "ip" ||
    type === "boolean" ||
    type === "version" ||
    isNumeric(type) ||
    isDate(type)
  );
}

function supportsLike(type: string): boolean {
  return isKeywordLike(type) || type === "wildcard";
}

function supportsRange(type: string): boolean {
  return (
    isNumeric(type) ||
    isDate(type) ||
    type === "ip" ||
    type === "version" ||
    isKeywordLike(type)
  );
}

function supportsSort(type: string): boolean {
  return (
    isKeywordLike(type) ||
    isNumeric(type) ||
    isDate(type) ||
    type === "ip" ||
    type === "boolean" ||
    type === "version"
  );
}

export function propertiesOf(mapping: MappingInput | undefined): Record<string, FieldMapping> | undefined {
  if (!mapping) return undefined;
  if ("properties" in mapping && mapping.properties) return mapping.properties;
  if ("mappings" in mapping) return mapping.mappings.properties ?? {};
  return undefined;
}

interface WalkedField {
  mapping: FieldMapping;
  path: string;
  nested: boolean;
}

export function resolveField(
  field: FieldRef,
  mapping: MappingInput | undefined,
  usage: FieldUsage,
  sql: string,
): ResolvedField {
  const properties = propertiesOf(mapping);
  if (!properties) {
    return { path: field.name, type: "unmapped", requested: field.name };
  }

  const walked = walk(properties, field.name, field.loc, sql);
  if (walked.nested) {
    fail(
      "unsupported",
      `Nested field '${field.name}' requires a nested query, which is not supported`,
      field.loc,
      sql,
    );
  }

  const type = walked.mapping.type ?? "object";
  if (usage === "source") {
    return { path: walked.path, type, requested: field.name };
  }

  if (usage === "exists") {
    if (type === "object" || type === "nested") {
      fail(
        "semantic",
        `Field '${field.name}' is an object; specify a leaf field`,
        field.loc,
        sql,
      );
    }
    return { path: walked.path, type, requested: field.name };
  }

  if (usage === "exact" || usage === "like" || usage === "sort") {
    return resolveExact(field, walked, usage, sql);
  }

  return resolveRange(field, walked, sql);
}

function resolveExact(
  field: FieldRef,
  walked: WalkedField,
  usage: FieldUsage,
  sql: string,
): ResolvedField {
  const type = walked.mapping.type ?? "object";
  if (isExactLeaf(type)) {
    assertUsage(field, type, usage, sql);
    return { path: walked.path, type, requested: field.name };
  }
  if (isText(type)) {
    const keywordPath = keywordMultiField(walked, field.loc, sql);
    if (keywordPath) {
      assertUsage(field, keywordPath.type, usage, sql);
      return keywordPath;
    }
    fail(
      "semantic",
      usage === "sort"
        ? `Cannot sort on text field '${field.name}' without a keyword multi-field`
        : usage === "like"
          ? `LIKE on text field '${field.name}' is unsupported without a keyword multi-field`
          : `Equality on text field '${field.name}' is unsupported without a keyword multi-field; use a .keyword subfield or map one`,
      field.loc,
      sql,
    );
  }
  if (type === "object" || type === "nested") {
    fail(
      "semantic",
      `Field '${field.name}' is an object; specify a leaf field`,
      field.loc,
      sql,
    );
  }
  fail(
    "unsupported",
    `Field '${field.name}' has unsupported type '${type}' for this predicate`,
    field.loc,
    sql,
  );
}

function resolveRange(field: FieldRef, walked: WalkedField, sql: string): ResolvedField {
  const type = walked.mapping.type ?? "object";
  if (supportsRange(type)) {
    return { path: walked.path, type, requested: field.name };
  }
  if (isText(type)) {
    const keywordPath = keywordMultiField(walked, field.loc, sql);
    if (keywordPath) {
      if (!supportsRange(keywordPath.type)) {
        failRangeType(field, keywordPath.type, sql);
      }
      return keywordPath;
    }
    fail(
      "semantic",
      `Range predicates on text field '${field.name}' are unsupported without a keyword multi-field`,
      field.loc,
      sql,
    );
  }
  if (type === "boolean" || type === "wildcard") {
    failRangeType(field, type, sql);
  }
  fail(
    "unsupported",
    `Field '${field.name}' has unsupported type '${type}' for a range predicate`,
    field.loc,
    sql,
  );
}

function assertUsage(field: FieldRef, type: string, usage: FieldUsage, sql: string): void {
  if (usage === "like" && !supportsLike(type)) {
    fail(
      "semantic",
      `LIKE is not supported on ${type} field '${field.name}'`,
      field.loc,
      sql,
    );
  }
  if (usage === "sort" && !supportsSort(type)) {
    fail(
      "semantic",
      `Cannot sort on ${type} field '${field.name}'`,
      field.loc,
      sql,
    );
  }
}

function failRangeType(field: FieldRef, type: string, sql: string): never {
  fail(
    "semantic",
    `Range predicates are unsupported on ${type} field '${field.name}'`,
    field.loc,
    sql,
  );
}

function keywordMultiField(
  walked: WalkedField,
  loc: SourcePosition,
  sql: string,
): ResolvedField | undefined {
  const fields = walked.mapping.fields;
  if (!fields) return undefined;
  const keyword = ownField(fields, "keyword");
  if (keyword && isKeywordLike(keyword.type ?? "keyword")) {
    return {
      path: `${walked.path}.keyword`,
      type: keyword.type ?? "keyword",
      requested: walked.path,
    };
  }
  const keywordLike = Object.entries(fields).filter(
    ([name, mapping]) => Object.hasOwn(fields, name) && isKeywordLike(mapping.type ?? ""),
  );
  if (keywordLike.length === 1) {
    const [name, mapping] = keywordLike[0]!;
    return {
      path: `${walked.path}.${name}`,
      type: mapping.type ?? "keyword",
      requested: walked.path,
    };
  }
  if (keywordLike.length > 1) {
    fail(
      "semantic",
      `Field '${walked.path}' has multiple keyword multi-fields (${keywordLike
        .map(([name]) => `${walked.path}.${name}`)
        .join(", ")}); specify one explicitly`,
      loc,
      sql,
    );
  }
  return undefined;
}

function walk(
  properties: Record<string, FieldMapping>,
  name: string,
  loc: SourcePosition,
  sql: string,
): WalkedField {
  const parts = name.split(".");
  let currentProps = properties;
  let mapping: FieldMapping | undefined;
  let path = "";
  let nested = false;
  let inMultiFields = false;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    path = path ? `${path}.${part}` : part;
    mapping = ownField(currentProps, part);
    if (!mapping) {
      fail("semantic", `Unknown field '${name}'`, loc, sql);
    }
    const type = mapping.type ?? (mapping.properties ? "object" : "object");
    if (type === "nested") nested = true;

    const last = i === parts.length - 1;
    if (last) break;

    if (mapping.properties && !inMultiFields) {
      currentProps = mapping.properties;
      continue;
    }
    if (mapping.fields) {
      currentProps = mapping.fields;
      inMultiFields = true;
      continue;
    }
    fail("semantic", `Unknown field '${name}'`, loc, sql);
  }

  return { mapping: mapping!, path, nested };
}

export function assertLiteralType(
  field: ResolvedField,
  value: string | number | boolean,
  loc: SourcePosition,
  sql: string,
): void {
  if (field.type === "unmapped") return;
  const valueType =
    typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";

  if (field.type === "boolean") {
    if (valueType !== "boolean") {
      fail(
        "semantic",
        `Field '${field.requested}' is boolean and cannot be compared to ${describeValue(value)}`,
        loc,
        sql,
      );
    }
    return;
  }
  if (isNumeric(field.type)) {
    if (valueType !== "number") {
      fail(
        "semantic",
        `Field '${field.requested}' is numeric and cannot be compared to ${describeValue(value)}`,
        loc,
        sql,
      );
    }
    return;
  }
  if (isDate(field.type)) {
    if (valueType === "boolean") {
      fail(
        "semantic",
        `Field '${field.requested}' is a date and cannot be compared to ${describeValue(value)}`,
        loc,
        sql,
      );
    }
    return;
  }
  if (
    isKeywordLike(field.type) ||
    isText(field.type) ||
    field.type === "wildcard" ||
    field.type === "ip" ||
    field.type === "version"
  ) {
    if (valueType === "boolean") {
      fail(
        "semantic",
        `Field '${field.requested}' cannot be compared to ${describeValue(value)}`,
        loc,
        sql,
      );
    }
  }
}

function describeValue(value: string | number | boolean): string {
  return typeof value === "string" ? `string ${JSON.stringify(value)}` : String(value);
}

function ownField(
  record: Record<string, FieldMapping>,
  key: string,
): FieldMapping | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = Object.getOwnPropertyDescriptor(record, key)?.value;
  if (!value || typeof value !== "object") return undefined;
  return value as FieldMapping;
}
