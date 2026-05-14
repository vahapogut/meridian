import { describe, it, expect } from 'vitest';
import {
  createLWWMap, extractValues, isDeleted, mergeLWWMaps,
  createRegister, mergeRegisters, extractMetadata, reconstructLWWMap,
  getLatestHLC, DELETED_FIELD
} from './crdt';
import { HLC, serializeHLC } from './hlc';

describe('LWW Register', () => {
  it('should create register with value and metadata', () => {
    const reg = createRegister('hello', '100-0001-node', 'node');
    expect(reg.value).toBe('hello');
    expect(reg.hlc).toBe('100-0001-node');
    expect(reg.nodeId).toBe('node');
  });

  it('should merge registers — higher HLC wins', () => {
    const old = createRegister('old', '100-0000-a', 'a');
    const newer = createRegister('new', '200-0000-b', 'b');
    const result = mergeRegisters(old, newer);
    expect(result.value).toBe('new');
    expect(result.nodeId).toBe('b');
  });

  it('should merge registers — lower HLC loses', () => {
    const older = createRegister('old', '100-0000-a', 'a');
    const newer = createRegister('new', '200-0000-b', 'b');
    const result = mergeRegisters(newer, older);
    expect(result.value).toBe('new');
  });

  it('should tie-break on HLC equality using nodeId', () => {
    const a = createRegister('value-a', '100-0000-a', 'a');
    const b = createRegister('value-b', '100-0000-b', 'b');
    const result = mergeRegisters(a, b);
    expect(result.value).toBe('value-b'); // 'b' > 'a' lexicographically
    expect(result.nodeId).toBe('b');
  });

  it('should handle same nodeId tie-break (identity)', () => {
    const a1 = createRegister('first', '100-0000-a', 'a');
    const a2 = createRegister('second', '100-0000-a', 'a');
    const result = mergeRegisters(a1, a2);
    // When both HLC and nodeId are equal, local wins (first arg = a1)
    expect(result.value).toBe('first');
  });
});

describe('LWW Map', () => {
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

  it('should always include __deleted field', () => {
    const map = createLWWMap({ title: 'x' }, '100-0000-n', 'n');
    expect(map[DELETED_FIELD]).toBeDefined();
    expect(map[DELETED_FIELD].value).toBe(false);
  });

  it('should resolve conflicts using LWW', () => {
    const tsOld = '100-0000-node-1';
    const tsNew = '200-0000-node-2';
    const map1 = createLWWMap({ title: 'New Title' }, tsNew, 'node-2');
    const map2 = createLWWMap({ title: 'Old Title' }, tsOld, 'node-1');
    const result = mergeLWWMaps(map1, map2);
    expect(extractValues(result.merged).title).toBe('New Title');
  });

  it('should handle field-level convergence independently', () => {
    const ts1 = '100-0000-node-1';
    const ts2 = '200-0000-node-2';
    const map1 = createLWWMap({ title: 'Node 1 Title' }, ts1, 'node-1');
    const map2 = createLWWMap({ status: 'Node 2 Status' }, ts2, 'node-2');
    const result = mergeLWWMaps(map1, map2);
    const state = extractValues(result.merged);
    expect(state.title).toBe('Node 1 Title');
    expect(state.status).toBe('Node 2 Status');
  });

  it('should detect conflicts when values differ', () => {
    const ts1 = '100-0000-a';
    const ts2 = '200-0000-b';
    const map1 = createLWWMap({ title: 'A' }, ts1, 'a');
    const map2 = createLWWMap({ title: 'B' }, ts2, 'b');
    const result = mergeLWWMaps(map1, map2);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].field).toBe('title');
    expect(result.conflicts[0].winnerValue).toBe('B');
    expect(result.conflicts[0].loserValue).toBe('A');
  });

  it('should not flag conflict when values are identical', () => {
    const ts1 = '100-0000-a';
    const ts2 = '200-0000-b';
    const map1 = createLWWMap({ title: 'Same' }, ts1, 'a');
    const map2 = createLWWMap({ title: 'Same' }, ts2, 'b');
    const result = mergeLWWMaps(map1, map2);
    expect(result.conflicts.length).toBe(0);
  });

  it('should support tombstoning (soft delete)', () => {
    const ts = serializeHLC(new HLC('node-1').now());
    const map = createLWWMap({ title: 'To be deleted' }, ts, 'node-1');
    const deleteTs = serializeHLC(new HLC('node-1', Date.now() + 100).now());
    map[DELETED_FIELD] = createRegister(true, deleteTs, 'node-1');
    expect(isDeleted(map)).toBe(true);
  });

  it('should merge __deleted field correctly', () => {
    const ts = '100-0000-a';
    const map1 = createLWWMap({ title: 'x' }, ts, 'a');
    const map2 = createLWWMap({ title: 'x' }, ts, 'a');
    map2[DELETED_FIELD] = createRegister(true, '200-0000-b', 'b');
    const result = mergeLWWMaps(map1, map2);
    expect(isDeleted(result.merged)).toBe(true);
  });

  it('should handle map with only extra fields in remote', () => {
    const map1 = createLWWMap({ title: 'x' }, '100-0000-a', 'a');
    const map2 = createLWWMap({ title: 'x', extra: 'y' }, '200-0000-b', 'b');
    const result = mergeLWWMaps(map1, map2);
    expect(extractValues(result.merged)).toEqual({ title: 'x', extra: 'y' });
  });

  it('should handle empty merge (both maps empty)', () => {
    const map1 = createLWWMap({}, '100-0000-a', 'a');
    const map2 = createLWWMap({}, '100-0000-a', 'a');
    const result = mergeLWWMaps(map1, map2);
    expect(extractValues(result.merged)).toEqual({});
  });

  it('should extract metadata correctly', () => {
    const ts = '100-0000-a';
    const map = createLWWMap({ title: 'x', done: true }, ts, 'a');
    const meta = extractMetadata(map);
    expect(meta.title).toBe(ts);
    expect(meta.done).toBe(ts);
  });

  it('should reconstruct LWWMap from values + metadata', () => {
    const ts1 = '100-0000-a';
    const ts2 = '200-0000-b';
    const original = createLWWMap({ title: 'x' }, ts1, 'a');
    original.status = createRegister('active', ts2, 'b');
    const values = extractValues(original);
    const meta = extractMetadata(original);
    const reconstructed = reconstructLWWMap(values, meta, 'server');
    expect(extractValues(reconstructed)).toEqual(values);
    expect(reconstructed.title.hlc).toBe(ts1);
    expect(reconstructed.status.hlc).toBe(ts2);
  });

  it('should find latest HLC across fields', () => {
    const map = createLWWMap({ a: 1 }, '100-0000-x', 'x');
    map.b = createRegister(2, '300-0000-y', 'y');
    map.c = createRegister(3, '200-0000-z', 'z');
    expect(getLatestHLC(map)).toBe('300-0000-y');
  });

  it('should handle numeric and boolean values', () => {
    const map = createLWWMap({ count: 42, active: true }, '100-0000-a', 'a');
    const values = extractValues(map);
    expect(values.count).toBe(42);
    expect(values.active).toBe(true);
  });

  it('should handle null values', () => {
    const map = createLWWMap({ nullable: null }, '100-0000-a', 'a');
    expect(extractValues(map).nullable).toBeNull();
  });
});
