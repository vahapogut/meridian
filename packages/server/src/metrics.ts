/**
 * MeridianDB — Observability / Metrics
 *
 * Prometheus-compatible metrics endpoint for production monitoring.
 * Tracks: connected clients, sync ops/sec, merge latency, compaction runs.
 *
 * Usage:
 * ```ts
 * import { MetricsCollector } from 'meridian-server';
 * const metrics = new MetricsCollector();
 * // ... during sync ops:
 * metrics.recordMerge(1.2); // ms
 * metrics.recordSyncOp();
 * // Expose via HTTP:
 * app.get('/metrics', (req, res) => res.send(metrics.prometheus()));
 * ```
 */

export interface MetricsSnapshot {
  connectedClients: number;
  syncOpsTotal: number;
  syncOpsPerSecond: number;
  mergeLatencyAvg: number;
  mergeLatencyP95: number;
  mergeLatencyP99: number;
  compactionsTotal: number;
  errorsTotal: number;
  uptimeMs: number;
}

const WINDOW_MS = 60000; // 1 minute sliding window for rate calculation

export class MetricsCollector {
  private startTime = Date.now();
  private syncOps = 0;
  private mergeLatencies: number[] = [];
  private compactions = 0;
  private errors = 0;
  private _connectedClients = 0;
  private syncTimestamps: number[] = [];

  /** Call when a client connects */
  clientConnected(): void { this._connectedClients++; }

  /** Call when a client disconnects */
  clientDisconnected(): void { this._connectedClients = Math.max(0, this._connectedClients - 1); }

  /** Get current connected client count */
  get connectedClients(): number { return this._connectedClients; }

  /** Record a merge operation latency in ms */
  recordMerge(latencyMs: number): void {
    this.syncOps++;
    this.mergeLatencies.push(latencyMs);
    this.syncTimestamps.push(Date.now());

    // Keep only last 10K samples
    if (this.mergeLatencies.length > 10000) {
      this.mergeLatencies.shift();
    }
    // Purge timestamps outside the sliding window
    const cutoff = Date.now() - WINDOW_MS;
    this.syncTimestamps = this.syncTimestamps.filter(t => t > cutoff);
  }

  /** Record a sync operation */
  recordSyncOp(): void { this.syncOps++; this.syncTimestamps.push(Date.now()); }

  /** Record a compaction run */
  recordCompaction(): void { this.compactions++; }

  /** Record an error */
  recordError(): void { this.errors++; }

  /** Calculate percentile from sorted array */
  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /** Get current metrics snapshot */
  snapshot(): MetricsSnapshot {
    const sorted = [...this.mergeLatencies].sort((a, b) => a - b);
    const opsInWindow = this.syncTimestamps.length;

    return {
      connectedClients: this._connectedClients,
      syncOpsTotal: this.syncOps,
      syncOpsPerSecond: Math.round((opsInWindow / WINDOW_MS) * 1000),
      mergeLatencyAvg: sorted.length > 0 ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length * 100) / 100 : 0,
      mergeLatencyP95: Math.round(this.percentile(sorted, 95) * 100) / 100,
      mergeLatencyP99: Math.round(this.percentile(sorted, 99) * 100) / 100,
      compactionsTotal: this.compactions,
      errorsTotal: this.errors,
      uptimeMs: Date.now() - this.startTime,
    };
  }

  /** Generate Prometheus text format output */
  prometheus(): string {
    const s = this.snapshot();
    return [
      '# HELP meridiandb_connected_clients Number of connected WebSocket clients',
      '# TYPE meridiandb_connected_clients gauge',
      `meridiandb_connected_clients ${s.connectedClients}`,
      '',
      '# HELP meridiandb_sync_ops_total Total sync operations',
      '# TYPE meridiandb_sync_ops_total counter',
      `meridiandb_sync_ops_total ${s.syncOpsTotal}`,
      '',
      '# HELP meridiandb_sync_ops_per_second Current sync throughput',
      '# TYPE meridiandb_sync_ops_per_second gauge',
      `meridiandb_sync_ops_per_second ${s.syncOpsPerSecond}`,
      '',
      '# HELP meridiandb_merge_latency_avg Average merge latency in ms',
      '# TYPE meridiandb_merge_latency_avg gauge',
      `meridiandb_merge_latency_avg ${s.mergeLatencyAvg}`,
      '',
      '# HELP meridiandb_merge_latency_p95 P95 merge latency in ms',
      '# TYPE meridiandb_merge_latency_p95 gauge',
      `meridiandb_merge_latency_p95 ${s.mergeLatencyP95}`,
      '',
      '# HELP meridiandb_merge_latency_p99 P99 merge latency in ms',
      '# TYPE meridiandb_merge_latency_p99 gauge',
      `meridiandb_merge_latency_p99 ${s.mergeLatencyP99}`,
      '',
      '# HELP meridiandb_compactions_total Total compaction runs',
      '# TYPE meridiandb_compactions_total counter',
      `meridiandb_compactions_total ${s.compactionsTotal}`,
      '',
      '# HELP meridiandb_errors_total Total errors',
      '# TYPE meridiandb_errors_total counter',
      `meridiandb_errors_total ${s.errorsTotal}`,
      '',
      '# HELP meridiandb_uptime_ms Uptime in milliseconds',
      '# TYPE meridiandb_uptime_ms gauge',
      `meridiandb_uptime_ms ${s.uptimeMs}`,
      '',
    ].join('\n');
  }

  /** JSON snapshot for programmatic consumption */
  json(): MetricsSnapshot { return this.snapshot(); }
}
