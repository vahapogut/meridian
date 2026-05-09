/**
 * Meridian — Schema Definition System
 *
 * Lightweight, zero-dependency schema definition with:
 * - Type-safe field definitions (z.string(), z.number(), etc.)
 * - Default values for additive migrations
 * - Schema versioning
 * - TypeScript type inference from schema
 */

// ─── Field Types ─────────────────────────────────────────────────────────────

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface FieldDefinition {
  type: FieldType;
  required: boolean;
  defaultValue?: unknown;
}

/** String field */
function string(): FieldDefinition {
  return { type: 'string', required: true };
}

/** Number field */
function number(): FieldDefinition {
  return { type: 'number', required: true };
}

/** Boolean field */
function boolean(): FieldDefinition {
  return { type: 'boolean', required: true };
}

/** Array field */
function array(): FieldDefinition {
  return { type: 'array', required: true };
}

/** Object/nested field */
function object(): FieldDefinition {
  return { type: 'object', required: true };
}

// ─── Field Modifiers ─────────────────────────────────────────────────────────

/**
 * Make a field optional with a default value.
 * Required for additive schema migrations.
 */
function withDefault(field: FieldDefinition, defaultValue: unknown): FieldDefinition {
  return { ...field, required: false, defaultValue };
}

/**
 * Schema field helpers — inspired by Zod's API but zero-dependency.
 *
 * Usage:
 * ```ts
 * import { z } from '@meridian-sync/shared';
 *
 * const fields = {
 *   id: z.string(),
 *   count: z.number().default(0),
 *   active: z.boolean().default(true),
 * };
 * ```
 */
function createFieldBuilder(type: FieldType) {
  const def: FieldDefinition = { type, required: true };

  return {
    ...def,
    default(value: unknown): FieldDefinition {
      return withDefault(def, value);
    },
  };
}

export const z = {
  string: () => createFieldBuilder('string'),
  number: () => createFieldBuilder('number'),
  boolean: () => createFieldBuilder('boolean'),
  array: () => createFieldBuilder('array'),
  object: () => createFieldBuilder('object'),
};

// ─── Schema Definition ──────────────────────────────────────────────────────

export interface CollectionSchema {
  [fieldName: string]: FieldDefinition | ReturnType<typeof createFieldBuilder>;
}

export interface SchemaDefinition {
  /** Schema version — increment on every schema change */
  version: number;
  /** Collection definitions */
  collections: Record<string, CollectionSchema>;
}

/**
 * Define a Meridian schema.
 *
 * Usage:
 * ```ts
 * const schema = defineSchema({
 *   version: 1,
 *   collections: {
 *     todos: {
 *       id: z.string(),
 *       title: z.string(),
 *       done: z.boolean().default(false),
 *       createdAt: z.number(),
 *     },
 *   },
 * });
 * ```
 */
export function defineSchema(definition: SchemaDefinition): SchemaDefinition {
  // Validate: every collection must have an 'id' field
  for (const [name, fields] of Object.entries(definition.collections)) {
    if (!('id' in fields)) {
      throw new Error(
        `[Meridian Schema] Collection "${name}" must have an "id" field.`
      );
    }
  }

  return definition;
}

// ─── Schema Utilities ────────────────────────────────────────────────────────

/**
 * Get the default values for a collection's fields.
 * Only includes fields that have explicit defaults.
 */
export function getDefaults(schema: CollectionSchema): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};

  for (const [field, def] of Object.entries(schema)) {
    if ('defaultValue' in def && def.defaultValue !== undefined) {
      defaults[field] = def.defaultValue;
    }
  }

  return defaults;
}

/**
 * Validate a document against a collection schema.
 * Fills in default values for missing optional fields.
 *
 * @returns Normalized document with defaults applied
 */
export function validateAndNormalize(
  doc: Record<string, unknown>,
  schema: CollectionSchema
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...doc };
  const defaults = getDefaults(schema);

  // Apply defaults for missing fields
  for (const [field, defaultValue] of Object.entries(defaults)) {
    if (!(field in result) || result[field] === undefined) {
      result[field] = defaultValue;
    }
  }

  // Type validation (runtime)
  for (const [field, def] of Object.entries(schema)) {
    const value = result[field];

    // Skip undefined optional fields
    if (value === undefined) {
      if (def.required) {
        throw new Error(
          `[Meridian Schema] Required field "${field}" is missing.`
        );
      }
      continue;
    }

    // Type check
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== def.type) {
      throw new Error(
        `[Meridian Schema] Field "${field}" expected type "${def.type}" but got "${actualType}".`
      );
    }
  }

  return result;
}

/**
 * Get all field names for a collection, including system fields.
 */
export function getFieldNames(schema: CollectionSchema): string[] {
  return Object.keys(schema);
}

/**
 * Map Meridian field types to PostgreSQL column types.
 */
export function fieldTypeToSQL(type: FieldType): string {
  switch (type) {
    case 'string': return 'TEXT';
    case 'number': return 'NUMERIC';
    case 'boolean': return 'BOOLEAN';
    case 'array': return 'JSONB';
    case 'object': return 'JSONB';
    default: return 'TEXT';
  }
}

// ─── Type Inference ──────────────────────────────────────────────────────────

/**
 * Infer TypeScript type from a field definition.
 * Used at compile time only.
 */
type InferFieldType<F extends FieldDefinition> =
  F['type'] extends 'string' ? string :
  F['type'] extends 'number' ? number :
  F['type'] extends 'boolean' ? boolean :
  F['type'] extends 'array' ? unknown[] :
  F['type'] extends 'object' ? Record<string, unknown> :
  unknown;

/**
 * Infer a document type from a collection schema.
 */
export type InferDocument<S extends CollectionSchema> = {
  [K in keyof S]: InferFieldType<S[K] extends FieldDefinition ? S[K] : FieldDefinition>;
};
