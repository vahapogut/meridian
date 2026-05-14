/**
 * Meridian — Binary Codec (MessagePack-compatible)
 *
 * Zero-dependency binary encoder/decoder for CRDT operations and sync messages.
 * Reduces payload size by 40-60% compared to JSON, critical for mobile/edge.
 *
 * Supported types: null, boolean, number, string, array, object, binary
 *
 * Format (subset of MessagePack):
 * - nil:    0xc0
 * - false:  0xc2, true: 0xc3
 * - int:    0xcc (uint8), 0xcd (uint16), 0xce (uint32)
 * - float:  0xcb (float64)
 * - str:    0xd9 (str8), 0xda (str16)
 * - bin:    0xc4 (bin8), 0xc5 (bin16)
 * - array:  0xdc (array16)
 * - map:    0xde (map16)
 *
 * Usage:
 * ```ts
 * import { encodeBinary, decodeBinary } from 'meridian-shared';
 * const bytes = encodeBinary({ type: 'push', ops: [...] });
 * const msg = decodeBinary(bytes);
 * ```
 */

// ─── Constants ─────────────────────────────────────────────────────────────────

const NIL = 0xc0;
const FALSE = 0xc2;
const TRUE = 0xc3;
const BIN8 = 0xc4;
const BIN16 = 0xc5;
const FLOAT64 = 0xcb;
const UINT8 = 0xcc;
const UINT16 = 0xcd;
const UINT32 = 0xce;
const STR8 = 0xd9;
const STR16 = 0xda;
const ARRAY16 = 0xdc;
const MAP16 = 0xde;

// ─── Encoder ───────────────────────────────────────────────────────────────────

class BinaryEncoder {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  private write(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.totalLength += bytes.length;
  }

  private writeByte(b: number): void {
    this.write(new Uint8Array([b]));
  }

  private writeUint16(n: number): void {
    const buf = new Uint8Array(2);
    buf[0] = (n >> 8) & 0xff;
    buf[1] = n & 0xff;
    this.write(buf);
  }

  private writeUint32(n: number): void {
    const buf = new Uint8Array(4);
    buf[0] = (n >> 24) & 0xff;
    buf[1] = (n >> 16) & 0xff;
    buf[2] = (n >> 8) & 0xff;
    buf[3] = n & 0xff;
    this.write(buf);
  }

  private writeFloat64(n: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, n, false);
    this.write(new Uint8Array(buf));
  }

  encode(value: unknown): Uint8Array {
    this.chunks = [];
    this.totalLength = 0;
    this.encodeValue(value);
    return this.toUint8Array();
  }

  private encodeValue(value: unknown): void {
    if (value === null || value === undefined) {
      this.writeByte(NIL);
    } else if (typeof value === 'boolean') {
      this.writeByte(value ? TRUE : FALSE);
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
        if (value <= 0xff) { this.writeByte(UINT8); this.writeByte(value); }
        else if (value <= 0xffff) { this.writeByte(UINT16); this.writeUint16(value); }
        else { this.writeByte(UINT32); this.writeUint32(value); }
      } else {
        this.writeByte(FLOAT64);
        this.writeFloat64(value);
      }
    } else if (typeof value === 'string') {
      const bytes = new TextEncoder().encode(value);
      if (bytes.length <= 0xff) {
        this.writeByte(STR8);
        this.writeByte(bytes.length);
      } else {
        this.writeByte(STR16);
        this.writeUint16(bytes.length);
      }
      this.write(bytes);
    } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
      if (bytes.length <= 0xff) {
        this.writeByte(BIN8);
        this.writeByte(bytes.length);
      } else {
        this.writeByte(BIN16);
        this.writeUint16(bytes.length);
      }
      this.write(bytes);
    } else if (Array.isArray(value)) {
      if (value.length <= 0xffff) {
        this.writeByte(ARRAY16);
        this.writeUint16(value.length);
      }
      for (const item of value) this.encodeValue(item);
    } else if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length <= 0xffff) {
        this.writeByte(MAP16);
        this.writeUint16(entries.length);
      }
      for (const [k, v] of entries) {
        this.encodeValue(k);
        this.encodeValue(v);
      }
    }
  }

  private toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

// ─── Decoder ───────────────────────────────────────────────────────────────────

class BinaryDecoder {
  private view: DataView;
  private offset = 0;

  constructor(buffer: Uint8Array) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  decode(): unknown {
    return this.decodeValue();
  }

  private readByte(): number {
    return this.view.getUint8(this.offset++);
  }

  private readUint16(): number {
    const v = this.view.getUint16(this.offset);
    this.offset += 2;
    return v;
  }

  private readUint32(): number {
    const v = this.view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }

  private readBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length);
    this.offset += length;
    return bytes;
  }

  private decodeValue(): unknown {
    const tag = this.readByte();
    switch (tag) {
      case NIL: return null;
      case FALSE: return false;
      case TRUE: return true;
      case UINT8: return this.readByte();
      case UINT16: return this.readUint16();
      case UINT32: return this.readUint32();
      case FLOAT64: {
        const v = this.view.getFloat64(this.offset);
        this.offset += 8;
        return v;
      }
      case STR8: return new TextDecoder().decode(this.readBytes(this.readByte()));
      case STR16: return new TextDecoder().decode(this.readBytes(this.readUint16()));
      case BIN8: return this.readBytes(this.readByte());
      case BIN16: return this.readBytes(this.readUint16());
      case ARRAY16: {
        const len = this.readUint16();
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) arr.push(this.decodeValue());
        return arr;
      }
      case MAP16: {
        const len = this.readUint16();
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) {
          const key = this.decodeValue() as string;
          obj[key] = this.decodeValue();
        }
        return obj;
      }
      default: throw new Error(`[BinaryCodec] Unknown tag: 0x${tag.toString(16)}`);
    }
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

const encoder = new BinaryEncoder();
const decoder = new BinaryDecoder(new Uint8Array(0));

export function encodeBinary(value: unknown): Uint8Array {
  return encoder.encode(value);
}

export function decodeBinary(buffer: Uint8Array): unknown {
  return new BinaryDecoder(buffer).decode();
}

/** Estimate size savings vs JSON */
export function estimateBinarySavings(value: unknown): { jsonSize: number; binarySize: number; savings: string } {
  const jsonSize = new TextEncoder().encode(JSON.stringify(value)).length;
  const binarySize = encodeBinary(value).length;
  const pct = Math.round((1 - binarySize / jsonSize) * 100);
  return { jsonSize, binarySize, savings: `${pct}% smaller` };
}
