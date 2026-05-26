/**
 * Letta Memory Update Workflow
 *
 * POC workflow for testing Temporal integration with VibeSync.
 * Wraps Letta memory block updates with durable retry.
 *
 * When Letta returns 502s or timeouts, the workflow automatically
 * retries with exponential backoff. Failed updates stay visible
 * in Temporal UI until resolved.
 */

import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  sleep,
  ApplicationFailure,
} from '@temporalio/workflow';

import type * as activities from '../activities/letta';

// Proxy activities with retry policy
const { updateMemoryBlock } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: {
    initialInterval: '1 second',
    backoffCoefficient: 2,
    maximumInterval: '60 seconds',
    maximumAttempts: 10,
    nonRetryableErrorTypes: ['LettaNotFoundError', 'LettaValidationError'],
  },
});

// Workflow input
export interface MemoryUpdateInput {
  agentId: string;
  blockLabel: string;
  newValue: string;
  source?: string; // What triggered this update (e.g., "vibesync", "webhook")
}

// Workflow result
export interface MemoryUpdateResult {
  success: boolean;
  agentId: string;
  blockLabel: string;
  attempts: number;
  error?: string;
  previousValue?: string;
}

// Signals
export const cancelSignal = defineSignal('cancel');

// Queries
export const statusQuery = defineQuery<{ attempts: number; lastError?: string }>('status');

/**
 * Memory Update Workflow
 *
 * Updates a Letta agent's memory block with automatic retry on failure.
 * Visible in Temporal UI for monitoring and debugging.
 */
export async function MemoryUpdateWorkflow(input: MemoryUpdateInput): Promise<MemoryUpdateResult> {
  const { agentId, blockLabel, newValue, source = 'unknown' } = input;

  let attempts = 0;
  let lastError: string | undefined;
  let cancelled = false;

  // Handle cancel signal
  setHandler(cancelSignal, () => {
    cancelled = true;
  });

  // Handle status query
  setHandler(statusQuery, () => ({
    attempts,
    lastError,
  }));

  console.log(`[MemoryUpdateWorkflow] Starting: agent=${agentId}, block=${blockLabel}, source=${source}`);

  try {
    attempts++;

    const result = await updateMemoryBlock({
      agentId,
      blockLabel,
      newValue,
    });

    console.log(`[MemoryUpdateWorkflow] Success: agent=${agentId}, block=${blockLabel}`);

    return {
      success: true,
      agentId,
      blockLabel,
      attempts,
      ...(result.previousValue !== undefined ? { previousValue: result.previousValue } : {}),
    };

  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);

    console.log(`[MemoryUpdateWorkflow] Failed: agent=${agentId}, block=${blockLabel}, error=${lastError}`);

    return {
      success: false,
      agentId,
      blockLabel,
      attempts,
      error: lastError,
    };
  }
}

// Batch workflow input
export interface BatchMemoryUpdateInput {
  updates: MemoryUpdateInput[];
  source?: string;
}

// Batch workflow result
export interface BatchMemoryUpdateResult {
  total: number;
  succeeded: number;
  failed: number;
  failures: Array<{
    agentId: string;
    blockLabel: string;
    error: string;
  }>;
}

/**
 * Batch Memory Update Workflow
 *
 * Updates multiple agent memory blocks in parallel.
 * Use after a sync cycle when multiple agents need updates.
 */
export async function BatchMemoryUpdateWorkflow(
  input: BatchMemoryUpdateInput
): Promise<BatchMemoryUpdateResult> {
  const { updates } = input;

  console.log(`[BatchMemoryUpdateWorkflow] Starting batch of ${updates.length} updates`);

  const results: BatchMemoryUpdateResult = {
    total: updates.length,
    succeeded: 0,
    failed: 0,
    failures: [],
  };

  // Process updates in parallel (Temporal handles concurrency)
  const promises = updates.map(async (update) => {
    try {
      const result = await updateMemoryBlock({
        agentId: update.agentId,
        blockLabel: update.blockLabel,
        newValue: update.newValue,
      });

      if (result.success) {
        results.succeeded++;
      } else {
        results.failed++;
        results.failures.push({
          agentId: update.agentId,
          blockLabel: update.blockLabel,
          error: 'Update returned success=false',
        });
      }
    } catch (error) {
      results.failed++;
      results.failures.push({
        agentId: update.agentId,
        blockLabel: update.blockLabel,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await Promise.all(promises);

  console.log(
    `[BatchMemoryUpdateWorkflow] Complete: ${results.succeeded}/${results.total} succeeded`
  );

  return results;
}
