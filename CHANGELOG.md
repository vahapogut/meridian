# Changelog

## v0.2.0 (2026-05-14)

### Major Features

- **V2: Live Queries** — `.live(options)` method on collections with `where`, `orderBy`, and `limit` support
- **V2: Permission Rules DSL** — Firebase-like security rules with `defineRules()` and `RuleEvaluator` for row-level access control
- **V2: Sync Compression** — Debounced offline queue ops reduce bandwidth for rapid typing

### Testing

- 48 unit tests across shared package (27 HLC + 21 CRDT)
- Tests cover: HLC initialization, counter management, recv monotonicity, serialization/deserialization, LWW Register merge, LWW Map field-level convergence, tombstone handling, conflict detection, metadata extraction, reconstruction

### npm Readiness

- All packages updated with repository, homepage, keywords, and author metadata
- Dual ESM/CJS builds via tsup

### Packages

| Package | Version | Description |
|---------|---------|-------------|
| `meridian-shared` | 0.1.0 | CRDT primitives, HLC, protocol, schema, permissions |
| `meridian-client` | 0.1.0 | IndexedDB store, WebSocket sync, reactive queries, multi-tab |
| `meridian-server` | 0.1.0 | PostgreSQL sync server, CRDT merge, WebSocket hub |
| `meridian` (root) | 0.1.0 | Monorepo workspace |

---

## v0.1.0-alpha (2026-05-01)

### Initial Release

- HLC (Hybrid Logical Clock) implementation
- LWW Register + LWW Map CRDT data structures
- Client: IndexedDB persistence, WebSocket sync engine, reactive queries, BroadcastChannel multi-tab coordination, presence
- Server: PostgreSQL auto-DDL, CRDT merge engine, WebSocket hub, tombstone compaction, LISTEN/NOTIFY
- Demo: Real-time todo app with multi-user presence cursors
