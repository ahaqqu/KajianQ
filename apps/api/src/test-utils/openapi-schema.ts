/**
 * The string-leaf walk behind the feedback request audit.
 *
 * The body ceiling is a byte bound while the published schema speaks in
 * `maxLength` and `format`. The durable claim is that every string the request
 * admits carries a published bound, so one walk over the served schema yields
 * both that audit and the worst-case byte budget the ceiling must clear. A new
 * string field cannot pass by being absent from a hand-maintained list.
 */

/** The OpenAPI 3.1 schema subset the API emits; unknown keys are ignored. */
export type OpenApiSchema = {
  $ref?: string;
  type?: string | string[];
  anyOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  maxLength?: number;
  format?: string;
  pattern?: string;
  const?: unknown;
  enum?: unknown[];
  description?: string;
  not?: unknown;
};

/** One string leaf and the bound its schema publishes. */
export type StringLeaf = {
  /** Dot/bracket path from the audited schema, for a failure message. */
  path: string;
  schema: OpenApiSchema;
  /** A `const` or all-string `enum`: the value set bounds the length. */
  fixed: boolean;
  maxLength?: number;
  format?: string;
};

/**
 * The worst-case wire bytes one code point can cost inside a JSON string: an
 * astral character is two `\uXXXX` escapes, 12 ASCII bytes.
 */
export const ESCAPED_BYTES_PER_CODE_POINT = 12;

/** The serialized width of a format whose value is bounded by definition. */
const BOUNDED_FORMAT_BYTES: Record<string, number> = { uuid: 36 };

/** The number literal budget: enough for any finite double the schema admits. */
const NUMBER_BYTES = 24;

/** Every string leaf in `schema`, in document order. */
export function stringLeaves(schema: OpenApiSchema, path = "$"): StringLeaf[] {
  const leaves: StringLeaf[] = [];
  collectStringLeaves(schema, path, leaves);
  return leaves;
}

/**
 * The leaves that publish no length bound and no allowed bounded format. An
 * empty result is the audit's claim: the request cannot admit an unbounded
 * string.
 */
export function unboundedStringLeaves(
  schema: OpenApiSchema,
  allowedFormats: readonly string[],
): StringLeaf[] {
  const allowed = new Set(allowedFormats);
  return stringLeaves(schema).filter(
    (leaf) =>
      !leaf.fixed &&
      leaf.maxLength === undefined &&
      (leaf.format === undefined || !allowed.has(leaf.format)),
  );
}

/**
 * The largest serialized body a schema-valid value can produce, with every
 * string at its published `maxLength` and every code point escaped. Throws
 * when a leaf is unbounded or an array's cardinality is unbounded, so a future
 * field cannot quietly make the budget a lie.
 */
export function worstCaseBodyBytes(
  schema: OpenApiSchema,
  allowedFormats: readonly string[] = [],
): number {
  const unbounded = unboundedStringLeaves(schema, allowedFormats);
  if (unbounded.length > 0) {
    throw new Error(
      `Cannot derive a body budget with unbounded string leaves: ${unbounded
        .map((leaf) => leaf.path)
        .join(", ")}`,
    );
  }
  return worstCaseValueBytes(schema, "$", new Set(allowedFormats));
}

function collectStringLeaves(schema: OpenApiSchema, path: string, leaves: StringLeaf[]): void {
  if (schema.$ref !== undefined) {
    throw new Error(`Cannot walk a $ref at ${path}`);
  }
  schema.anyOf?.forEach((option, index) =>
    collectStringLeaves(option, `${path}.anyOf[${index}]`, leaves),
  );
  schema.oneOf?.forEach((option, index) =>
    collectStringLeaves(option, `${path}.oneOf[${index}]`, leaves),
  );
  schema.allOf?.forEach((option, index) =>
    collectStringLeaves(option, `${path}.allOf[${index}]`, leaves),
  );
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    collectStringLeaves(child, `${path}.properties.${key}`, leaves);
  }
  if (schema.items !== undefined) collectStringLeaves(schema.items, `${path}.items`, leaves);
  if (isStringNode(schema)) {
    leaves.push({
      path,
      schema,
      fixed: isFixedString(schema),
      ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}),
      ...(schema.format !== undefined ? { format: schema.format } : {}),
    });
  }
}

