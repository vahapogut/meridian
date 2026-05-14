<div align="center">
  <img src="./assets/ipeclabs-logo-light.svg" alt="Meridian Logo" width="120" />
</div>

<h1 align="center">Meridian</h1>

<p align="center">
  <b>High-performance local-first sync engine for realtime collaborative apps.</b><br/><br/>
  Offline-first. Real-time. Conflict-resolved.<br/>
  Works with PostgreSQL, SQLite, and any transport.<br/>
  No sync backend to write.
</p>

<p align="center">
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/PostgreSQL-316192?logo=postgresql&logoColor=white" alt="PostgreSQL">
  <img src="https://img.shields.io/badge/Local--First-Success?style=flat&color=10b981" alt="Local-First">
  <img src="https://img.shields.io/badge/tests-76_passed-brightgreen" alt="Tests: 48 passed">
  <img src="https://img.shields.io/badge/benchmarks-20M_ops%2Fs-blue" alt="Benchmarks">
  <img src="https://img.shields.io/badge/React-hooks-blue?logo=react" alt="React">
  <img src="https://img.shields.io/badge/React_Native-mobile-blue?logo=react" alt="React Native">
  <img src="https://img.shields.io/badge/SQLite-adapter-orange?logo=sqlite" alt="SQLite">
  <img src="https://img.shields.io/badge/E2E-encrypted-green" alt="E2E Encryption">
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#how-it-works">How it Works</a> •
  <a href="#architecture">Architecture</a>
</p>

---

Meridian gives your app **Firebase-like sync** on top of your own **PostgreSQL** database. 

No custom WebSocket infrastructure.  
No reconciliation logic.  
No offline queue implementation.  
No cache invalidation headaches.

<p align="center">
  <img src="./assets/demo-ui.png" alt="Meridian Glassmorphism UI in action" width="800" />
</p>

## The Meridian DX

Define your schema, connect to the database, and start writing. That's it.

```typescript
import { createClient } from '@meridian-sync/client';

const db = createClient({
  schema,
  serverUrl: 'wss://api.yourdomain.com/sync',
});

// 1. Reactive Queries (Auto-updates UI on any change)
db.todos.find().subscribe(renderTodos);

// 2. Write Data (Instantly updates UI, persists offline, syncs when online)
await db.todos.put({
  id: crypto.randomUUID(),
  title: "Build sync engine",
});

// 3. Update Fields (CRDT field-level merge prevents conflicts)
await db.todos.update(id, { done: true });
```

### What just happened?
Meridian automatically handled:
- [x] IndexedDB persistence
- [x] Offline queueing
- [x] WebSocket sync
- [x] Multi-tab coordination
- [x] Conflict resolution
- [x] Reconnect recovery
- [x] Optimistic updates
- [x] PostgreSQL persistence

---

## Why Meridian?

If you've built collaborative or offline-capable apps before, you know the pain. You start with a simple `fetch`, then add websockets for real-time, then add local caching, then try to handle offline writes, and suddenly you have a messy, state-inconsistent nightmare.

Meridian solves this by abstracting the entire sync layer into a single, cohesive engine.

* **For Supabase/Firebase Developers:** Keep the magical Developer Experience, but own your data in a standard PostgreSQL database.
* **For React/Vue Developers:** Stop writing `useEffect` blocks to fetch data. Just `.subscribe()` and let the engine handle the rest.
* **For Local-First Believers:** Build apps that are instantly interactive, even on a subway with zero connection.

## Features

