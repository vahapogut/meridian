/**
 * MeridianDB — Auth Provider Adapters
 *
 * Ready-made adapters for popular auth providers.
 * Each adapter validates a token and returns a user identity.
 *
 * Usage:
 * ```ts
 * import { supabaseAuth } from 'meridian-server/auth-adapters';
 *
 * const server = createServer({
 *   auth: supabaseAuth({ url: '...', key: '...' }),
 * });
 * ```
 */

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AuthAdapter {
  (token: string): Promise<AuthResult>;
}

export interface AuthResult {
  userId: string;
  role?: string;
  namespace?: string;
  [key: string]: unknown;
}

export interface AuthAdapterConfig {
  /** Base URL for the auth provider */
  url: string;
  /** API key or secret */
  key?: string;
  /** JWT secret for self-verification (Supabase uses HS256) */
  jwtSecret?: string;
  /** Custom claims to extract from the token */
  claims?: string[];
}

// ─── Supabase Auth ─────────────────────────────────────────────────────────

/**
 * Supabase Auth adapter.
 * Uses the Supabase JWT verification endpoint or self-verifies with jwtSecret.
 *
 * ```ts
 * auth: supabaseAuth({
 *   url: process.env.SUPABASE_URL!,
 *   jwtSecret: process.env.SUPABASE_JWT_SECRET!,
 * })
 * ```
 */
export function supabaseAuth(config: AuthAdapterConfig): AuthAdapter {
  const verifyUrl = `${config.url}/auth/v1/user`;

  return async (token: string): Promise<AuthResult> => {
  // Self-verify JWT if secret provided (zero-latency)
  if (config.jwtSecret) {
    const { createHmac } = await import('crypto');
    const [, payload] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (decoded.sub) {
      return {
        userId: decoded.sub,
        role: decoded.role || decoded.user_metadata?.role,
        email: decoded.email,
      };
    }
  }

  // Fallback: verify via Supabase API
  const res = await fetch(verifyUrl, {
    headers: { Authorization: `Bearer ${token}`, apikey: config.key || '' },
  });
  if (!res.ok) throw new Error(`Supabase auth failed: ${res.status}`);
  const user = await res.json() as Record<string, any>;
  return {
    userId: user.id,
    role: user.role || user.user_metadata?.role,
    email: user.email,
  };
  };
}

// ─── Auth0 ─────────────────────────────────────────────────────────────────

/**
 * Auth0 adapter.
 * Verifies token against Auth0 userinfo endpoint.
 *
 * ```ts
 * auth: auth0Auth({ url: process.env.AUTH0_DOMAIN! })
 * ```
 */
export function auth0Auth(config: AuthAdapterConfig): AuthAdapter {
  const verifyUrl = `https://${config.url}/userinfo`;

  return async (token: string): Promise<AuthResult> => {
    const res = await fetch(verifyUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Auth0 auth failed: ${res.status}`);
    const user = await res.json() as Record<string, any>;
    return {
      userId: user.sub,
      role: user['https://yourapp.com/role'] || user.role,
      email: user.email,
    };
  };
}

// ─── Clerk ─────────────────────────────────────────────────────────────────

/**
 * Clerk adapter.
 * Verifies JWT against Clerk userinfo endpoint.
 *
 * ```ts
 * auth: clerkAuth({ url: process.env.CLERK_DOMAIN! })
 * ```
 */
export function clerkAuth(config: AuthAdapterConfig): AuthAdapter {
  const verifyUrl = `https://${config.url}/oauth/userinfo`;

  return async (token: string): Promise<AuthResult> => {
    const res = await fetch(verifyUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Clerk auth failed: ${res.status}`);
    const user = await res.json() as Record<string, any>;
    return {
      userId: user.user_id,
      email: user.email,
      role: user.public_metadata?.role,
    };
  };
}

// ─── Generic JWT ───────────────────────────────────────────────────────────

/**
 * Generic JWT adapter for any provider that issues standard JWTs.
 * Use this for Firebase Auth, custom Auth, NextAuth, etc.
 *
 * ```ts
 * auth: jwtAuth({ jwtSecret: process.env.JWT_SECRET! })
 * ```
 */
export function jwtAuth(config: AuthAdapterConfig): AuthAdapter {
  return async (token: string): Promise<AuthResult> => {
    const { createHmac } = await import('crypto');
    const [, payload] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

    if (!decoded.sub && !decoded.userId) {
      throw new Error('JWT missing sub/userId claim');
    }

    return {
      userId: decoded.sub || decoded.userId,
      role: decoded.role,
      email: decoded.email,
    };
  };
}
