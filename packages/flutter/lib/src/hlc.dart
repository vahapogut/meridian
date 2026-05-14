/// Hybrid Logical Clock (HLC) implementation for Dart.
///
/// Based on Kulkarni et al. paper.
class HLC {
  int _wallTime;
  int _counter;
  final String _nodeId;

  HLC(this._nodeId, [int? initialTime])
      : _wallTime = initialTime ?? 0,
        _counter = 0;

  String get nodeId => _nodeId;

  HLCTimestamp now() {
    final physicalTime = DateTime.now().millisecondsSinceEpoch;

    if (physicalTime > _wallTime) {
      _wallTime = physicalTime;
      _counter = 0;
    } else {
      _counter++;
      if (_counter > 65535) {
        throw StateError('[Meridian HLC] Counter overflow');
      }
    }

    return HLCTimestamp(_wallTime, _counter, _nodeId);
  }

  HLCTimestamp send() => now();

  HLCTimestamp recv(HLCTimestamp remote) {
    final physicalTime = DateTime.now().millisecondsSinceEpoch;

    if (physicalTime > _wallTime && physicalTime > remote.wallTime) {
      _wallTime = physicalTime;
      _counter = 0;
    } else if (remote.wallTime > _wallTime) {
      _wallTime = remote.wallTime;
      _counter = remote.counter + 1;
    } else if (_wallTime > remote.wallTime) {
      _counter++;
    } else {
      _counter = _counter > remote.counter ? _counter + 1 : remote.counter + 1;
    }

    return HLCTimestamp(_wallTime, _counter, _nodeId);
  }

  HLCTimestamp peek() => HLCTimestamp(_wallTime, _counter, _nodeId);

  static int compare(HLCTimestamp a, HLCTimestamp b) {
    if (a.wallTime != b.wallTime) return a.wallTime.compareTo(b.wallTime);
    if (a.counter != b.counter) return a.counter.compareTo(b.counter);
    return a.nodeId.compareTo(b.nodeId);
  }

  static String serialize(HLCTimestamp ts) {
    return '${ts.wallTime}-${ts.counter.toString().padLeft(4, '0')}-${ts.nodeId}';
  }

  static String generateNodeId() {
    final random = List.generate(8, (_) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(DateTime.now().microsecondsSinceEpoch % 36)]);
    return random.join();
  }
}

class HLCTimestamp {
  final int wallTime;
  final int counter;
  final String nodeId;

  HLCTimestamp(this.wallTime, this.counter, this.nodeId);

  @override
  String toString() => HLC.serialize(this);
}