* **Zero-Config PostgreSQL:** Meridian automatically creates your tables and adds `_meridian` system columns. No migration scripts needed for new collections.
* **Multi-Tab Leader Election:** Only one browser tab maintains the WebSocket connection. Other tabs coordinate locally via `BroadcastChannel`, drastically reducing server load.
* **Seamless Reconnects:** Exponential backoff with jitter, offline queues, and automatic replay of missed operations upon reconnection.
* **Additive Migrations:** Add new fields with `.default()` values. Clients running v1 and v2 schemas can seamlessly collaborate without breaking.
* **Real-time Presence:** Built-in ephemeral cursor and status tracking that bypasses the database for maximum performance.
* **Live Queries (V2):** `db.todos.live({ where: { done: false }, orderBy: 'createdAt', limit: 50 })` — reactive queries with filtering, sorting, and pagination.
* **Permission Rules DSL (V2):** Firebase-like security rules with `defineRules()` + `RuleEvaluator` for row-level read/write access control.
* **Storage Adapter Interface (V2):** Abstract `StorageAdapter` interface enabling PostgreSQL, SQLite (Turso), and MySQL backends.
* **Message Validation:** All incoming WebSocket messages are validated against known types — malformed data is rejected early.
* **IndexedDB Quota Handling:** Graceful error reporting when browser storage limits are exceeded.
* **React Hooks:** `useQuery`, `useLiveQuery`, `useDoc`, `useSync`, `usePresence`, `useMutation` — zero boilerplate React integration.
* **E2E Encryption:** AES-256-GCM field-level encryption. IndexedDB at-rest + WebSocket in-transit. Server stores only ciphertext.
* **CLI Tools:** `meridian migrate`, `inspect`, `replay`, `status`, `compact` — manage sync infrastructure from the command line.
* **WAL Streaming:** PostgreSQL LISTEN/NOTIFY + logical replication for real-time change data capture at scale.
* **Partial Sync:** Row-level `WHERE` filters on subscriptions — clients only sync matching data, not entire collections.
* **Row-Level Permissions:** Server-side `RuleEvaluator` filters changes by auth context. Users only see authorized rows.
* **SQLite Adapter:** Full `SQLiteStore` implementing the StorageAdapter interface — works with better-sqlite3, sql.js, and Turso.
* **React Native SDK:** `@meridian-sync/react-native` — AsyncStorage-backed client with the same hooks API as the browser.

## Quick Start

### 1. Install

```bash
npm install @meridian-sync/client @meridian-sync/server @meridian-sync/shared
```

### 2. Define your Schema (Shared)

```typescript
// shared/schema.ts
import { defineSchema, z } from '@meridian-sync/shared';

export const schema = defineSchema({
  version: 1,
  collections: {
    issues: {
      id: z.string(),
      title: z.string(),
      status: z.string().default('open'),
      createdAt: z.number(),
    },
  },
});
```

### 3. Start the Server

```typescript
// server.ts
import { createServer } from '@meridian-sync/server';
import { schema } from './shared/schema';

const server = createServer({
  port: 3000,
  database: 'postgresql://postgres:postgres@localhost:5432/mydb',
  schema,
  auth: async (token) => {
    // Validate JWT and return userId
    const user = verifyJWT(token);
    return { userId: user.id };
  }
});

await server.start();
```

### 4. Connect the Client

```typescript
// client.ts
import { createClient } from '@meridian-sync/client';
import { schema } from './shared/schema';

const db = createClient({
  schema,
  serverUrl: 'ws://localhost:3000/sync',
  auth: { getToken: () => localStorage.getItem('jwt') }
});

// Done. Start building!
db.issues.find().subscribe(issues => console.log(issues));
```

### 5. React Integration (Optional)

```tsx
import { useQuery, useLiveQuery, useMutation } from '@meridian-sync/react';

function TodoList() {
  const todos = useQuery(db.todos.find());
  const { put, update, remove } = useMutation(db.todos);

  if (!todos) return <p>Loading...</p>;

  return todos.map(todo => (
    <div key={todo.id}>
      <span>{todo.title}</span>
      <button onClick={() => update(todo.id, { done: !todo.done })}>
        {todo.done ? 'Undo' : 'Done'}
      </button>
    </div>
  ));
}
```

### 6. CLI Management

