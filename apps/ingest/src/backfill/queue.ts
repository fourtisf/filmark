import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { describeError, silentLogger, type Logger } from '@exitliquidity/core';
import type { BackfillRequest, BackfillResult, BackfillRunner } from './runner.js';

export const BACKFILL_QUEUE = 'backfill';

export type BackfillJobData = BackfillRequest;

/**
 * A Redis connection configured the way BullMQ requires.
 *
 * `maxRetriesPerRequest: null` is not optional — BullMQ's blocking commands
 * sit on a connection for minutes at a time, and ioredis's default retry cap
 * tears them down mid-wait.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

export function createBackfillQueue(connection: Redis): Queue<BackfillJobData, BackfillResult> {
  return new Queue<BackfillJobData, BackfillResult>(BACKFILL_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      // Keeping a bounded history makes a stuck backfill diagnosable without
      // letting Redis grow without limit.
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });
}

export interface EnqueueOptions extends JobsOptions {
  readonly jobId?: string;
}

/**
 * Queues a backfill.
 *
 * The job id defaults to the address so re-queueing the same token while it is
 * still running is a no-op rather than a second crawl competing for the same
 * RPC budget.
 */
export async function enqueueBackfill(
  queue: Queue<BackfillJobData, BackfillResult>,
  request: BackfillRequest,
  options: EnqueueOptions = {},
): Promise<Job<BackfillJobData, BackfillResult>> {
  const { jobId = `backfill:${request.address}`, ...rest } = options;
  return queue.add('backfill', request, { jobId, ...rest });
}

export interface BackfillWorkerOptions {
  readonly connection: Redis;
  readonly runner: BackfillRunner;
  readonly concurrency?: number;
  readonly logger?: Logger;
}

export function createBackfillWorker(
  options: BackfillWorkerOptions,
): Worker<BackfillJobData, BackfillResult> {
  const logger = options.logger ?? silentLogger;

  const worker = new Worker<BackfillJobData, BackfillResult>(
    BACKFILL_QUEUE,
    async (job) => {
      logger.info({ jobId: job.id, address: job.data.address }, 'backfill job started');
      return options.runner.run(job.data);
    },
    { connection: options.connection, concurrency: options.concurrency ?? 4 },
  );

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, address: job?.data.address, err: describeError(error) },
      'backfill job failed',
    );
  });

  worker.on('completed', (job, result) => {
    logger.info({ jobId: job.id, ...result }, 'backfill job completed');
  });

  return worker;
}