function isStringNode(schema: OpenApiSchema): boolean {
  if (Array.isArray(schema.type)) return schema.type.includes("string");
  if (schema.type === "string") return true;
  if (schema.type !== undefined) return false;
  if (typeof schema.const === "string") return true;
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((value) => typeof value === "string")
  ) {
    return true;
  }
  return (
    schema.maxLength !== undefined || schema.format !== undefined || schema.pattern !== undefined
  );
}

function isFixedString(schema: OpenApiSchema): boolean {
  if (typeof schema.const === "string") return true;
  return (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    schema.enum.every((value) => typeof value === "string")
  );
}

function isForbiddenProperty(schema: OpenApiSchema): boolean {
  return Object.keys(schema).length === 1 && schema.not !== undefined;
}

function worstCaseValueBytes(
  schema: OpenApiSchema,
  path: string,
  allowedFormats: ReadonlySet<string>,
): number {
  if (schema.$ref !== undefined) throw new Error(`Cannot size a $ref at ${path}`);
  if (schema.not !== undefined && isForbiddenProperty(schema)) return 0;
  if (schema.anyOf !== undefined) {
    return Math.max(
      ...schema.anyOf.map((option, index) =>
        worstCaseValueBytes(option, `${path}.anyOf[${index}]`, allowedFormats),
      ),
    );
  }
  if (schema.oneOf !== undefined) {
    return Math.max(
      ...schema.oneOf.map((option, index) =>
        worstCaseValueBytes(option, `${path}.oneOf[${index}]`, allowedFormats),
      ),
    );
  }
  if (schema.allOf !== undefined) {
    throw new Error(`Cannot derive a body budget for allOf at ${path}`);
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((candidate) => candidate !== "null")
    : schema.type;
  if (type === "string" || (type === undefined && isStringNode(schema))) {
    return stringValueBytes(schema, path, allowedFormats);
  }
  if (type === "object") {
    let total = 2; // braces
    let present = 0;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (isForbiddenProperty(child)) continue;
      if (present > 0) total += 1; // comma
      total += JSON.stringify(key).length + 1; // quoted key and colon
      total += worstCaseValueBytes(child, `${path}.properties.${key}`, allowedFormats);
      present += 1;
    }
    return total;
  }
  if (type === "integer" || type === "number") return NUMBER_BYTES;
  if (type === "boolean") return 5;
  if (type === "null") return 4;
  if (type === "array") {
    throw new Error(`Cannot derive a body budget for unbounded array cardinality at ${path}`);
  }
  if (schema.const !== undefined) return JSON.stringify(schema.const).length;
  if (schema.enum !== undefined) {
    return Math.max(...schema.enum.map((value) => JSON.stringify(value).length));
  }
  throw new Error(`Cannot derive a body budget for the node at ${path}`);
}

function stringValueBytes(
  schema: OpenApiSchema,
  path: string,
  allowedFormats: ReadonlySet<string>,
): number {
  if (typeof schema.const === "string") return JSON.stringify(schema.const).length;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((value): value is string => typeof value === "string");
    if (values.length !== schema.enum.length) {
      throw new Error(`Cannot size the mixed enum at ${path}`);
    }
    return Math.max(...values.map((value) => JSON.stringify(value).length));
  }
  if (schema.maxLength !== undefined) {
    return 2 + schema.maxLength * ESCAPED_BYTES_PER_CODE_POINT;
  }
  if (schema.format !== undefined && allowedFormats.has(schema.format)) {
    const bytes = BOUNDED_FORMAT_BYTES[schema.format];
    if (bytes === undefined) {
      throw new Error(`No byte bound for the allowed format "${schema.format}" at ${path}`);
    }
    return 2 + bytes;
  }
  throw new Error(`Unbounded string leaf at ${path}`);
}
