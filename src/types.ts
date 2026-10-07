/** Source location in the original SQL text. */
export interface SourcePosition {
  /** 0-based UTF-16 offset into the SQL string. */
  offset: number;
  /** 1-based line number. */
  line: number;
  /** 1-based column number (UTF-16 code units). */
  column: number;
}

/** Elasticsearch field mapping fragment used for resolution. */
export interface FieldMapping {
  type?: string;
  fields?: Record<string, FieldMapping>;
  properties?: Record<string, FieldMapping>;
}

/**
 * Mapping input accepted by {@link translate}.
 * Either a properties object, or `{ mappings: { properties } }`.
 */
export type MappingInput =
  | { properties: Record<string, FieldMapping> }
  | { mappings: { properties?: Record<string, FieldMapping> } };

export interface TranslateOptions {
  /**
   * Index mapping used to resolve keyword multi-fields, reject ambiguous
   * text equality, and type-check literals. When omitted, field names are
   * used as written and literals keep their SQL types.
   */
  mapping?: MappingInput;
}

export type EsQuery = Record<string, unknown>;
export type EsSortClause = Record<string, { order: "asc" | "desc" }>;

/**
 * Search-body fragment produced from a SELECT statement.
 * Spread into an Elasticsearch search request; `index` is the FROM target.
 */
export interface TranslateResult {
  index: string;
  query: EsQuery;
  sort?: EsSortClause[];
  from?: number;
  size?: number;
  _source?: true | string[];
}

export type SqlTranslationErrorCode = "syntax" | "unsupported" | "semantic";
