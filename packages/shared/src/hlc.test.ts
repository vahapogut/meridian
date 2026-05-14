import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HLC, serializeHLC, deserializeHLC, compareHLC,
  compareHLCStrings, maxHLC, generateNodeId, type HLCTimestamp
} from './hlc';

describe('HLC — Hybrid Logical Clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initialization', () => {
    it('should initialize with nodeId and optional time', () => {
      const clock = new HLC('node-1', 0);
      const ts = clock.peek();
      expect(ts.wallTime).toBe(0);
      expect(ts.counter).toBe(0);
      expect(ts.nodeId).toBe('node-1');
    });

    it('should default wallTime to 0', () => {
      const clock = new HLC('node-x');
      expect(clock.peek().wallTime).toBe(0);
    });
  });

  describe('now()', () => {
    it('should generate monotonically increasing timestamps', () => {
      const clock = new HLC('node-1', 100);
      const ts1 = clock.now();
      const ts2 = clock.now();
      expect(compareHLC(ts1, ts2)).toBeLessThan(0);
    });

    it('should increment counter when wall time does not advance', () => {
      vi.setSystemTime(1700000000000);
      const clock = new HLC('node-1', 1700000000000);
      const ts1 = clock.now();
      // First call: wallTime == physicalTime → counter increments (0 → 1)
      expect(ts1.counter).toBe(1);
      const ts2 = clock.now();
      // Same wall time (fake timers), counter increments again
      expect(ts2.counter).toBe(2);
      expect(ts2.wallTime).toBe(ts1.wallTime);
    });

    it('should reset counter when wall time advances', () => {
      vi.setSystemTime(1700000000000);
      const clock = new HLC('node-1', 1700000000000);
      clock.now(); // counter = 1
      // Advance wall time
      vi.setSystemTime(1700000000001);
      const ts2 = clock.now();
      expect(ts2.counter).toBe(0);
      expect(ts2.wallTime).toBe(1700000000001);
    });

    it('should increment counter when time is identical', () => {
      const clock = new HLC('node-1', 100);
      const ts1 = clock.now();
      const ts2 = clock.now();
      expect(serializeHLC(ts1) < serializeHLC(ts2)).toBe(true);
    });
  });

  describe('recv()', () => {
    it('should ensure monotonicity after receiving remote timestamp', () => {
      const clock1 = new HLC('node-1', 100);
      const clock2 = new HLC('node-2', 150);
      const ts2 = clock2.now();
      clock1.recv(ts2);
      const ts1Next = clock1.now();
      expect(serializeHLC(ts1Next) > serializeHLC(ts2)).toBe(true);
    });

    it('should handle remote time ahead of local (both in past)', () => {
      // Use wall times from the past so Date.now() doesn't interfere
      const clock = new HLC('node-1', 100);
      // Force local HLC to be at 100
      (clock as any)._wallTime = 100;
      (clock as any)._counter = 0;
      const remote: HLCTimestamp = { wallTime: 150, counter: 5, nodeId: 'node-2' };
      const result = clock.recv(remote);
      // When Date.now() > both, local physical clock takes over
      // So we just verify monotonicity
      expect(result.wallTime).toBeGreaterThanOrEqual(150);
    });

    it('should handle local HLC ahead of remote', () => {
      const now = Date.now();
      const clock = new HLC('node-1', now - 1000);
      const ts = clock.now();
      // Remote with older timestamp
      const remote: HLCTimestamp = { wallTime: now - 5000, counter: 5, nodeId: 'node-2' };
      const result = clock.recv(remote);
      expect(result.wallTime).toBeGreaterThanOrEqual(ts.wallTime);
    });

    it('should take max counter + 1 on same wall time', () => {
      const clock = new HLC('node-1', 100);
      const ts = clock.now();
      // Remote at same wall time, higher counter
      const remote: HLCTimestamp = { wallTime: ts.wallTime, counter: ts.counter + 10, nodeId: 'node-2' };
      const result = clock.recv(remote);
      expect(result.counter).toBeGreaterThan(ts.counter);
    });

    it('should handle receiving own timestamp', () => {
      const clock = new HLC('node-1', 100);
      const ts = clock.now();
      const result = clock.recv(ts);
      expect(result.wallTime).toBeGreaterThanOrEqual(ts.wallTime);
    });
  });

  describe('send()', () => {
    it('should be equivalent to now()', () => {
      const clock = new HLC('node-1');
      const sent = clock.send();
      const peeked = clock.peek();
      expect(sent.wallTime).toBe(peeked.wallTime);
      expect(sent.counter).toBe(peeked.counter);
    });
  });

  describe('peek()', () => {
    it('should not advance the clock', () => {
      const clock = new HLC('node-1', 100);
      const before = clock.peek();
      const after = clock.peek();
      expect(before.wallTime).toBe(after.wallTime);
      expect(before.counter).toBe(after.counter);
    });
  });

  describe('Serialization', () => {
    it('should serialize with correct format', () => {
      const ts: HLCTimestamp = { wallTime: 1715299200000, counter: 42, nodeId: 'abc12345' };
      expect(serializeHLC(ts)).toBe('1715299200000-0042-abc12345');
    });

    it('should zero-pad counter to 4 digits', () => {
      expect(serializeHLC({ wallTime: 100, counter: 1, nodeId: 'n' })).toBe('100-0001-n');
      expect(serializeHLC({ wallTime: 100, counter: 9999, nodeId: 'n' })).toBe('100-9999-n');
    });

    it('should correctly parse packed timestamps', () => {
      const parsed = deserializeHLC('100-0001-node-1');
      expect(parsed.wallTime).toBe(100);
      expect(parsed.counter).toBe(1);
      expect(parsed.nodeId).toBe('node-1');
    });

    it('should round-trip serialize/deserialize', () => {
      const original: HLCTimestamp = { wallTime: Date.now(), counter: 7, nodeId: 'test-node' };
      const packed = serializeHLC(original);
      const unpacked = deserializeHLC(packed);
      expect(unpacked).toEqual(original);
    });

    it('should throw on invalid HLC string', () => {
      expect(() => deserializeHLC('invalid')).toThrow();
      expect(() => deserializeHLC('')).toThrow();
      expect(() => deserializeHLC('100')).toThrow();
    });

    it('should handle nodeId containing dashes', () => {
      const ts: HLCTimestamp = { wallTime: 100, counter: 1, nodeId: 'node-with-dash' };
      const packed = serializeHLC(ts);
      const parsed = deserializeHLC(packed);
      expect(parsed.nodeId).toBe('node-with-dash');
    });
  });

  describe('Comparison', () => {
    it('should compare by wallTime first', () => {
      const a: HLCTimestamp = { wallTime: 100, counter: 0, nodeId: 'a' };
      const b: HLCTimestamp = { wallTime: 200, counter: 0, nodeId: 'a' };
      expect(compareHLC(a, b)).toBeLessThan(0);
      expect(compareHLC(b, a)).toBeGreaterThan(0);
    });

    it('should compare by counter when wallTime equal', () => {
      const a: HLCTimestamp = { wallTime: 100, counter: 1, nodeId: 'a' };
      const b: HLCTimestamp = { wallTime: 100, counter: 5, nodeId: 'a' };
      expect(compareHLC(a, b)).toBeLessThan(0);
    });

    it('should compare by nodeId when wallTime and counter equal', () => {
      const a: HLCTimestamp = { wallTime: 100, counter: 0, nodeId: 'a' };
      const b: HLCTimestamp = { wallTime: 100, counter: 0, nodeId: 'b' };
      expect(compareHLC(a, b)).toBeLessThan(0);
    });

    it('should return 0 for equal timestamps', () => {
      const a: HLCTimestamp = { wallTime: 100, counter: 0, nodeId: 'a' };
      expect(compareHLC(a, a)).toBe(0);
    });

    it('should compare serialized strings', () => {
      expect(compareHLCStrings('100-0000-a', '200-0000-a')).toBeLessThan(0);
      expect(compareHLCStrings('200-0000-a', '100-0000-a')).toBeGreaterThan(0);
      expect(compareHLCStrings('100-0000-a', '100-0000-a')).toBe(0);
    });

    it('maxHLC should return greater timestamp', () => {
      const a: HLCTimestamp = { wallTime: 100, counter: 0, nodeId: 'a' };
      const b: HLCTimestamp = { wallTime: 200, counter: 0, nodeId: 'b' };
      expect(maxHLC(a, b)).toEqual(b);
    });
  });

  describe('Node ID generation', () => {
    it('should generate 8-character alphanumeric IDs', () => {
      const id = generateNodeId();
      expect(id).toHaveLength(8);
      expect(id).toMatch(/^[a-z0-9]{8}$/);
    });

    it('should generate unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateNodeId()));
      expect(ids.size).toBe(100);
    });
  });
});
