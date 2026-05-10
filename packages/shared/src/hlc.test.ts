import { describe, it, expect } from 'vitest';
import { HLC, serializeHLC, deserializeHLC } from './hlc';

describe('Hybrid Logical Clocks (HLC)', () => {
  it('should initialize correctly', () => {
    const clock = new HLC('node-1', 0);
    const ts = clock.peek();
    expect(serializeHLC(ts)).toBe('0-0000-node-1');
  });

  it('should increment counter when time is identical', () => {
    const clock = new HLC('node-1', 100);
    const ts1 = clock.now();
    const ts2 = clock.now();
    
    // First call uses wall time 100
    // If the next call happens very fast, it might use the same wall time
    // If time is identical, counter should increment.
    expect(serializeHLC(ts1) < serializeHLC(ts2)).toBe(true);
  });

  it('should ensure monotonicity via recv()', () => {
    const clock1 = new HLC('node-1', 100);
    const clock2 = new HLC('node-2', 150);

    const ts2 = clock2.now(); // node-2 generated a timestamp at 150
    clock1.recv(ts2);         // node-1 receives it

    // Node 1's next timestamp must be strictly greater than ts2
    const ts1Next = clock1.now();
    expect(serializeHLC(ts1Next) > serializeHLC(ts2)).toBe(true);
  });

  it('should correctly parse packed timestamps', () => {
    const packed = '100-0001-node-1';
    const parsed = deserializeHLC(packed);
    
    expect(parsed.wallTime).toBe(100);
    expect(parsed.counter).toBe(1);
    expect(parsed.nodeId).toBe('node-1');
  });
});
