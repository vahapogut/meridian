import { describe, it, expect } from 'vitest';
import { createLWWMap, extractValues, isDeleted, mergeLWWMaps, createRegister, DELETED_FIELD } from './crdt';
import { HLC, serializeHLC } from './hlc';

describe('LWW Map (Conflict-Free Replicated Data Type)', () => {
  it('should initialize empty', () => {
    const map = createLWWMap({}, '0-0000-node', 'node-1');
    expect(extractValues(map)).toEqual({});
    expect(isDeleted(map)).toBe(false);
  });

  it('should set fields and update state', () => {
    const ts1 = serializeHLC(new HLC('node-1').now());
    const map = createLWWMap({ title: 'Initial Title' }, ts1, 'node-1');
    
    expect(extractValues(map)).toEqual({ title: 'Initial Title' });
    expect(map.title.hlc).toBe(ts1);
  });

  it('should resolve conflicts using Last-Writer-Wins (LWW)', () => {
    const tsOld = '100-0000-node-1';
    const tsNew = '200-0000-node-2';

    // Set with newer timestamp first (simulating out of order delivery)
    const map1 = createLWWMap({ title: 'New Title' }, tsNew, 'node-2');
    
    // Attempt to merge with older timestamp map
    const map2 = createLWWMap({ title: 'Old Title' }, tsOld, 'node-1');

    const result = mergeLWWMaps(map1, map2);

    // The newer timestamp should have won, rejecting the old one
    expect(extractValues(result.merged).title).toBe('New Title');
    expect(result.merged.title.hlc).toBe(tsNew);
  });

  it('should handle field-level convergence independently', () => {
    const ts1 = '100-0000-node-1';
    const ts2 = '200-0000-node-2';

    const map1 = createLWWMap({ title: 'Node 1 Title' }, ts1, 'node-1');
    const map2 = createLWWMap({ status: 'Node 2 Status' }, ts2, 'node-2');

    const result = mergeLWWMaps(map1, map2);

    // Both fields should exist because they are tracked independently
    const state = extractValues(result.merged);
    expect(state.title).toBe('Node 1 Title');
    expect(state.status).toBe('Node 2 Status');
  });

  it('should support tombstoning (soft delete)', () => {
    const ts = serializeHLC(new HLC('node-1').now());
    const map = createLWWMap({ title: 'To be deleted' }, ts, 'node-1');
    
    const deleteTs = serializeHLC(new HLC('node-1', Date.now() + 100).now());
    map[DELETED_FIELD] = createRegister(true, deleteTs, 'node-1');

    expect(isDeleted(map)).toBe(true);
  });
});
