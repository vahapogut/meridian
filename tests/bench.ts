/**
 * Meridian — Performance Benchmarks
 *
 * Micro-benchmarks for core operations.
 * Run: npx tsx tests/bench.ts
 */

import { HLC, serializeHLC, deserializeHLC, compareHLCStrings } from '../packages/shared/src/hlc.js';
import { createLWWMap, mergeLWWMaps, extractValues } from '../packages/shared/src/crdt.js';

function bench(name: string, fn: () => void, iterations = 100_000): void {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const elapsed = performance.now() - start;
  const opsPerSec = Math.round((iterations / elapsed) * 1000);
  const nsPerOp = (elapsed / iterations * 1_000_000).toFixed(0);
  console.log(`  ${name}: ${opsPerSec.toLocaleString()} ops/s (${nsPerOp} ns/op)`);
}

console.log('\n=== Meridian Benchmarks ===\n');

// ─── HLC Benchmarks ────────────────────────────────────────────────────────

console.log('HLC — Hybrid Logical Clock:');
const clock = new HLC('bench-node');
bench('  now()', () => { clock.now(); }, 500_000);
bench('  send()', () => { clock.send(); }, 500_000);

const ts = clock.now();
const packed = serializeHLC(ts);
bench('  serializeHLC', () => { serializeHLC(ts); }, 500_000);
bench('  deserializeHLC', () => { deserializeHLC(packed); }, 500_000);
bench('  compareHLCStrings', () => { compareHLCStrings(packed, packed); }, 500_000);

// ─── CRDT Benchmarks ───────────────────────────────────────────────────────

console.log('\nCRDT — LWW Map:');
const hlc = serializeHLC(clock.now());
bench('  createLWWMap (5 fields)', () => {
  createLWWMap({ id: '1', title: 'Test', done: false, priority: 1, tags: [] }, hlc, 'n');
}, 200_000);

const mapA = createLWWMap({ id: '1', title: 'Hello', done: false }, hlc, 'a');
const mapB = createLWWMap({ id: '1', title: 'World', done: true }, '999-0001-b', 'b');
bench('  mergeLWWMaps (3 fields)', () => {
  mergeLWWMaps(mapA, mapB);
}, 200_000);

const merged = mergeLWWMaps(mapA, mapB).merged;
bench('  extractValues (3 fields)', () => {
  extractValues(merged);
}, 500_000);

// ─── Realistic Workload ────────────────────────────────────────────────────

console.log('\nRealistic Workload:');
console.log('  1000 document creates + merges:');
const clock2 = new HLC('bench');
const start = performance.now();
const docs: ReturnType<typeof createLWWMap>[] = [];

for (let i = 0; i < 1000; i++) {
  const ts = serializeHLC(clock2.now());
  const doc = createLWWMap({ id: `doc-${i}`, title: `Title ${i}`, done: i % 2 === 0 }, ts, 'n');
  docs.push(doc);
}

for (let i = 0; i < 500; i++) {
  const result = mergeLWWMaps(docs[i], docs[i + 500]);
  extractValues(result.merged);
}

const elapsed = performance.now() - start;
console.log(`  Time: ${elapsed.toFixed(1)}ms (1,500 operations)`);
console.log(`  Throughput: ${Math.round(1500 / (elapsed / 1000)).toLocaleString()} ops/s`);

// ─── Scale Benchmarks ──────────────────────────────────────────────────────

console.log('\n--- Scale Benchmarks ---\n');

// 100K document merge benchmark
console.log('100K Document Merge:');
const scaleClock = new HLC('bench');
const scaleStart = performance.now();
const scaleDoc = createLWWMap({ id: 'scale-1', title: 'Initial', count: 0 }, '0-0000-n', 'n');

for (let i = 0; i < 100_000; i++) {
  const ts = serializeHLC(scaleClock.now());
  const remote = createLWWMap({ title: `Title ${i}`, count: i }, ts, 'n');
  mergeLWWMaps(scaleDoc, remote);
}
console.log(`  Time: ${(performance.now() - scaleStart).toFixed(0)}ms (100,000 merges)`);

// Memory usage estimation
console.log('\nMemory Usage:');
const memDocs: ReturnType<typeof createLWWMap>[] = [];
for (let i = 0; i < 10_000; i++) {
  memDocs.push(createLWWMap(
    { id: `doc-${i}`, title: `Document ${i} Title Here`, done: i % 2 === 0, count: i },
    `100-0000-n`, 'n'
  ));
}
const memUsage = process.memoryUsage();
console.log(`  10K documents in memory: ~${Math.round(memUsage.heapUsed / 1024 / 1024)}MB heap`);

// Sync payload size
console.log('\nPayload Size:');
const sampleOp = {
  id: 'doc-1-title-100-0001-n',
  collection: 'todos',
  docId: 'doc-1',
  field: 'title',
  value: 'Hello World',
  hlc: '100-0001-n',
  nodeId: 'n',
};
const payload = JSON.stringify(sampleOp);
console.log(`  Single field update: ${payload.length} bytes\n`);

