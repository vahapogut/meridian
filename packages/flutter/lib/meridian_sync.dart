/// Meridian Sync — Flutter client library.
///
/// Local-first, offline-first sync engine for Flutter apps.
///
/// Usage:
/// ```dart
/// import 'package:meridian_sync/meridian_sync.dart';
///
/// final db = MeridianClient(
///   serverUrl: 'wss://api.example.com/sync',
///   schema: SchemaDefinition(
///     version: 1,
///     collections: {
///       'todos': CollectionSchema(fields: {
///         'id': FieldDef(type: 'string'),
///         'title': FieldDef(type: 'string'),
///         'done': FieldDef(type: 'boolean', default: false),
///       }),
///     },
///   ),
/// );
///
/// // Reactive query
/// db.collection('todos').find().listen((todos) {
///   setState(() => this.todos = todos);
/// });
///
/// // Write
/// await db.collection('todos').put({
///   'id': '1',
///   'title': 'Build sync engine',
///   'done': false,
/// });
/// ```
library meridian_sync;

export 'src/client.dart';
export 'src/schema.dart';
export 'src/store.dart';
export 'src/hlc.dart';
export 'src/crdt.dart';
export 'src/transport.dart';
