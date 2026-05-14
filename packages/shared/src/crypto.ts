/**
 * Meridian — E2E Encryption Layer
 *
 * Field-level AES-256-GCM encryption for:
 * - IndexedDB at-rest encryption (browser)
 * - WebSocket in-transit encryption (second layer over TLS)
 * - Server-side blind storage (server can't read field values)
 *
 * Key derivation: PBKDF2 with 100K iterations
 * Encryption: AES-256-GCM with random 12-byte IV per operation
 */

// ─── Browser Crypto API ─────────────────────────────────────────────────────

const ENC_ALGO = 'AES-GCM';
const KEY_ALGO = 'PBKDF2';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96-bit for GCM
const ITERATIONS = 100_000;
const SALT_LENGTH = 16;

function getSubtle(): SubtleCrypto {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('[Meridian Crypto] Web Crypto API not available. E2E encryption requires a secure context (HTTPS or localhost).');
}

/** Pack IV + ciphertext into a single Uint8Array for storage */
function packCiphertext(iv: Uint8Array, ciphertext: ArrayBuffer): Uint8Array {
  const cipherBytes = new Uint8Array(ciphertext);
  const packed = new Uint8Array(IV_LENGTH + cipherBytes.length);
  packed.set(iv, 0);
  packed.set(cipherBytes, IV_LENGTH);
  return packed;
}

/** Unpack IV + ciphertext from stored format */
function unpackCiphertext(packed: Uint8Array): { iv: Uint8Array; ciphertext: ArrayBuffer } {
  const iv = packed.slice(0, IV_LENGTH);
  const ciphertext = packed.slice(IV_LENGTH).buffer.slice(0);
  return { iv, ciphertext };
}

// ─── Key Management ─────────────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM key from a password and salt.
 */
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = getSubtle();
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey(
    'raw',
    enc.encode(password) as BufferSource,
    KEY_ALGO,
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: KEY_ALGO,
      salt: salt as BufferSource,
      iterations: ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: ENC_ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

// ─── Encryption ─────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext value with AES-256-GCM.
 * Returns Uint8Array containing [IV || ciphertext].
 */
export async function encryptValue(key: CryptoKey, plaintext: string): Promise<Uint8Array> {
  const subtle = getSubtle();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await subtle.encrypt(
    { name: ENC_ALGO, iv: iv as BufferSource },
    key,
    encoded as BufferSource
  );
  return packCiphertext(iv, ciphertext);
}

/**
 * Decrypt a value encrypted with encryptValue().
 */
export async function decryptValue(key: CryptoKey, packed: Uint8Array): Promise<string> {
  const subtle = getSubtle();
  const { iv, ciphertext } = unpackCiphertext(packed);
  const decrypted = await subtle.decrypt(
    { name: ENC_ALGO, iv: iv as BufferSource },
    key,
    ciphertext as BufferSource
  );
  return new TextDecoder().decode(decrypted);
}

// ─── Field-Level Encryption ─────────────────────────────────────────────────

/**
 * Encrypt specific fields in a document for blind server storage.
 *
 * ```ts
 * const encrypted = await encryptFields(doc, key, ['title', 'description']);
 * // { title: ArrayBuffer, description: ArrayBuffer, done: false }
 * ```
 */
export async function encryptFields(
  doc: Record<string, unknown>,
  key: CryptoKey,
  fields: string[]
): Promise<Record<string, unknown>> {
  const result = { ...doc };
  for (const field of fields) {
    const value = doc[field];
    if (typeof value === 'string') {
      result[field] = await encryptValue(key, value);
    }
  }
  return result;
}

/**
 * Decrypt specific fields in a document.
 */
export async function decryptFields(
  doc: Record<string, unknown>,
  key: CryptoKey,
  fields: string[]
): Promise<Record<string, unknown>> {
  const result = { ...doc };
  for (const field of fields) {
    const value = doc[field];
    if (value instanceof Uint8Array) {
      result[field] = await decryptValue(key, value);
    }
  }
  return result;
}

// ─── Transport Encryption ───────────────────────────────────────────────────

/**
 * Encrypt a CRDT operation for transport over WebSocket.
 * Adds a second encryption layer on top of TLS.
 */
export async function encryptOperation(
  key: CryptoKey,
  op: { value: unknown }
): Promise<{ value: Uint8Array }> {
  const serialized = JSON.stringify(op.value);
  const encrypted = await encryptValue(key, serialized);
  return { value: encrypted };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a random encryption key for demo/development.
 * In production, use a proper key management system.
 */
export function generateRandomPassword(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(length)),
    (b) => chars[b % chars.length]
  ).join('');
}

/**
 * Encode a Uint8Array to base64 for JSON serialization.
 */
export function uint8ToBase64(data: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string back to Uint8Array.
 */
export function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
