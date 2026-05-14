/// CRDT — Last-Writer-Wins Register and Map for field-level conflict resolution.

class LWWRegister<T> {
  T value;
  String hlc;
  String nodeId;

  LWWRegister(this.value, this.hlc, this.nodeId);

  static LWWRegister<T> merge<T>(LWWRegister<T> local, LWWRegister<T> remote) {
    final cmp = HLC.compare(
      _parseHLC(local.hlc),
      _parseHLC(remote.hlc),
    );
    if (cmp > 0) return local;
    if (cmp < 0) return remote;
    return local.nodeId.compareTo(remote.nodeId) >= 0 ? local : remote;
  }

  static HLCTimestamp _parseHLC(String hlc) {
    final parts = hlc.split('-');
    return HLCTimestamp(
      int.parse(parts[0]),
      int.parse(parts[1]),
      parts.length > 2 ? parts[2] : '',
    );
  }
}

/// LWW Map — one document/row with per-field CRDT registers.
class LWWMap {
  static const deletedField = '__deleted';
  Map<String, LWWRegister<dynamic>> fields;

  LWWMap(this.fields);

  factory LWWMap.create(Map<String, dynamic> values, String hlc, String nodeId) {
    final map = <String, LWWRegister<dynamic>>{};
    for (final entry in values.entries) {
      map[entry.key] = LWWRegister(entry.value, hlc, nodeId);
    }
    map[deletedField] = LWWRegister(false, hlc, nodeId);
    return LWWMap(map);
  }

  bool get isDeleted => fields[deletedField]?.value == true;

  Map<String, dynamic> extractValues() {
    final result = <String, dynamic>{};
    for (final entry in fields.entries) {
      if (entry.key == deletedField) continue;
      result[entry.key] = entry.value;
    }
    return result;
  }

  Map<String, String> extractMetadata() {
    final result = <String, String>{};
    for (final entry in fields.entries) {
      result[entry.key] = entry.value;
    }
    return result;
  }

  static LWWMap merge(LWWMap local, LWWMap remote) {
    final merged = <String, LWWRegister<dynamic>>{};
    final conflicts = <ConflictRecord>[];

    final allFields = {...local.fields.keys, ...remote.fields.keys};

    for (final field in allFields) {
      final localReg = local.fields[field];
      final remoteReg = remote.fields[field];

      if (localReg == null) {
        merged[field] = remoteReg!;
      } else if (remoteReg == null) {
        merged[field] = localReg;
      } else {
        final winner = LWWRegister.merge(localReg, remoteReg);
        merged[field] = winner;

        if (localReg.value != remoteReg.value) {
          conflicts.add(ConflictRecord(
            field: field,
            winnerValue: winner.value,
            loserValue: winner == localReg ? remoteReg.value : localReg.value,
          ));
        }
      }
    }

    return LWWMap(merged);
  }
}

class ConflictRecord {
  final String field;
  final dynamic winnerValue;
  final dynamic loserValue;

  ConflictRecord({required this.field, required this.winnerValue, required this.loserValue});
}
