import { MetricsRegistry, type Counter, type Gauge } from '@exitliquidity/core';

/** What an operator needs to answer "is the trace API healthy and affordable". */
export interface ApiMetrics {
  readonly registry: MetricsRegistry;
  /** Requests by route and status class. */
  readonly requests: Counter;
  /** Traces computed, by outcome. `cached` never touches RPC. */
  readonly traces: Counter;
  /** RPC calls a trace spent. The bill, in other words. */
  readonly rpcSignatures: Counter;
  readonly rpcTransactions: Counter;
  /** Seconds the last completed trace took. */
  readonly traceSeconds: Gauge;
  readonly cacheEntries: Gauge;
  readonly inFlight: Gauge;
}

export function createApiMetrics(registry = new MetricsRegistry()): ApiMetrics {
  return {
    registry,
    requests: registry.counter('fillmark_api_requests_total', 'HTTP requests by route and status'),
    traces: registry.counter('fillmark_api_traces_total', 'Traces served, by outcome'),
    rpcSignatures: registry.counter(
      'fillmark_api_rpc_signatures_total',
      'Signatures read from RPC while serving traces',
    ),
    rpcTransactions: registry.counter(
      'fillmark_api_rpc_transactions_total',
      'Transactions fetched from RPC while serving traces',
    ),
    traceSeconds: registry.gauge(
      'fillmark_api_trace_seconds',
      'Wall-clock seconds of the last completed trace',
    ),
    cacheEntries: registry.gauge('fillmark_api_cache_entries', 'Traces held in the result cache'),
    inFlight: registry.gauge('fillmark_api_traces_in_flight', 'Traces being computed right now'),
  };
}