```bash
npx meridian-cli status   --url wss://api.example.com/sync
npx meridian-cli inspect  --db postgresql://... --collection todos
npx meridian-cli compact  --db postgresql://... --max-age 30
```

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser / RN)                     │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ React    │  │ Reactive  │  │ CRDT Merge │  │ Persistence │  │
│  │ Hooks    │→ │ Queries   │→ │ Engine     │→ │ IndexedDB   │  │
│  │ useQuery │  │ .live()   │  │ HLC + LWW  │  │ SQLite/OPFS │  │
│  └──────────┘  └───────────┘  └────────────┘  └─────────────┘  │
│                                                      ↓          │
│                                              ┌─────────────┐    │
│                                              │ Offline     │    │
│                                              │ Queue       │    │
│                                              └─────────────┘    │
└──────────────────────────────────────────────────────────────────┘
                               │ Transport
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                        SERVER (Node.js)                          │
│  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ WebSocket│  │ CRDT      │  │ Permission │  │ Persistence │  │
│  │ Hub      │→ │ Merge     │→ │ Rules      │→ │ PostgreSQL  │  │
│  │          │  │ Engine    │  │ Evaluator  │  │ SQLite      │  │
│  └──────────┘  └───────────┘  └────────────┘  └─────────────┘  │
│                                                      ↓          │
│                                              ┌─────────────┐    │
│                                              │ WAL Stream  │    │
│                                              │ Compaction  │    │
│                                              └─────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

## Use Cases

**What can you build with Meridian?**

| Use Case | Why Meridian? |
|---|---|
| **Collaborative Editor** (Figma/Notion-like) | Field-level CRDT — two users editing different parts of the same doc never conflict |
| **Offline-First Notes App** | Writes persist to IndexedDB immediately, sync when back online — zero UX delay |
| **Multiplayer Game State** | HLC-based ordering + presence API — all clients see consistent game world |
| **Real-Time Dashboard** | Reactive queries push updates to UI, no polling needed |
| **Mobile App with Spotty Connection** | SQLite on-device → sync when online. Subway-proof |
| **Edge Cache Replication** | WAL streaming pushes changes to edge nodes in real-time |
| **Supabase Realtime Alternative** | Own your Postgres. No vendor lock-in. Same DX |

## CRDT Ecosystem Comparison

| Engine | Language | CRDT | Field-Level | Offline | Transport Agnostic | Self-Hosted |
|---|---|---|---|---|---|---|
| **Meridian** | TypeScript | HLC + LWW | ✅ | ✅ | ✅ | ✅ |
| Yjs | JavaScript | YATA | ❌ | ✅ | ⚠️ | ✅ |
| Automerge | Rust/JS | RGA | ❌ | ✅ | ✅ | ✅ |
| Liveblocks | SaaS | ❌ | ❌ | ⚠️ | ❌ | ❌ |
| ElectricSQL | Elixir/TS | LWW | ❌ | ✅ | ❌ | ✅ |
| PowerSync | Dart/TS | Custom | ❌ | ✅ | ❌ | ⚠️ |

> **Meridian's edge:** Field-level CRDT means no data loss when two users edit the same row. Transport-agnostic means you're not locked into WebSocket. Self-hosted means you own your data.

## How it Works (Under the Hood)

For the curious engineers, Meridian is built on robust distributed systems principles.

### Deterministic Conflict Resolution
Meridian uses **Hybrid Logical Clocks (HLC)** combined with **Last-Writer-Wins (LWW)** CRDTs at the *field level*. This means User A can edit the `title` while User B edits the `status` of the same row while both are offline. When they reconnect, both edits merge flawlessly. No data loss.

### Reliable Pull via Sequence Numbers
The PostgreSQL server assigns a monotonically increasing `SeqNum` to every operation. Clients track their last seen `SeqNum`. On reconnect, the client simply asks: *"Give me everything since SeqNum 42."* This avoids clock drift issues and guarantees consistency.

### Compaction & Tombstones
Deleted rows are converted to tombstones (soft-deleted). A background compaction scheduler periodically cleans up tombstones older than 30 days. If an offline client connects after a compaction event, Meridian detects the gap and triggers a `full-sync-required` event to self-heal.

## V2 Roadmap

