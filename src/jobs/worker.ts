/**
 * The reply worker: polls the shared queue and runs reply jobs (spec 1.8).
 *
 *  - every WORKER_POLL_MS, claims up to WORKER_CONCURRENCY jobs GLOBALLY
 *    (p_client_id NULL: the poller has no tenant of its own) and runs each in
 *    the background;
 *  - every minute, reaps stale running jobs via requeue_stale_jobs(5);
 *  - on error a job goes back to pending with backoff (failJob), exhausted
 *    jobs (attempts >= 3) go to failed with last_error;
 *  - SIGINT/SIGTERM: stop claiming, let in-flight jobs finish (15s cap).
 *
 * The worker never logs prompts, replies, keys or phone numbers: the pipeline
 * owns all content, and this loop logs ids and counts only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import {
  claimDueJob,
  failJob,
  markJobDone,
  requeueStaleJobs,
} from "../db/supabase.js";
import type { Job } from "../db/types.js";
import type { LlmAdapter } from "../ai/llm.js";
import { createFallbackLlmAdapter } from "../ai/index.js";
import {
  consoleNotifier,
  runReplyJob,
  type PipelineDeps,
  type StaffNotifier,
} from "./pipeline.js";

export type WorkerDeps = {
  supabase: SupabaseClient;
  logger: Logger;
  config: AppConfig;
  llm: LlmAdapter;
  notifier?: StaffNotifier;
  sendGapMs?: number;
  consoleOut?: { write(chunk: string): void };
};

export type WorkerHandle = {
  /** Stops claiming and waits for in-flight jobs (15s cap). Resolves when stopped. */
  stop(): Promise<void>;
};

const REQUEUE_EVERY_MS = 60_000;
const STALE_MINUTES = 5;
const STOP_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Builds the pipeline deps for one job run. Exported for tests and scripts. */
export function pipelineDepsFor(
  deps: WorkerDeps,
): Omit<PipelineDeps, "config"> & { config: AppConfig } {
  const llmConfig = deps.config.llm;
  if (llmConfig === null)
    throw new Error(
      "worker needs LLM config (LLM_PROVIDER, LLM_API_KEY, LLM_MODEL)",
    );
  return {
    supabase: deps.supabase,
    logger: deps.logger,
    llm: deps.llm,
    fallbackLlm: createFallbackLlmAdapter(llmConfig, deps.logger) ?? undefined,
    llmConfig,
    config: deps.config,
    notifier: deps.notifier ?? consoleNotifier(deps.logger),
    sendGapMs: deps.sendGapMs,
    consoleOut: deps.consoleOut,
  };
}

/**
 * Runs one claimed job and records the outcome: done on success, back to
 * pending with backoff (or failed when attempts are exhausted) on error.
 * Returns the outcome for callers that report it (scripts/chat.ts); the poll
 * loop logs its own lines. Shared by the poll loop and scripts so both settle
 * jobs identically.
 */
export async function settleJob(
  supabase: SupabaseClient,
  logger: Logger,
  pipeline: Omit<PipelineDeps, "config"> & { config: AppConfig },
  job: Job,
): Promise<{
  outcome: "done" | "retried" | "failed";
  error?: string;
  fallback?: string | null;
}> {
  try {
    const { fallback } = await runReplyJob(pipeline, job);
    await markJobDone(supabase, job.id);
    logger.info({ jobId: job.id, clientId: job.client_id }, "reply job done");
    return { outcome: "done", fallback };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const outcome = await failJob(supabase, job, message);
      logger.warn(
        { jobId: job.id, clientId: job.client_id, outcome },
        `reply job ${outcome}`,
      );
      return { outcome, error: message };
    } catch (dbErr) {
      logger.error(
        { err: dbErr, jobId: job.id },
        "could not record the job failure",
      );
      return { outcome: "failed", error: message };
    }
  }
}

export function startWorker(deps: WorkerDeps): WorkerHandle {
  const { supabase, logger, config } = deps;
  const pipeline = pipelineDepsFor(deps);
  let claiming = true;
  const inFlight = new Set<Promise<void>>();
  let lastRequeue = 0;

  const settle = async (job: Job): Promise<void> => {
    await settleJob(supabase, logger, pipeline, job);
  };

  const loop = async (): Promise<void> => {
    while (claiming) {
      try {
        if (Date.now() - lastRequeue >= REQUEUE_EVERY_MS) {
          lastRequeue = Date.now();
          const moved = await requeueStaleJobs(supabase, STALE_MINUTES);
          if (moved > 0) logger.info({ moved }, "stale jobs requeued");
        }
        while (claiming && inFlight.size < config.worker.concurrency) {
          const job = await claimDueJob(supabase, null);
          if (job === null) break;
          const task = settle(job).finally(() => {
            inFlight.delete(task);
          });
          inFlight.add(task);
        }
      } catch (err) {
        logger.error({ err }, "worker poll failed");
      }
      await sleep(config.worker.pollMs);
    }
  };

  void loop().catch((err: unknown) => {
    logger.error({ err }, "worker loop crashed");
  });

  return {
    async stop(): Promise<void> {
      claiming = false;
      if (inFlight.size === 0) return;
      logger.info(
        { inFlight: inFlight.size },
        "worker stopping: waiting for in-flight jobs",
      );
      await Promise.race([
        Promise.allSettled([...inFlight]),
        sleep(STOP_TIMEOUT_MS).then(() => {
          logger.warn(
            { inFlight: inFlight.size },
            "worker stop timed out: leaving jobs running",
          );
        }),
      ]);
    },
  };
}
