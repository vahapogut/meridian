/// WebSocket transport for Meridian Flutter client.

import 'package:web_socket_channel/web_socket_channel.dart';
import 'dart:convert';

typedef MessageHandler = void Function(Map<String, dynamic> message);

class MeridianTransport {
  WebSocketChannel? _channel;
  final String url;
  MessageHandler? onMessage;
  VoidCallback? onOpen;
  VoidCallback? onClose;

  MeridianTransport(this.url);

  bool get connected => _channel != null;

  Future<void> connect() async {
    _channel = WebSocketChannel.connect(Uri.parse(url));
    onOpen?.call();

    _channel!.stream.listen(
      (data) {
        try {
          final msg = jsonDecode(data as String) as Map<String, dynamic>;
          onMessage?.call(msg);
        } catch (_) {}
      },
      onDone: () {
        _channel = null;
        onClose?.call();
      },
      onError: (_) {
        _channel = null;
        onClose?.call();
      },
    );
  }

  void send(Map<String, dynamic> msg) {
    if (_channel != null) {
      _channel!.sink.add(jsonEncode(msg));
    }
  }

  void close() {
    _channel?.sink.close();
    _channel = null;
  }
}

typedef VoidCallback = void Function();