Meridian is evolving to become the ultimate infra product for local-first development.

### Done in v0.2.0
- [x] **Live Query Layer:** `db.todos.live({ where: { status: 'open' }, limit: 50 })` for partial hydration.
- [x] **Permission Rules DSL:** Firebase-like security rules with `defineRules()` and `RuleEvaluator`.
- [x] **Storage Adapter Interface:** Abstract adapter for PostgreSQL, SQLite, MySQL backends.
- [x] **Comprehensive Tests:** 48 unit tests covering HLC and CRDT modules.
- [x] **Performance Benchmarks:** 20M HLC ops/s, 3M LWWMap creates/s, 580K ops/s throughput.

### Done in v0.3.0
- [x] **React Hooks:** `useQuery`, `useLiveQuery`, `useDoc`, `useSync`, `usePresence`, `useMutation`.
- [x] **E2E Encryption:** AES-256-GCM field-level encryption for IndexedDB + WebSocket.
- [x] **CLI Tools:** `meridian migrate`, `inspect`, `replay`, `status`, `compact`.
- [x] **WAL Streaming:** PostgreSQL LISTEN/NOTIFY + logical replication polling consumer.

### Done in v0.4.0
- [x] **Partial Sync:** Row-level `WHERE` filters on subscriptions — clients only sync matching data.
- [x] **Row-Level Permissions:** Server-side `RuleEvaluator` filters changes by auth context.
- [x] **Custom Conflict Hooks:** `onConflict` callback on MergeEngine for custom merge logic.
- [x] **Fine-Grained Reactivity:** `useQueryOptimized` — only changed documents trigger re-renders.
- [x] **SQLite Adapter:** `SQLiteStore` with better-sqlite3, sql.js WASM, and Turso/libsql support.
- [x] **React Native SDK:** `@meridian-sync/react-native` with AsyncStorage + same hooks API.

### Coming Next
- [ ] **Sync Compression:** Debouncing typing operations in the offline queue.
- [ ] **MySQL Adapter:** MySQL implementation of the StorageAdapter interface.
- [ ] **Vue/Svelte hooks:** Framework support beyond React.
- [ ] **Flutter SDK:** Dart/Flutter client for cross-platform mobile.

## Performance

Benchmarks from `tests/bench.ts` on a standard machine (Intel i7, 16GB RAM):

### Micro-Benchmarks

| Operation | Throughput |
|---|---|
| HLC `now()` | 20M ops/s |
| HLC `serialize` | 94M ops/s |
| LWWMap create (5 fields) | 3M ops/s |
| LWWMap merge (3 fields) | 870K ops/s |

### Scale Benchmarks

| Scenario | Result |
|---|---|
| 1,500 document creates + merges | **2.6ms** |
| 100K document merges | **119ms** |
| Memory / 10K documents | **~16MB heap** (~1.6KB/doc) |
| Sync payload (single field update) | **138 bytes** |
| Replication latency (local) | **<1ms** |

Run locally: `npx tsx tests/bench.ts`

## Persistence Backends

Meridian supports multiple persistence backends. Choose based on your platform:

| Backend | Platform | Best For |
|---|---|---|
| **IndexedDB** | Browser | Default. Good for typical web apps (hundreds of MB) |
| **SQLite** | Server / Mobile / Browser (WASM) | Large datasets (GB scale). Full SQL query power |
| **OPFS** | Browser | High-performance file I/O. Large binary data |
| **PostgreSQL** | Server | Production sync server. WAL streaming |
| **AsyncStorage** | React Native | Simple key-value for mobile apps |
| **In-Memory** | Testing / Edge | Zero persistence. Ephemeral data |

## Testing

76 tests (48 unit + 28 integration) across all packages:

```bash
pnpm test
```

Tests cover: HLC initialization, counter management, recv monotonicity, serialization round-trips, LWW Register merge, field-level convergence, tombstone handling, conflict detection, metadata extraction, and reconstruction.

## License

Apache-2.0. Built for the community by IPEC Labs.
