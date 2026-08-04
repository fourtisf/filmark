/**
 * A minimal Prometheus-text metrics registry.
 *
 * Deliberately dependency-free and deliberately small: P0 needs to answer
 * "are swaps arriving, are any being dropped, and how far behind are we",
 * and nothing more.
 */

export type Labels = Readonly<Record<string, string>>;

interface Series {
  readonly labels: Labels;
  value: number;
}

abstract class Metric {
  protected readonly series = new Map<string, Series>();

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  protected abstract readonly type: 'counter' | 'gauge';

  protected key(labels: Labels): string {
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([k, v]) => `${k}=${v}`).join(',');
  }

  protected upsert(labels: Labels): Series {
    const key = this.key(labels);
    let series = this.series.get(key);
    if (series === undefined) {
      series = { labels, value: 0 };
      this.series.set(key, series);
    }
    return series;
  }

  get(labels: Labels = {}): number {
    return this.series.get(this.key(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
    if (this.series.size === 0) {
      lines.push(`${this.name} 0`);
    }
    for (const series of this.series.values()) {
      lines.push(`${this.name}${renderLabels(series.labels)} ${series.value}`);
    }
    return lines.join('\n');
  }
}

export class Counter extends Metric {
  protected readonly type = 'counter' as const;

  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new RangeError('counters cannot decrease');
    this.upsert(labels).value += by;
  }
}

export class Gauge extends Metric {
  protected readonly type = 'gauge' as const;

  set(value: number, labels: Labels = {}): void {
    this.upsert(labels).value = value;
  }

  inc(labels: Labels = {}, by = 1): void {
    this.upsert(labels).value += by;
  }
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `{${rendered}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export class MetricsRegistry {
  readonly #metrics = new Map<string, Metric>();

  counter(name: string, help: string): Counter {
    return this.#register(name, () => new Counter(name, help)) as Counter;
  }

  gauge(name: string, help: string): Gauge {
    return this.#register(name, () => new Gauge(name, help)) as Gauge;
  }

  #register(name: string, factory: () => Metric): Metric {
    const existing = this.#metrics.get(name);
    if (existing !== undefined) return existing;
    const created = factory();
    this.#metrics.set(name, created);
    return created;
  }

  render(): string {
    return `${[...this.#metrics.values()].map((m) => m.render()).join('\n\n')}\n`;
  }
}

/** The metrics P0 actually reports on. */
export interface IngestMetrics {
  readonly registry: MetricsRegistry;
  /** Transactions handed to the pipeline, by source. */
  readonly transactions: Counter;
  /** Swap rows produced, by venue and source. */
  readonly swaps: Counter;
  /** Rows written to ClickHouse. */
  readonly rowsWritten: Counter;
  /** Anything the pipeline refused, by reason. Non-zero here needs an answer. */
  readonly dropped: Counter;
  /** Instructions we matched to a venue program but could not decode. */
  readonly parseFailures: Counter;
  /** Errors by stage, so a noisy dependency is obvious. */
  readonly errors: Counter;
  /** Highest slot seen, by source. */
  readonly lastSlot: Gauge;
  /** Seconds between a swap's block time and it reaching the writer. */
  readonly ingestLagSeconds: Gauge;
  /** Rows currently buffered by the writer. */
  readonly pendingRows: Gauge;
  /** Swaps written without a USD price, by reason. */
  readonly unpriced: Counter;
}

export function createIngestMetrics(registry = new MetricsRegistry()): IngestMetrics {
  return {
    registry,
    transactions: registry.counter(
      'exitliquidity_transactions_total',
      'Transactions received and handed to the pipeline',
    ),
    swaps: registry.counter('exitliquidity_swaps_total', 'Swap rows produced by venue parsers'),
    rowsWritten: registry.counter(
      'exitliquidity_rows_written_total',
      'Swap rows successfully inserted into ClickHouse',
    ),
    dropped: registry.counter(
      'exitliquidity_dropped_total',
      'Swaps discarded before insert, labelled by reason',
    ),
    parseFailures: registry.counter(
      'exitliquidity_parse_failures_total',
      'Venue instructions matched but not decodable',
    ),
    errors: registry.counter('exitliquidity_errors_total', 'Errors by stage'),
    lastSlot: registry.gauge('exitliquidity_last_slot', 'Highest slot observed'),
    ingestLagSeconds: registry.gauge(
      'exitliquidity_ingest_lag_seconds',
      'Seconds between block time and reaching the writer',
    ),
    pendingRows: registry.gauge('exitliquidity_pending_rows', 'Rows buffered by the writer'),
    unpriced: registry.counter(
      'exitliquidity_unpriced_total',
      'Swaps written with usd_value NULL, labelled by reason',
    ),
  };
}
