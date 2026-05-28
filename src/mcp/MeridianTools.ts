import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DEFAULT_STACKS_DIR, queryRigStatus, queryBeads, showDispatch,
  dispatchMolecule, assignBead, reviewDispatch, verifyPr, requestMerge,
  type ReviewDecision,
} from '../rig/queries.js';

interface StatusInput { rig?: string }
interface QueryBeadsInput { rigs?: string[]; status?: string[]; search?: string; type?: string; limit?: number }
interface ShowDispatchInput { dispatch_id: string; rig?: string }
interface DispatchMoleculeInput { rig: string; formula: string; input: string; pack?: string; motivating_bead?: string }
interface AssignBeadInput { bead_id: string; rig: string; assignee: string; claim?: boolean }
interface ReviewDispatchInput { dispatch_id: string; rig?: string; decision: string; notes: string }
interface VerifyPrInput { rig: string; pr_number: number; suite?: string }
interface RequestMergeInput { rig: string; pr_number: number; justification: string }

export interface MeridianToolsOptions {
  readonly stacksDir?: string;
  readonly apiUrl?: string | undefined;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

export function registerMeridianTools(server: McpServer, opts: MeridianToolsOptions = {}): void {
  const stacksDir = opts.stacksDir ?? DEFAULT_STACKS_DIR;
  const apiUrl = opts.apiUrl ?? 'http://localhost:3099';

  server.registerTool(
    'vibesync_status',
    {
      description: 'Return current rig health, active dispatches, and recent bead activity. Safe to call frequently.',
      inputSchema: z.object({
        rig: z.string().optional().describe('Filter to a specific rig name (directory basename under /opt/stacks). Omit for all rigs.'),
      }),
    },
    async ({ rig }: StatusInput) => {
      try {
        return textResult(await queryRigStatus(stacksDir, rig));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'vibesync_query_beads',
    {
      description: 'Cross-rig bead query with filters. Returns matching beads from one or more rigs, each tagged with its rig name.',
      inputSchema: z.object({
        rigs: z.array(z.string()).optional().describe('Rig names to query. Omit to query all rigs with beads (capped at 30).'),
        status: z.array(z.string()).optional().describe('Filter by status: open, in_progress, closed, deferred.'),
        search: z.string().optional().describe('Free-text search term matched against bead titles and descriptions.'),
        type: z.string().optional().describe('Filter by issue_type: task, bug, feature, epic, molecule_root, molecule_step.'),
        limit: z.number().optional().describe('Max beads per rig (default 20).'),
      }),
    },
    async ({ rigs, status, search, type, limit }: QueryBeadsInput) => {
      try {
        return textResult(await queryBeads(stacksDir, { rigs, status, search, type, limit }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'vibesync_show_dispatch',
    {
      description: 'Inspect a completed or in-flight dispatch (molecule). Shows the molecule root, all steps with status, output artifacts, provider info, and related beads.',
      inputSchema: z.object({
        dispatch_id: z.string().describe('The molecule root bead id (e.g. vibesync-mol-abc123).'),
        rig: z.string().optional().describe('Rig name where the dispatch lives. If omitted, searches all rigs.'),
      }),
    },
    async ({ dispatch_id, rig }: ShowDispatchInput) => {
      try {
        return textResult(await showDispatch(stacksDir, dispatch_id, rig));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Tier 2: Write / dispatch (gated — agents should confirm with user first) ──

  server.registerTool(
    'vibesync_dispatch_molecule',
    {
      description: 'Fire a formula (molecule) against a rig. REQUIRES user confirmation before calling — present the dispatch plan to the user first.',
      inputSchema: z.object({
        rig: z.string().describe('Target rig name (directory basename under /opt/stacks).'),
        formula: z.string().describe('Formula name to run (e.g. "code-review", "implement").'),
        input: z.string().describe('Top-level input text for the formula.'),
        pack: z.string().optional().describe('Pack name (default: gastown).'),
        motivating_bead: z.string().optional().describe('Motivating bead ID that triggered this dispatch.'),
      }),
    },
    async ({ rig, formula, input, pack, motivating_bead }: DispatchMoleculeInput) => {
      try {
        return textResult(await dispatchMolecule(apiUrl, { rig, formula, input, pack, motivating_bead, stacksDir }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'vibesync_assign_bead',
    {
      description: 'Assign a bead to a role-agent or user and optionally claim it (set status to in_progress). REQUIRES user confirmation before calling.',
      inputSchema: z.object({
        bead_id: z.string().describe('The bead ID to assign.'),
        rig: z.string().describe('Rig name where the bead lives.'),
        assignee: z.string().describe('Assignee name (agent name or username).'),
        claim: z.boolean().optional().describe('Also claim the bead (set status to in_progress). Default: true.'),
      }),
    },
    async ({ bead_id, rig, assignee, claim }: AssignBeadInput) => {
      try {
        return textResult(await assignBead(stacksDir, { bead_id, rig, assignee, claim }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'vibesync_review_dispatch',
    {
      description: 'Review a completed dispatch: accept, reject, or request changes. Adds review notes to the molecule root bead. Accept also closes the dispatch.',
      inputSchema: z.object({
        dispatch_id: z.string().describe('The molecule root bead ID.'),
        rig: z.string().optional().describe('Rig name (searches all if omitted).'),
        decision: z.enum(['accept', 'reject', 'changes_requested']).describe('Review decision.'),
        notes: z.string().describe('Review notes explaining the decision.'),
      }),
    },
    async ({ dispatch_id, rig, decision, notes }: ReviewDispatchInput) => {
      try {
        return textResult(await reviewDispatch(stacksDir, { dispatch_id, rig, decision: decision as ReviewDecision, notes }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Tier 3: Verification + merge gate ──

  server.registerTool(
    'vibesync_verify_pr',
    {
      description: 'Run a verification suite (typecheck, test, lint) against a rig. Returns structured pass/fail result with output.',
      inputSchema: z.object({
        rig: z.string().describe('Rig name to verify.'),
        pr_number: z.number().describe('PR number (for tracking; the suite runs against the current working tree).'),
        suite: z.string().optional().describe('Verification suite: typecheck (default), test, lint.'),
      }),
    },
    async ({ rig, pr_number, suite }: VerifyPrInput) => {
      try {
        return textResult(await verifyPr(stacksDir, { rig, pr_number, suite }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'vibesync_request_merge',
    {
      description: 'Request merge of a PR. Does NOT merge directly — creates a merge-request bead for human approval. REQUIRES user confirmation.',
      inputSchema: z.object({
        rig: z.string().describe('Rig name where the PR lives.'),
        pr_number: z.number().describe('PR number to merge.'),
        justification: z.string().describe('Why this PR should be merged.'),
      }),
    },
    async ({ rig, pr_number, justification }: RequestMergeInput) => {
      try {
        return textResult(await requestMerge(stacksDir, { rig, pr_number, justification }));
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  );
}
