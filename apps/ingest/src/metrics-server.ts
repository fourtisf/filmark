import { createServer, type Server } from 'node:http';
import { describeError, silentLogger, type IngestMetrics, type Logger } from '@exitliquidity/core';

export interface MetricsServerOptions {
  readonly port: number;
  readonly metrics: IngestMetrics;
  readonly logger?: Logger;
  /** Reports readiness on `/readyz`. Absent means always ready. */
  readonly isReady?: () => boolean;
}

/**
 * `/metrics`, `/healthz` and `/readyz`.
 *
 * Liveness and readiness are separate on purpose: a consumer reconnecting to a
 * dropped geyser stream is alive and should not be restarted, but it is not
 * ready and should not be counted as ingesting.
 */
export function startMetricsServer(options: MetricsServerOptions): Server {
  const logger = options.logger ?? silentLogger;

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];

    switch (path) {
      case '/metrics':
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(options.metrics.registry.render());
        return;
      case '/healthz':
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok\n');
        return;
      case '/readyz': {
        const ready = options.isReady?.() ?? true;
        response.writeHead(ready ? 200 : 503, { 'content-type': 'text/plain' });
        response.end(ready ? 'ready\n' : 'not ready\n');
        return;
      }
      default:
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('not found\n');
    }
  });

  server.on('error', (error) => {
    logger.error({ err: describeError(error) }, 'metrics server error');
  });

  server.listen(options.port, () => {
    logger.info({ port: options.port }, 'metrics server listening');
  });

  return server;
}
