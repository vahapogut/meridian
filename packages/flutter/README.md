# Meridian Sync — Flutter SDK

Local-first sync engine for Flutter apps. Offline-first. Real-time. Conflict-resolved.

## Quick Start

```dart
import 'package:meridian_sync/meridian_sync.dart';

final db = MeridianClient(
  serverUrl: 'wss://api.example.com/sync',
  schema: SchemaDefinition(
    version: 1,
    collections: {
      'todos': CollectionSchema(fields: {
        'id': FieldDef(type: 'string'),
        'title': FieldDef(type: 'string'),
        'done': FieldDef(type: 'boolean', default: false),
      }),
    },
  ),
);

// Reactive query
db.collection('todos').find().listen((todos) {
  setState(() => this.todos = todos);
});

// Write
await db.collection('todos').put({'id': '1', 'title': 'Build sync engine'});
```

## Features

- HLC (Hybrid Logical Clock) for causal ordering
- LWW CRDT for field-level conflict resolution
- SQLite persistence via sqflite
- WebSocket transport
- Reactive Stream-based queries
- Complete offline support

## Links

- [GitHub Repository](https://github.com/vahapogut/MeridianDB)
- [MeridianDB Documentation](https://github.com/vahapogut/MeridianDB)
