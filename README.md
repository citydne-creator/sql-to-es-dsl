# sql-to-es-dsl

Compile a **bounded SQL SELECT subset** into Elasticsearch Query DSL.

This library is an independent, original TypeScript compiler. It does **not**
talk to Elasticsearch, wrap Elasticsearch SQL, or reuse Elastic’s ELv2 SQL
implementation. The output is standard Query DSL (`term`, `terms`, `range`,
`exists`, `bool`, `wildcard`, `prefix`, `match_all`) that a caller can send
with any Elasticsearch client.

Intended consumers include browser and Node applications such as the Quick
Elasticsearch plugin. The compiler itself uses no Node-only APIs, no network,
and no filesystem.

## Install

```bash
npm install sql-to-es-dsl
```

## API

```ts
import { translate, SqlTranslationError } from "sql-to-es-dsl";

const result = translate(
  "SELECT title, status FROM logs WHERE status = 'active' ORDER BY ts DESC LIMIT 10 OFFSET 20",
  {
    mapping: {
      properties: {
        title: { type: "text", fields: { keyword: { type: "keyword" } } },
        status: { type: "keyword" },
        ts: { type: "date" },
      },
    },
  },
);

// result.index === "logs"
// result.query, result.sort, result.from, result.size, result._source
```

`translate(sql, options?)` returns:

| Field     | When                         |
|-----------|------------------------------|
| `index`   | Always; the `FROM` target    |
| `query`   | Always (`match_all` if no `WHERE`) |
| `_source` | Field list from `SELECT` (`SELECT *` omits it) |
| `sort`    | When `ORDER BY` is present   |
| `from`    | When `OFFSET` is present     |
| `size`    | When `LIMIT` is present      |

Failures throw `SqlTranslationError` with `code` (`syntax` \| `unsupported` \|
`semantic` \| `limit`) and `position` (`offset`, `line`, `column`). Error
messages and snippets are bounded so oversized input is not copied into the
exception.

## Supported grammar

```
select_stmt   ::= SELECT select_list FROM index
                  [ WHERE expr ]
                  [ ORDER BY order_item (, order_item)* ]
                  [ LIMIT int ] [ OFFSET int ]

select_list   ::= * | field (, field)*
order_item    ::= field [ ASC | DESC ]

expr          ::= or_expr
or_expr       ::= and_expr ( OR and_expr )*
and_expr      ::= not_expr ( AND not_expr )*
not_expr      ::= NOT not_expr | predicate
predicate     ::= ( expr )
                | field compare_op literal
                | field [ NOT ] IN ( literal (, literal)* )
                | field [ NOT ] BETWEEN literal AND literal
                | field [ NOT ] LIKE string
                | field IS [ NOT ] NULL

compare_op    ::= = | != | <> | > | >= | < | <=
```

Identifiers may be unquoted (`status`), dotted (`user.name`), double-quoted, or
backtick-quoted. String literals use SQL quoting (`'it''s'`). `--` line comments
and `/* */` block comments are skipped. An optional trailing semicolon is
allowed. `LIMIT` / `OFFSET` may appear in either order.

`FROM` names exactly one index. Quoted names may include ordinary hyphens and
dots (`"logs-2024"`, `"my.index"`). Wildcards, commas, slashes, backslashes,
colons, control characters, and the names `.` / `..` are rejected.

Integer literals, `LIMIT`, and `OFFSET` must be IEEE-754 safe integers
(`Number.isSafeInteger`; absolute value at most `2^53-1`). Finite fractional
literals use JavaScript `Number` semantics (binary floating point; `0.1` is
stored as an IEEE-754 double, not a decimal).

## Semantic decisions

**Equality** (`=`, `!=`, `<>`, `IN`) uses `term` / `terms`, never `match`.
Full-text `MATCH()` is out of scope.

**Mapping-aware fields.** When `options.mapping` is provided:

- Unknown fields are rejected.
- `keyword` and `constant_keyword` are queried on the field itself and support
  equality, `LIKE`, range, and sort.
- `ip` and `version` support equality, range, and sort; `LIKE` is rejected.
- `boolean` supports equality and sort; range and `LIKE` are rejected.
- `wildcard` supports equality and `LIKE`; range and sort are rejected.
- `text` equality, `LIKE`, `ORDER BY`, and ranges resolve to a `.keyword`
  multi-field when one exists. If several keyword multi-fields exist and none
  is named `keyword`, the compiler rejects the field as ambiguous rather than
  guessing.
- Bare `text` without a keyword multi-field is rejected.
- Fields under `nested` mappings are rejected in `WHERE` (a `nested` query
  would be required).
- Literal types are checked against the mapped field type.

Without a mapping, names are copied into the DSL as written. Missing mapping
types are the caller's responsibility; the compiler does not guess them.

**Ranges and `BETWEEN`.** Inclusive SQL `BETWEEN a AND b` becomes
`range` with `gte` / `lte`. `<`, `<=`, `>`, `>=` use the corresponding range
bounds.

**NULL.** `IS NULL` is two-valued: `bool.must_not` + `exists`. `IS NOT NULL`
→ `exists`. `NOT` around `IS [NOT] NULL` inverts those two forms. `= NULL` is
rejected; use `IS NULL`.

