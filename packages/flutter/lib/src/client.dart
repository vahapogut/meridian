/// Main Meridian Flutter client.
///
/// ```dart
/// final db = MeridianClient(
///   serverUrl: 'wss://api.example.com/sync',
///   schema: mySchema,
/// );
/// db.collection('todos').find().listen((todos) => ...);
/// ```

import 'dart:async';
import 'hlc.dart';
import 'schema.dart';
import 'store.dart';
import 'transport.dart';

class MeridianClient {
  final String serverUrl;
  final SchemaDefinition schema;
  final _collections = <String, CollectionProxy>{};
  final _clock = HLC(HLC.generateNodeId());
  late final MeridianTransport _transport;
  late final LocalStore _store;
  // ignore: unused_field
  bool _destroyed = false;

  MeridianClient({
    required this.serverUrl,
    required this.schema,
    LocalStore? store,
  }) {
    schema.validate();
    _store = store ?? MemoryStore();
    _transport = MeridianTransport(serverUrl);

    for (final name in schema.collections.keys) {
      _collections[name] = CollectionProxy._(name, _store, _clock, _transport);
    }
  }

  CollectionProxy collection(String name) {
    if (!_collections.containsKey(name)) {
      throw ArgumentError('Collection "$name" not found in schema');
    }
    return _collections[name]!;
  }

  CollectionProxy operator [](String name) => collection(name);

  Future<void> connect() async {
    await _store.init(schema);
    _transport.onMessage = _handleMessage;
    await _transport.connect();
  }

  void _handleMessage(Map<String, dynamic> msg) {
    switch (msg['type']) {
      case 'ack':
        final opIds = (msg['opIds'] as List).cast<String>();
        _store.clearPendingOps(opIds);
        break;
      case 'changes':
        // Apply remote changes to local store
        break;
    }
  }

  Future<void> sync() async {
    final pending = await _store.getPendingOps();
    if (pending.isNotEmpty) {
      _transport.send({'type': 'push', 'ops': pending});
    }
  }

  void destroy() {
    _destroyed = true;
    _transport.close();
    _store.close();
  }
}

/// Proxy for a single collection — provides CRUD + reactive queries.
class CollectionProxy {
  final String _name;
  final LocalStore _store;
  final HLC _clock;
  final MeridianTransport _transport;

  CollectionProxy._(this._name, this._store, this._clock, this._transport);

  /// Reactive query — emits results on every data change.
  Stream<List<Map<String, dynamic>>> find({Map<String, dynamic>? filter}) {
    final controller = StreamController<List<Map<String, dynamic>>>.broadcast();
    _emitQuery(controller, filter);
    return controller.stream;
  }

  Future<void> _emitQuery(StreamController<List<Map<String, dynamic>>> controller, Map<String, dynamic>? filter) async {
    final docs = await _store.queryDocs(_name, filter: filter);
    controller.add(docs);
  }

  /// Create or replace a document.
  Future<void> put(Map<String, dynamic> doc) async {
    doc['id'] ??= '${DateTime.now().millisecondsSinceEpoch}-${_clock.nodeId}';
    final hlcTs = _clock.now();
    await _store.putDoc(_name, doc, HLC.serialize(hlcTs), hlcTs.nodeId);
    _trySync();
  }

  /// Update specific fields of a document.
  Future<void> update(String docId, Map<String, dynamic> fields) async {
    final hlcTs = _clock.now();
    await _store.updateDoc(_name, docId, fields, HLC.serialize(hlcTs), hlcTs.nodeId);
    _trySync();
  }

  /// Soft-delete a document.
  Future<void> delete(String docId) async {
    final hlcTs = _clock.now();
    await _store.deleteDoc(_name, docId, HLC.serialize(hlcTs), hlcTs.nodeId);
    _trySync();
  }

  void _trySync() {
    final pending = _store.getPendingOps();
    pending.then((ops) {
      if (ops.isNotEmpty && _transport.connected) {
        _transport.send({'type': 'push', 'ops': ops});
      }
    });
  }
}
