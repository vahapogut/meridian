/**
 * MeridianDB — WebRTC P2P Transport
 *
 * Serverless peer-to-peer sync via WebRTC DataChannel.
 * No central server needed — clients connect directly to each other.
 *
 * Usage:
 * ```ts
 * import { WebRTCTransport, type SignalServer } from 'meridian-shared';
 *
 * // Each peer needs a signaling mechanism to exchange SDP/ICE
 * const transport = new WebRTCTransport(peerId, signalServer);
 * await transport.connect();
 * transport.send({ type: 'push', ops: [...] });
 * ```
 *
 * Architecture:
 * - Each peer creates an RTCPeerConnection
 * - Signaling (offer/answer/ICE) happens via a simple SignalServer abstraction
 * - DataChannel carries MeridianDB protocol messages
 * - Perfect for LAN sync, mesh networks, or serverless P2P apps
 */

import type { Transport } from './transport.js';
import type { ClientMessage, ServerMessage } from './protocol.js';

// ─── Signal Server Interface ───────────────────────────────────────────────

export interface SignalServer {
  /** Send a signaling message to a specific peer */
  send(peerId: string, signal: SignalMessage): Promise<void>;
  /** Listen for signaling messages addressed to us */
  onSignal(callback: (from: string, signal: SignalMessage) => void): void;
}

export interface SignalMessage {
  type: 'offer' | 'answer' | 'ice-candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

// ─── WebRTC Transport ──────────────────────────────────────────────────────

export class WebRTCTransport implements Transport {
  private peerId: string;
  private signalServer: SignalServer;
  private connections = new Map<string, RTCPeerConnection>();
  private channels = new Map<string, RTCDataChannel>();
  private _onMessage?: (msg: ClientMessage | ServerMessage) => void;
  private _onOpen?: () => void;
  private _onClose?: () => void;
  private _onError?: (err: Error) => void;
  private _connected = false;

  constructor(peerId: string, signalServer: SignalServer) {
    this.peerId = peerId;
    this.signalServer = signalServer;

    // Listen for incoming signals
    this.signalServer.onSignal(async (from, signal) => {
      if (signal.type === 'offer') await this.handleOffer(from, signal);
      else if (signal.type === 'answer') await this.handleAnswer(from, signal);
      else if (signal.type === 'ice-candidate') await this.handleICE(from, signal);
    });
  }

  get connected(): boolean { return this._connected; }

  async connect(): Promise<void> {
    // WebRTC is connection-per-peer, no global connect needed
    this._connected = true;
    this._onOpen?.();
  }

  /**
   * Open a connection to a remote peer.
   */
  async connectTo(remotePeerId: string): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalServer.send(remotePeerId, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    const channel = pc.createDataChannel('meridian');
    this.setupChannel(channel, remotePeerId);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this.signalServer.send(remotePeerId, { type: 'offer', sdp: offer.sdp });

    this.connections.set(remotePeerId, pc);
  }

  private async handleOffer(from: string, signal: SignalMessage): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signalServer.send(from, {
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    pc.ondatachannel = (event) => {
      this.setupChannel(event.channel, from);
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.signalServer.send(from, { type: 'answer', sdp: answer.sdp });

    this.connections.set(from, pc);
  }

  private async handleAnswer(from: string, signal: SignalMessage): Promise<void> {
    const pc = this.connections.get(from);
    if (pc && signal.sdp) {
      await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
    }
  }

  private async handleICE(from: string, signal: SignalMessage): Promise<void> {
    const pc = this.connections.get(from);
    if (pc && signal.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  private setupChannel(channel: RTCDataChannel, peerId: string): void {
    channel.onopen = () => {
      this.channels.set(peerId, channel);
      this._onOpen?.();
    };
    channel.onclose = () => {
      this.channels.delete(peerId);
      this._onClose?.();
    };
    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._onMessage?.(msg);
      } catch { /* Ignore non-JSON */ }
    };
    channel.onerror = () => {
      this._onError?.(new Error(`WebRTC channel error with ${peerId}`));
    };
  }

  send(msg: ClientMessage | ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [peerId, channel] of this.channels) {
      if (channel.readyState === 'open') {
        channel.send(data);
      }
    }
  }

  /** Send to a specific peer */
  sendTo(peerId: string, msg: unknown): void {
    const channel = this.channels.get(peerId);
    if (channel?.readyState === 'open') {
      channel.send(JSON.stringify(msg));
    }
  }

  onMessage(callback: (msg: ClientMessage | ServerMessage) => void): void { this._onMessage = callback; }
  onOpen(callback: () => void): void { this._onOpen = callback; }
  onClose(callback: () => void): void { this._onClose = callback; }
  onError(callback: (err: Error) => void): void { this._onError = callback; }

  close(): void {
    for (const [id, pc] of this.connections) { pc.close(); }
    this.connections.clear();
    this.channels.clear();
    this._connected = false;
  }
}