**Negation and three-valued logic.** `WHERE` keeps rows where the predicate is
TRUE, not UNKNOWN. Missing or JSON-null fields make comparisons UNKNOWN, so
`!=`, `<>`, `NOT IN`, `NOT BETWEEN`, `NOT LIKE`, and `NOT` of a comparison
emit `exists` plus `must_not` of the positive leaf. `NOT` over `AND` / `OR`
uses De Morgan rather than wrapping the whole tree in `must_not`, so
`NOT (a = 1 AND b = 2)` can still be TRUE when `a` is non-matching and `b` is
missing. Double `NOT` cancels. There is no global "all mentioned fields
exist" guard.

**LIKE** (backslash is the escape; there is no `ESCAPE` clause):

| SQL pattern | Query                          |
|-------------|--------------------------------|
| no `%` / `_` | `term`                        |
| `foo%` only  | `prefix` value `foo`          |
| other wildcards | `wildcard` (`%` → `*`, `_` → `?`) |

Literal `*`, `?`, and `\` in the SQL pattern are escaped in the wildcard
value. LIKE is case-sensitive and runs on the keyword (or keyword multi-field)
path, not on analyzed text. This is pattern matching, not Lucene
`query_string` parsing.

**Boolean composition.** `AND` binds tighter than `OR`. `NOT` applies to the
predicate that follows and is compiled with polarity (De Morgan, double-negation
elimination). Parentheses override. `AND` / `OR` flatten into a single
`bool.must` / `bool.should` (`minimum_should_match: 1`) when nested.

**Projection and pagination.** `SELECT a, b` sets `_source: ["a", "b"]`.
`SELECT *` leaves `_source` unset (Elasticsearch default). `ORDER BY` emits
`sort`. `LIMIT` is `size`; `OFFSET` is `from`.

**Not generated.** Script queries, Elasticsearch SQL translate API output,
runtime fields, aggregations, or Elastic-internal query forms.

## Rejected SQL

Each of these fails with a precise `unsupported` or `syntax` error at the
offending token:

- `JOIN` and multiple `FROM` indexes
- Subqueries, `EXISTS (...)`, `WITH` / CTEs, multiple statements
- `GROUP BY`, `HAVING`, aggregates, `SELECT DISTINCT`
- `UPDATE` / `DELETE` / `INSERT` / DDL
- Functions (`COUNT`, `MATCH`, `CAST`, …), `CASE`, aliases (`AS`)
- Arithmetic and field-to-field comparisons
- Empty `IN ()` lists; negative `LIMIT` / `OFFSET`
- SQL longer than 64 Ki UTF-16 code units, more than 8192 tokens, more than 64
  nested `NOT` / parentheses, more than 256 WHERE predicates, or more than 1024
  `IN` terms (`limit`)
- Integer literals or `LIMIT` / `OFFSET` outside the safe integer range

## Examples

```ts
translate("SELECT * FROM events WHERE level = 'error' AND latency_ms >= 500");
// {
//   index: "events",
//   query: {
//     bool: {
//       must: [
//         { term: { level: "error" } },
//         { range: { latency_ms: { gte: 500 } } },
//       ],
//     },
//   },
// }
```

```ts
translate("SELECT * FROM users WHERE name LIKE 'Al%'", {
  mapping: {
    properties: {
      name: { type: "text", fields: { keyword: { type: "keyword" } } },
    },
  },
});
// prefix query on name.keyword
```

## License and attribution

Original source in this repository is licensed under the **MIT License**
(see `LICENSE`). Elasticsearch is a trademark of Elasticsearch B.V. This
project is not affiliated with Elastic.

The compiler and tests were written from publicly documented Query DSL
behavior (term/range/exists/bool/wildcard/prefix). They are **not** a copy of
Elastic’s Elasticsearch SQL plugin, its ELv2-licensed sources, or its test
corpus.

## Input limits

Conservative fixed bounds; exceeding any of them throws `SqlTranslationError`
with `code: "limit"` rather than a raw `RangeError`:

| Bound | Maximum |
|-------|---------|
| SQL text | 65,536 UTF-16 code units |
| Tokens (excluding EOF) | 8,192 |
| Nested `NOT` / parentheses | 64 |
| WHERE predicate leaves | 256 |
| Literals in one `IN` list | 1,024 |

The predicate-leaf bound also caps left-deep `AND` / `OR` compile recursion.

These constants are exported as `MAX_SQL_LENGTH`, `MAX_TOKEN_COUNT`,
`MAX_EXPRESSION_DEPTH`, `MAX_PREDICATE_LEAVES`, and `MAX_IN_TERMS`.

## Limitations

- One index, one SELECT, no analytics.
- JavaScript `Number` values for numeric literals: safe integers only for
  integer forms; fractions follow IEEE-754 double semantics, not decimal or
  arbitrary-precision integers.
- No `nested` query generation, no geo predicates, no full-text `match`.
- Keyword resolution prefers a multi-field named `keyword`; it will not invent
  an analyzer or guess among several differently named exact subfields.
