/**
 * Meridian — Permission Rules DSL
 *
 * Firebase-like security rules for collections.
 * Define who can read/write which fields, with
 * row-level access control based on auth context.
 *
 * Usage:
 * ```ts
 * const rules = defineRules({
 *   todos: {
 *     read: (auth, doc) => auth != null,
 *     write: (auth, doc) => auth?.userId === doc.ownerId,
 *   },
 * });
 * ```
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuthContext {
  userId: string;
  role?: string;
  [key: string]: unknown;
}

export interface DocAccessContext {
  /** Document being accessed (null for create/pre-query) */
  existing: Record<string, unknown> | null;
  /** Fields being written (null for read/delete) */
  incoming: Record<string, unknown> | null;
}

export type RuleFn = (auth: AuthContext | null, doc: DocAccessContext) => boolean | Promise<boolean>;

export interface CollectionRules {
  /** Read permission — called on find/findOne/live/subscribe */
  read?: RuleFn;
  /** Write permission — called on put/update/delete */
  write?: RuleFn;
}

export interface PermissionRules {
  [collection: string]: CollectionRules;
}

// ─── Rule Builder ────────────────────────────────────────────────────────────

/**
 * Define permission rules for collections.
 * Returns a PermissionRules object that can be passed to createServer.
 */
export function defineRules(rules: PermissionRules): PermissionRules {
  return rules;
}

// ─── Rule Evaluator ──────────────────────────────────────────────────────────

export class RuleEvaluator {
  private rules: PermissionRules;

  constructor(rules: PermissionRules) {
    this.rules = rules;
  }

  /**
   * Check if an operation is allowed on a collection.
   *
   * @param collection - Collection name
   * @param operation - 'read' or 'write'
   * @param auth - Auth context (null = unauthenticated)
   * @param doc - Document context
   * @returns true if allowed
   */
  async check(
    collection: string,
    operation: 'read' | 'write',
    auth: AuthContext | null,
    doc: DocAccessContext = { existing: null, incoming: null }
  ): Promise<boolean> {
    const collectionRules = this.rules[collection];
    if (!collectionRules) {
      // No rules defined = allow all (default open)
      return true;
    }

    const rule = collectionRules[operation];
    if (!rule) {
      return true;
    }

    try {
      return await rule(auth, doc);
    } catch {
      return false;
    }
  }

  /**
   * Filter a list of documents to only include
   * those the user is allowed to read.
   */
  async filterRead(
    collection: string,
    auth: AuthContext | null,
    docs: Record<string, unknown>[]
  ): Promise<Record<string, unknown>[]> {
    const allowed: Record<string, unknown>[] = [];

    for (const doc of docs) {
      const canRead = await this.check(collection, 'read', auth, {
        existing: doc,
        incoming: null,
      });
      if (canRead) {
        allowed.push(doc);
      }
    }

    return allowed;
  }

  /**
   * Check if a write operation is allowed.
   */
  async canWrite(
    collection: string,
    auth: AuthContext | null,
    existing: Record<string, unknown> | null,
    incoming: Record<string, unknown>
  ): Promise<boolean> {
    return this.check(collection, 'write', auth, { existing, incoming });
  }
}
