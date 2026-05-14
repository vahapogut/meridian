/// SQLite-backed local store for Meridian Flutter client.
/// Uses sqflite for on-device persistence.

import 'dart:convert';
import 'crdt.dart';

abstract class LocalStore {
  Future<void> init(SchemaDefinition schema);
  Future<Map<String, dynamic>?> getDoc(String collection, String docId);
  Future<List<Map<String, dynamic>>> queryDocs(String collection, {Map<String, dynamic>? filter});
  Future<void> putDoc(String collection, Map<String, dynamic> doc, String hlc, String nodeId);
  Future<void> updateDoc(String collection, String docId, Map<String, dynamic> fields, String hlc, String nodeId);
  Future<void> deleteDoc(String collection, String docId, String hlc, String nodeId);
  Future<List<Map<String, dynamic>>> getPendingOps();
  Future<void> clearPendingOps(List<String> opIds);
  Future<void> close();
}

/// In-memory store for testing/demo. Replace with SQLite for production.
class MemoryStore implements LocalStore {
  final Map<String, Map<String, Map<String, dynamic>>> _docs = {};
  final Map<String, LWWMap> _meta = {};
  final List<Map<String, dynamic>> _pending = [];

  @override
  Future<void> init(SchemaDefinition schema) async {}

  @override
  Future<Map<String, dynamic>?> getDoc(String collection, String docId) async {
    final coll = _docs[collection];
    if (coll == null) return null;
    final doc = coll[docId];
    if (doc == null) return null;
    final meta = _meta['$collection:$docId'];
    if (meta != null && meta.isDeleted) return null;
    return Map.from(doc);
  }

  @override
  Future<List<Map<String, dynamic>>> queryDocs(String collection, {Map<String, dynamic>? filter}) async {
    final coll = _docs[collection];
    if (coll == null) return [];
    final results = <Map<String, dynamic>>[];
    for (final entry in coll.entries) {
      final meta = _meta['$collection:${entry.key}'];
      if (meta != null && meta.isDeleted) continue;
      if (filter != null) {
        var matches = true;
        for (final f in filter.entries) {
          if (entry.value[f.key] != f.value) { matches = false; break; }
        }
        if (!matches) continue;
      }
      results.add(Map.from(entry.value));
    }
    return results;
  }

  @override
  Future<void> putDoc(String collection, Map<String, dynamic> doc, String hlc, String nodeId) async {
    _docs.putIfAbsent(collection, () => {});
    _docs[collection]![doc['id']] = Map.from(doc);
    _meta['$collection:${doc['id']}'] = LWWMap.create(doc, hlc, nodeId);
    _pending.add({
      'id': '${doc['id']}-${DateTime.now().millisecondsSinceEpoch}',
      'collection': collection, 'docId': doc['id'], 'op': 'put', 'hlc': hlc,
    });
  }

  @override
  Future<void> updateDoc(String collection, String docId, Map<String, dynamic> fields, String hlc, String nodeId) async {
    final existing = await getDoc(collection, docId);
    if (existing == null) return;
    final merged = {...existing, ...fields};
    await putDoc(collection, merged, hlc, nodeId);
  }

  @override
  Future<void> deleteDoc(String collection, String docId, String hlc, String nodeId) async {
    final meta = _meta['$collection:$docId'];
    if (meta != null) {
      meta.fields[LWWMap.deletedField] = LWWRegister(true, hlc, nodeId);
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getPendingOps() async => List.from(_pending);

  @override
  Future<void> clearPendingOps(List<String> opIds) async {
    _pending.removeWhere((op) => opIds.contains(op['id']));
  }

  @override
  Future<void> close() async {}
}
