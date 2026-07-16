import type { EventBus } from '../events/index.js';
import { randomUUID } from 'node:crypto';

import type { Formula } from '../formula/index.js';
import type { MoleculeWalker } from '../molecule/index.js';
import type { BeadRow } from '../store/index.js';
import type { Pack, RoleConfig } from '../packs/index.js';
import type { RuntimeProvider, SessionEvent, SessionHandle } from '../runtime/index.js';
import { renderTemplate } from './render.js';

/**
 * FormulaDispatcher runs formula steps and records enough provider-opaque
 * execution metadata on molecule-step beads to resume after restart.
 * Whole-molecule runs can be capped with `maxConcurrentMolecules`; calls
 * above that limit wait in a FIFO in-process queue so a burst of formula runs
 * cannot consume every runtime teammate slot at once.
 * Ready steps fan out in parallel up to `maxParallelSteps`; dependency ordering
 * still comes from MoleculeWalker, so formulas can opt into parallelism by
 * declaring independent steps.
 *
 * Example restart recovery:
 *
 *   await dispatcher.resume('hvsyn-mol-abc123')
 *
 * `resume()` re-attaches only to steps already marked `in_progress` with
 * `metadata.exec.task_id`; it does not redispatch open successor steps.
 */

export interface DispatchInput {
  readonly formula: Formula;
  readonly pack: Pack;
  readonly input: string;
  readonly motivatingBeadId?: string;
  /**
   * Per-project routing key (vibesync-f5g / vibesync-8hk). When set,
   * the dispatcher consults its ProviderResolver to pick the right
   * RuntimeProvider for this run (e.g. LettaCodeSubagentProvider for
   * local-backend projects). When omitted,
   * the dispatcher uses the default provider supplied at construction
   * time — preserving backwards-compatibility with every existing
   * caller / test that pre-dates the routing path.
   */
  readonly projectIdentifier?: string;
}

/**
 * Routes a dispatch to the right RuntimeProvider based on the project
 * identifier. Implementations look up the per-project routing row
 * (provider_kind, letta_base_url) and either return a cached provider
 * or construct a project-scoped one. See ProjectLettaRepository.
 *
 * The resolver MAY return null to fall back to the dispatcher's
 * default provider — useful when the routing row exists but has no
 * override.
 */
export interface ProviderResolver {
  resolve(input: DispatchInput): Promise<RuntimeProvider | null> | RuntimeProvider | null;
}

/**
 * vibesync-mcz Phase D — per-(project, role) persistent subagent
 * bootstrap hook the dispatcher invokes before starting each step.
 *
 * Returning a non-null agentId opts the step into the persistent path
 * (LettaCodeSubagentProvider dispatches via Agent.agent_id, persona
 * NOT inlined). Returning null falls back to today's inline-persona
 * path — useful for projects that haven't been bootstrapped yet, or
 * tests that want the old behavior.
 *
 * Throwing fails the dispatch fast (current attempt rejects; the
 * step's retry policy still applies if configured). The bead is
 * deliberate: a missing persona / unreachable shim at bootstrap time
 * is a configuration error, not a transient runtime degradation, and
 * silently inlining persona would obscure it.
 */
export interface RoleAgentBootstrapperLike {
  ensureRoleAgent(args: {
    readonly projectIdentifier: string;
    readonly role: string;
    readonly packDir: string;
    readonly lettaBaseUrl: string;
    readonly storageDir: string;
  }): Promise<{ readonly agentId: string }>;
}

/**
 * Resolves the role-agent bootstrap context for a given dispatch.
 * Returning null means "no persistent-subagent bootstrap for this
 * dispatch" — the dispatcher then skips the bootstrap call and the
 * provider falls back to the inline-persona path. Returning a
 * context wires the bootstrapper for every step of this molecule.
 *
 * Exists as a seam so boot can derive packDir/lettaBaseUrl/storageDir
 * from the same per-project routing row the provider resolver uses,
 * without the dispatcher having to know about projects/packs/shims.
 */
export interface RoleAgentBootstrapContextResolver {
  resolve(input: DispatchInput): Promise<{
    readonly bootstrapper: RoleAgentBootstrapperLike;
    readonly packDir: string;
    readonly lettaBaseUrl: string;
    readonly storageDir: string;
  } | null> | {
    readonly bootstrapper: RoleAgentBootstrapperLike;
    readonly packDir: string;
    readonly lettaBaseUrl: string;
    readonly storageDir: string;
  } | null;
}

/**
 * Mint a fresh per-step conversation id. Default is uuid-based so
 * collisions are impossible in practice; tests inject a counter to
 * get deterministic ids.
 */
export interface ConversationIdGenerator {
  next(): string;
}

export interface DispatchResult {
  readonly moleculeId: string;
  readonly outputs: Readonly<Record<string, string>>;
}

export interface CancelResult {
  readonly moleculeId: string;
  readonly cancelledStepCount: number;
}

export interface FormulaDispatcherOptions {
  readonly provider: RuntimeProvider;
  readonly walker: MoleculeWalker;
  readonly eventBus: EventBus;
  readonly idPrefix?: string;
  readonly maxParallelSteps?: number;
  readonly maxConcurrentMolecules?: number;
  /**
   * Optional per-dispatch provider resolver (vibesync-f5g / vibesync-8hk).
   * When supplied, the dispatcher consults this before falling back
   * to the default `provider`. A resolver that returns null for a
   * given dispatch yields the default — same as if no resolver were
   * configured. Resolution happens once per run; the chosen provider
   * is then used for every step (and on cancel/resume) of that
   * molecule, so concurrent runs against different projects can hit
   * different providers without interfering.
   */
  readonly providerResolver?: ProviderResolver;
  /**
   * vibesync-mcz Phase D — optional persistent-subagent bootstrap
   * context resolver. When supplied AND the resolver returns a
   * non-null context for this dispatch, the dispatcher calls
   * `bootstrapper.ensureRoleAgent` before each step's
   * `provider.start()`, threading the resulting agentId through
   * `extra.agentId` so the provider dispatches against the
   * persistent role agent (Phase C path). Failures fail the
   * dispatch fast — same posture as a missing pack role.
   */
  readonly roleAgentContextResolver?: RoleAgentBootstrapContextResolver;
  /**
   * vibesync-mcz Phase D — injectable conversation-id generator.
   * Defaults to a uuid-based generator. Tests inject a counter for
   * deterministic ids; resume code paths re-use stored ids and never
   * call into this generator.
   */
  readonly conversationIdGenerator?: ConversationIdGenerator;
}

interface QueuedMoleculeRun {
  readonly input: DispatchInput;
  readonly resolve: () => void;
}

export class FormulaDispatchError extends Error {
  constructor(
    message: string,
    readonly moleculeId: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = 'FormulaDispatchError';
  }
}

export class FormulaCancellationConflictError extends FormulaDispatchError {
  constructor(message: string, moleculeId: string) {
    super(message, moleculeId);
    this.name = 'FormulaCancellationConflictError';
  }
}

export class FormulaDispatcher {
  private readonly defaultProvider: RuntimeProvider;
  private readonly walker: MoleculeWalker;
  private readonly eventBus: EventBus;
  private readonly idPrefix: string;
  private readonly maxParallelSteps: number;
  private readonly maxConcurrentMolecules: number;
  private readonly providerResolver: ProviderResolver | null;
  private readonly roleAgentContextResolver: RoleAgentBootstrapContextResolver | null;
  private readonly conversationIdGenerator: ConversationIdGenerator;
  private readonly moleculeQueue: QueuedMoleculeRun[] = [];
  private activeMolecules = 0;

  constructor(opts: FormulaDispatcherOptions) {
    this.defaultProvider = opts.provider;
    this.walker = opts.walker;
    this.eventBus = opts.eventBus;
    this.idPrefix = opts.idPrefix ?? 'mol';
    this.maxParallelSteps = normalizeMaxParallelSteps(opts.maxParallelSteps);
    this.maxConcurrentMolecules = normalizeMaxConcurrentMolecules(opts.maxConcurrentMolecules);
    this.providerResolver = opts.providerResolver ?? null;
    this.roleAgentContextResolver = opts.roleAgentContextResolver ?? null;
    this.conversationIdGenerator =
      opts.conversationIdGenerator ?? createDefaultConversationIdGenerator();
  }

  /**
   * Back-compat alias: many callsites and tests still read
   * `dispatcher.provider` to introspect which RuntimeProvider was
   * wired in at boot. Returns the default; per-dispatch overrides
   * resolved at run time are NOT visible here.
   */
  get provider(): RuntimeProvider {
    return this.defaultProvider;
  }

  /**
   * Resolve the RuntimeProvider for a given dispatch. Returns the
   * default when no resolver is configured, the resolver yields null,
   * or the dispatch has no projectIdentifier.
   *
   * Exposed for tests; production code goes through run().
   */
  async resolveProvider(input: DispatchInput): Promise<RuntimeProvider> {
    if (!this.providerResolver || !input.projectIdentifier) return this.defaultProvider;
    const resolved = await this.providerResolver.resolve(input);
    return resolved ?? this.defaultProvider;
  }

  /**
   * Resolve the persistent-subagent bootstrap context for a dispatch
   * (vibesync-mcz Phase D). Returns null when no resolver is wired
   * or the resolver opts out for this dispatch — in which case every
   * step falls through to the inline-persona path.
   *
   * Exposed for tests; production code goes through run().
   */
  async resolveRoleAgentContext(input: DispatchInput): Promise<{
    readonly bootstrapper: RoleAgentBootstrapperLike;
    readonly packDir: string;
    readonly lettaBaseUrl: string;
    readonly storageDir: string;
  } | null> {
    if (!this.roleAgentContextResolver || !input.projectIdentifier) return null;
    const resolved = await this.roleAgentContextResolver.resolve(input);
    return resolved ?? null;
  }

  async run(input: DispatchInput): Promise<DispatchResult> {
    await this.acquireMoleculeSlot(input);
    try {
      return await this.runNow(input);
    } finally {
      this.releaseMoleculeSlot();
    }
  }

  getQueueDepth(): number {
    return this.moleculeQueue.length;
  }

  getActiveMoleculeCount(): number {
    return this.activeMolecules;
  }

  private async runNow(input: DispatchInput): Promise<DispatchResult> {
    const startedAt = Date.now();
    const provider = await this.resolveProvider(input);
    const roleAgentContext = await this.resolveRoleAgentContext(input);
    const view = await this.walker.dispatch({
      prefix: this.idPrefix,
      formulaName: input.formula.name,
      title: `[formula:${input.formula.name}] ${input.formula.description || input.input.slice(0, 80)}`,
      ...(input.motivatingBeadId ? { motivatingBeadId: input.motivatingBeadId } : {}),
      steps: input.formula.steps,
    });
    const moleculeId = view.rootId;
    const outputs: Record<string, string> = {};
    const rolesByName = new Map(input.pack.roles.map((role) => [role.name, role]));

    this.emit('dispatcher/formula.started', moleculeId, undefined, {
      formulaName: input.formula.name,
      moleculeId,
      stepCount: input.formula.steps.length,
      providerKind: provider.kind,
      ...(input.projectIdentifier ? { projectIdentifier: input.projectIdentifier } : {}),
    });

    try {
      while (!(await this.walker.isComplete(moleculeId))) {
        const ready = await this.walker.findReady(moleculeId);
        if (ready.length === 0) {
          throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} has no ready steps but is incomplete`, moleculeId);
        }
        const batch = ready.slice(0, this.maxParallelSteps);
        const settled = await Promise.allSettled(batch.map((step) => this.runStep({ input, step, moleculeId, outputs, rolesByName, provider, roleAgentContext })));
        const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) throw failed.reason;
      }
    } catch (error) {
      await this.walker.markMoleculeRootStatus(moleculeId, 'closed', 'failed');
      this.emit('dispatcher/formula.failed', moleculeId, undefined, {
        moleculeId,
        error: stringifyError(error),
        // vibesync-u32z: carry the motivating bead on the completion event so
        // the writeback hook can resolve it directly from the event, without
        // depending solely on re-reading the persisted molecule_root row (a
        // single point of failure if any dispatch path or Dolt write dropped
        // the exec.motivating_bead stamp).
        ...(input.motivatingBeadId ? { motivating_bead: input.motivatingBeadId } : {}),
      });
      throw error;
    }

    await this.walker.markMoleculeRootStatus(moleculeId, 'closed', 'completed');
    this.emit('dispatcher/formula.completed', moleculeId, undefined, {
      moleculeId,
      durationMs: Date.now() - startedAt,
      // vibesync-u32z: see the failure branch above — the completion event is
      // now self-describing so the writeback hook never has to reverse-engineer
      // the motivating bead from a row that may not carry it.
      ...(input.motivatingBeadId ? { motivating_bead: input.motivatingBeadId } : {}),
    });
    return { moleculeId, outputs };
  }

  private acquireMoleculeSlot(input: DispatchInput): Promise<void> {
    if (this.activeMolecules < this.maxConcurrentMolecules) {
      this.activeMolecules++;
      return Promise.resolve();
    }

    const position = this.moleculeQueue.length + 1;
    const depth = position;
    this.emit('dispatcher/formula.queued', undefined, undefined, {
      formulaName: input.formula.name,
      pack: input.pack.manifest.name,
      depth,
      position,
      active: this.activeMolecules,
      maxConcurrentMolecules: this.maxConcurrentMolecules,
    });

    return new Promise<void>((resolve) => {
      this.moleculeQueue.push({ input, resolve });
    });
  }

  private releaseMoleculeSlot(): void {
    this.activeMolecules--;
    const next = this.moleculeQueue.shift();
    if (!next) return;
    this.activeMolecules++;
    next.resolve();
  }

  async resume(moleculeId: string): Promise<DispatchResult> {
    const startedAt = Date.now();
    const view = await this.walker.load(moleculeId);
    if (!view) {
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    }

    const outputs = outputsFromClosedSteps(view.steps);
    // vibesync-u32z: on resume, `input` is not in scope — recover the
    // motivating bead from the persisted molecule_root exec so the completion
    // event stays self-describing across a restart/resume too.
    const motivatingBeadId = readMotivatingBead(view.root);
    this.emit('dispatcher/formula.resumed', moleculeId, undefined, {
      moleculeId,
      runningStepCount: view.steps.filter((step) => step.status === 'in_progress').length,
    });

    const running = await this.walker.findRunning(moleculeId);
    if (running.length === 0) {
      if (await this.walker.isComplete(moleculeId)) {
        this.emit('dispatcher/formula.completed', moleculeId, undefined, {
          moleculeId,
          durationMs: Date.now() - startedAt,
          resumed: true,
          ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
        });
        return { moleculeId, outputs };
      }
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} has no running steps to resume`, moleculeId);
    }

    try {
      for (const step of running) {
        await this.resumeStep({ step, moleculeId, outputs });
      }
    } catch (error) {
      this.emit('dispatcher/formula.failed', moleculeId, undefined, {
        moleculeId,
        error: stringifyError(error),
        resumed: true,
        ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
      });
      throw error;
    }

    if (await this.walker.isComplete(moleculeId)) {
      this.emit('dispatcher/formula.completed', moleculeId, undefined, {
        moleculeId,
        durationMs: Date.now() - startedAt,
        resumed: true,
        ...(motivatingBeadId ? { motivating_bead: motivatingBeadId } : {}),
      });
    } else {
      this.emit('dispatcher/formula.resume.paused', moleculeId, undefined, {
        moleculeId,
        reason: 'running steps completed; open successors require a fresh formula run context',
      });
    }

    return { moleculeId, outputs };
  }

  async cancel(moleculeId: string): Promise<CancelResult> {
    const view = await this.walker.load(moleculeId);
    if (!view) {
      throw new FormulaDispatchError(`FormulaDispatcher: molecule ${moleculeId} not found`, moleculeId);
    }
    const running = await this.walker.findRunning(moleculeId);
    if (running.length === 0) {
      throw new FormulaCancellationConflictError(`FormulaDispatcher: molecule ${moleculeId} has no running steps to cancel`, moleculeId);
    }

    let cancelledStepCount = 0;
    for (const step of running) {
      const stepName = readStepName(step);
      const role = readStepRole(step);
      const exec = readExec(step);
      const sessionId = readString(exec.session_id);
      const providerKind = readString(exec.provider_kind);
      const taskId = readString(exec.task_id) ?? undefined;
      if (sessionId && providerKind) {
        await this.provider.stop({ id: sessionId, providerKind });
      }
      await this.walker.failStep(step.id, 'cancelled');
      cancelledStepCount++;
      this.emit('dispatcher/step.cancelled', moleculeId, taskId, {
        stepName,
        role,
        stepId: step.id,
        ...(sessionId ? { sessionId } : {}),
      });
    }

    await this.walker.markMoleculeRootStatus(moleculeId, 'closed', 'cancelled');
    this.emit('dispatcher/formula.cancelled', moleculeId, undefined, {
      moleculeId,
      cancelledStepCount,
    });
    return { moleculeId, cancelledStepCount };
  }

  private async runStep(args: {
    readonly input: DispatchInput;
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
    readonly rolesByName: ReadonlyMap<string, RoleConfig>;
    readonly provider: RuntimeProvider;
    readonly roleAgentContext: {
      readonly bootstrapper: RoleAgentBootstrapperLike;
      readonly packDir: string;
      readonly lettaBaseUrl: string;
      readonly storageDir: string;
    } | null;
  }): Promise<void> {
    const stepName = readStepName(args.step);
    const stepSpec = args.input.formula.steps.find((candidate) => candidate.name === stepName);
    if (!stepSpec) {
      throw new FormulaDispatchError(`FormulaDispatcher: no formula step for molecule bead ${args.step.id}`, args.moleculeId);
    }
    const roleConfig = args.rolesByName.get(stepSpec.role);
    if (!roleConfig) {
      throw new FormulaDispatchError(`FormulaDispatcher: pack ${args.input.pack.manifest.name} has no role "${stepSpec.role}"`, args.moleculeId);
    }
    if (!stepSpec.promptTemplate) {
      throw new FormulaDispatchError(`FormulaDispatcher: step "${stepName}" has no promptTemplate`, args.moleculeId);
    }

    const maxAttempts = (stepSpec.retries ?? 0) + 1;
    const retryBackoffMs = stepSpec.retryBackoffMs ?? 1000;
    const rendered = renderTemplate({
      packRoot: args.input.pack.root,
      template: stepSpec.promptTemplate,
      context: renderContext(args.input.input, args.outputs),
    });

    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.walker.recordStepAttempt(args.step.id, attempt);
        const output = await this.runStepAttempt({
          stepId: args.step.id,
          stepName,
          role: stepSpec.role,
          roleConfig,
          moleculeId: args.moleculeId,
          formulaName: args.input.formula.name,
          rendered,
          attempt,
          provider: args.provider,
          ...(args.input.projectIdentifier ? { projectIdentifier: args.input.projectIdentifier } : {}),
          roleAgentContext: args.roleAgentContext,
          ...(stepSpec.turnTimeoutMs !== undefined ? { turnTimeoutMs: stepSpec.turnTimeoutMs } : {}),
        });
        args.outputs[stepName] = output.text;
        await this.walker.finishStep(args.step.id, { output: output.text, eventCount: output.eventCount, attempts: attempt });
        this.emit('dispatcher/step.finished', args.moleculeId, args.step.id, {
          stepName,
          role: stepSpec.role,
          stepId: args.step.id,
          outputLength: output.text.length,
          attempts: attempt,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;
        this.emit('dispatcher/step.retry', args.moleculeId, args.step.id, {
          stepName,
          role: stepSpec.role,
          stepId: args.step.id,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          backoffMs: retryBackoffMs,
          reason: stringifyError(error),
        });
        await sleep(retryBackoffMs);
      }
    }

    await this.walker.failStep(args.step.id, stringifyError(lastError));
    this.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
      stepName,
      role: stepSpec.role,
      stepId: args.step.id,
      error: stringifyError(lastError),
      attempts: maxAttempts,
    });
    throw new FormulaDispatchError(`FormulaDispatcher: step "${stepName}" failed`, args.moleculeId, { cause: lastError });
  }

  private async runStepAttempt(args: {
    readonly stepId: string;
    readonly stepName: string;
    readonly role: string;
    readonly roleConfig: RoleConfig;
    readonly moleculeId: string;
    readonly formulaName: string;
    readonly rendered: string;
    readonly attempt: number;
    readonly provider: RuntimeProvider;
    readonly projectIdentifier?: string;
    readonly roleAgentContext: {
      readonly bootstrapper: RoleAgentBootstrapperLike;
      readonly packDir: string;
      readonly lettaBaseUrl: string;
      readonly storageDir: string;
    } | null;
    readonly turnTimeoutMs?: number;
  }): Promise<{ readonly text: string; readonly eventCount: number }> {
    this.emit('dispatcher/step.started', args.moleculeId, args.stepId, {
      stepName: args.stepName,
      role: args.role,
      stepId: args.stepId,
      attempt: args.attempt,
    });

    // vibesync-mcz Phase D: bootstrap the persistent role agent (if a
    // context resolver is wired AND we know the project). Failures
    // here are fail-fast — same posture as a missing pack role. The
    // resulting agentId rides through extra.agentId, where the
    // LettaCodeSubagentProvider (Phase C) picks it up and dispatches
    // via Agent.agent_id with no persona inlining. Other providers
    // ignore the extra field entirely.
    let bootstrappedAgentId: string | null = null;
    if (args.roleAgentContext && args.projectIdentifier) {
      const bootstrapResult = await args.roleAgentContext.bootstrapper.ensureRoleAgent({
        projectIdentifier: args.projectIdentifier,
        role: args.role,
        packDir: args.roleAgentContext.packDir,
        lettaBaseUrl: args.roleAgentContext.lettaBaseUrl,
        storageDir: args.roleAgentContext.storageDir,
      });
      bootstrappedAgentId = bootstrapResult.agentId;
      this.emit('dispatcher/step.role_agent_bootstrapped', args.moleculeId, args.stepId, {
        stepName: args.stepName,
        role: args.role,
        stepId: args.stepId,
        agentId: bootstrappedAgentId,
        projectIdentifier: args.projectIdentifier,
      });
    }

    // vibesync-mcz Phase D: per-step conversation_id so concurrent
    // dispatches of the same role on the same project don't corrupt
    // each other's context. Persisted on the step bead so resume can
    // re-attach to the same conversation on the persistent agent.
    const conversationId = bootstrappedAgentId
      ? this.conversationIdGenerator.next()
      : null;

    let handle: Awaited<ReturnType<RuntimeProvider['start']>> | null = null;
    let eventCount = 0;
    let output = '';
    try {
      await this.walker.startStep(args.stepId);
      handle = await args.provider.start({
        role: args.role,
        label: `${args.formulaName}/${args.stepName}`,
        extra: {
          moleculeId: args.moleculeId,
          stepName: args.stepName,
          attempt: args.attempt,
          memfsEnabled: false,
          memoryBlocks: args.roleConfig.memoryBlocks ?? [],
          ...(args.roleConfig.memoryBlocksPolicy?.mode === 'replace' ? { memoryBlockSeedMode: 'replace' } : {}),
          ...(args.roleConfig.tools && args.roleConfig.tools.length > 0 ? { tools: [...args.roleConfig.tools] } : {}),
          ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
          ...(bootstrappedAgentId ? { agentId: bootstrappedAgentId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(args.turnTimeoutMs !== undefined ? { turnTimeoutMs: args.turnTimeoutMs } : {}),
        },
      });
      const promptResult = await args.provider.prompt(handle, [{ type: 'text', text: args.rendered }]);
      // vibesync-mcz Phase D/F: persist execution metadata whenever
      // we have anything meaningful to persist — a taskId (f5g
      // resume contract) OR a conversationId (mcz per-dispatch
      // isolation contract). Earlier revisions gated this entirely
      // on taskId, which silently dropped conversationId for
      // providers that report taskId asynchronously via SSE rather
      // than synchronously on prompt() (the LettaCodeSubagentProvider
      // case). Persist what we have; absent fields are simply not
      // written.
      if (promptResult.taskId || conversationId) {
        await this.walker.recordStepTask(args.stepId, {
          ...(promptResult.taskId ? { taskId: promptResult.taskId } : {}),
          providerKind: handle.providerKind,
          sessionId: handle.id,
          ...(conversationId ? { conversationId } : {}),
        });
        this.emit('dispatcher/step.task_recorded', args.moleculeId, promptResult.taskId, {
          stepName: args.stepName,
          role: args.role,
          stepId: args.stepId,
          sessionId: handle.id,
          attempt: args.attempt,
          ...(conversationId ? { conversationId } : {}),
        });
      }
      for await (const event of args.provider.observe(handle)) {
        eventCount++;
        this.emitRuntimeSessionEvent(event, {
          moleculeId: args.moleculeId,
          stepId: args.stepId,
          stepName: args.stepName,
          role: args.role,
          attempt: args.attempt,
          providerKind: handle.providerKind,
          sessionId: handle.id,
          ...(promptResult.taskId ? { taskId: promptResult.taskId } : {}),
          ...(conversationId ? { conversationId } : {}),
          ...(bootstrappedAgentId ? { agentId: bootstrappedAgentId } : {}),
          ...(args.projectIdentifier ? { projectIdentifier: args.projectIdentifier } : {}),
        });
        if (event.kind === 'message-delta') output += event.text;
        if (event.kind === 'error') throw new Error(event.message);
        if (event.kind === 'stopped') throw new Error('runtime stopped before turn completion');
        if (event.kind === 'turn-done') {
          // vibesync-uuas: a turn that ended on requires_approval did NOT
          // do the work — the agent halted waiting for an approver that
          // never comes on the headless dispatch path. Treating it as
          // success closes the step green with empty output (silent
          // failure). Fail the step instead so retries/visibility kick in.
          if (event.stopReason === 'requires_approval') {
            throw new Error(
              'runtime halted on requires_approval — no approver attached for headless dispatch; ' +
                'the Agent/tool call never executed (set SHIM_PERMISSION_MODE=bypassPermissions on the shim)',
            );
          }
          break;
        }
      }
      return { text: output, eventCount };
    } finally {
      if (handle) await args.provider.stop(handle);
    }
  }

  private async resumeStep(args: {
    readonly step: BeadRow;
    readonly moleculeId: string;
    readonly outputs: Record<string, string>;
  }): Promise<void> {
    const stepName = readStepName(args.step);
    const role = readStepRole(args.step);
    const exec = readExec(args.step);
    const taskId = readString(exec.task_id);
    if (!taskId) {
      const error = `FormulaDispatcher.resume: running step ${args.step.id} has no metadata.exec.task_id`;
      await this.walker.failStep(args.step.id, error);
      this.emit('dispatcher/step.failed', args.moleculeId, args.step.id, { stepName, role, stepId: args.step.id, error });
      throw new FormulaDispatchError(error, args.moleculeId);
    }

    let handle: SessionHandle | null = null;
    let eventCount = 0;
    let output = '';
    try {
      handle = await this.provider.start({
        role,
        label: `resume/${args.moleculeId}/${stepName}`,
        extra: {
          moleculeId: args.moleculeId,
          stepName,
          resumeTaskId: taskId,
          memfsEnabled: false,
        },
      });
      this.emit('dispatcher/step.reattached', args.moleculeId, taskId, {
        stepName,
        role,
        stepId: args.step.id,
        sessionId: handle.id,
      });
      for await (const event of this.provider.observe(handle)) {
        eventCount++;
        this.emitRuntimeSessionEvent(event, {
          moleculeId: args.moleculeId,
          stepId: args.step.id,
          stepName,
          role,
          providerKind: handle.providerKind,
          sessionId: handle.id,
          taskId,
          resumed: true,
        });
        if (event.kind === 'message-delta') output += event.text;
        if (event.kind === 'error') throw new Error(event.message);
        if (event.kind === 'stopped') throw new Error('runtime stopped before turn completion');
        if (event.kind === 'turn-done') break;
      }
      args.outputs[stepName] = output;
      await this.walker.finishStep(args.step.id, { output, eventCount, resumed: true });
      this.emit('dispatcher/step.finished', args.moleculeId, args.step.id, {
        stepName,
        role,
        stepId: args.step.id,
        outputLength: output.length,
        resumed: true,
      });
    } catch (error) {
      await this.walker.failStep(args.step.id, stringifyError(error));
      this.emit('dispatcher/step.failed', args.moleculeId, args.step.id, {
        stepName,
        role,
        stepId: args.step.id,
        error: stringifyError(error),
        resumed: true,
      });
      throw new FormulaDispatchError(`FormulaDispatcher: resumed step "${stepName}" failed`, args.moleculeId, { cause: error });
    } finally {
      if (handle) await this.provider.stop(handle);
    }
  }

  private emit(kind: string, moleculeId: string | undefined, taskId: string | undefined, payload: Readonly<Record<string, unknown>>): void {
    this.eventBus.emit({
      layer: 'dispatcher',
      kind,
      ...(moleculeId ? { molecule_id: moleculeId } : {}),
      ...(taskId ? { task_id: taskId } : {}),
      payload,
    });
  }

  private emitRuntimeSessionEvent(event: SessionEvent, context: RuntimeSessionEventContext): void {
    this.eventBus.emit({
      layer: 'runtime',
      kind: `runtime/session.${event.kind.replace(/-/g, '_')}`,
      molecule_id: context.moleculeId,
      ...(context.taskId ? { task_id: context.taskId } : {}),
      teammate: context.role,
      payload: {
        ...sessionEventPayload(event),
        stepId: context.stepId,
        stepName: context.stepName,
        role: context.role,
        providerKind: context.providerKind,
        sessionId: context.sessionId,
        ...(context.attempt ? { attempt: context.attempt } : {}),
        ...(context.taskId ? { taskId: context.taskId } : {}),
        ...(context.conversationId ? { conversationId: context.conversationId } : {}),
        ...(context.agentId ? { agentId: context.agentId } : {}),
        ...(context.projectIdentifier ? { projectIdentifier: context.projectIdentifier } : {}),
        ...(context.resumed ? { resumed: true } : {}),
      },
    });
  }
}

interface RuntimeSessionEventContext {
  readonly moleculeId: string;
  readonly stepId: string;
  readonly stepName: string;
  readonly role: string;
  readonly providerKind: string;
  readonly sessionId: string;
  readonly attempt?: number;
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly agentId?: string;
  readonly projectIdentifier?: string;
  readonly resumed?: boolean;
}

function sessionEventPayload(event: SessionEvent): Readonly<Record<string, unknown>> {
  switch (event.kind) {
    case 'started':
    case 'first-token':
    case 'stopped':
      return { eventKind: event.kind, ts: event.ts };
    case 'message-delta':
      return { eventKind: event.kind, ts: event.ts, text: event.text, textLength: event.text.length };
    case 'tool-call':
      return { eventKind: event.kind, ts: event.ts, tool: event.tool, args: event.args };
    case 'tool-result':
      return { eventKind: event.kind, ts: event.ts, tool: event.tool, result: event.result, ok: event.ok };
    case 'usage':
      return { eventKind: event.kind, ts: event.ts, prompt: event.prompt, completion: event.completion };
    case 'turn-done':
      return { eventKind: event.kind, ts: event.ts, ...(event.stopReason ? { stopReason: event.stopReason } : {}) };
    case 'error':
      return { eventKind: event.kind, ts: event.ts, code: event.code, message: event.message };
  }
}

function renderContext(input: string, outputs: Readonly<Record<string, string>>): Readonly<Record<string, string | number | boolean>> {
  const context: Record<string, string> = {
    input,
    prior_outputs: formatPriorOutputs(outputs),
  };
  for (const [stepName, output] of Object.entries(outputs)) {
    context[`prior_${stepName}`] = output;
  }
  return context;
}

function formatPriorOutputs(outputs: Readonly<Record<string, string>>): string {
  const entries = Object.entries(outputs);
  if (entries.length === 0) return 'No prior step outputs yet.';
  return entries
    .map(([stepName, output]) => [`## ${stepName}`, output.trim() || '(empty output)'].join('\n'))
    .join('\n\n');
}

function readStepName(row: BeadRow): string {
  const exec = readExec(row);
  if (!('step' in exec) || typeof exec.step !== 'string') {
    throw new Error(`FormulaDispatcher: molecule step ${row.id} is missing metadata.exec.step`);
  }
  return exec.step;
}

function readStepRole(row: BeadRow): string {
  const match = /] (.+)$/.exec(row.title);
  if (!match?.[1]) {
    throw new Error(`FormulaDispatcher: molecule step ${row.id} is missing role in title`);
  }
  return match[1];
}

function outputsFromClosedSteps(steps: readonly BeadRow[]): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const step of steps) {
    if (step.status !== 'closed') continue;
    const stepName = readStepName(step);
    const payload = readExec(step).output_payload;
    if (payload && typeof payload === 'object' && 'output' in payload && typeof payload.output === 'string') {
      outputs[stepName] = payload.output;
    }
  }
  return outputs;
}

function readExec(row: BeadRow): Record<string, unknown> {
  const exec = row.metadata.exec;
  return exec && typeof exec === 'object' ? exec as Record<string, unknown> : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * vibesync-u32z: recover the motivating bead id from a molecule_root row's
 * exec metadata. Used by resume() (where the original DispatchInput is not in
 * scope) so the completion event can still carry the motivating bead.
 */
function readMotivatingBead(row: BeadRow): string | null {
  return readString(readExec(row)['motivating_bead']);
}

function normalizeMaxParallelSteps(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  if (value < 1) {
    throw new Error('FormulaDispatcher: maxParallelSteps must be at least 1');
  }
  return Math.floor(value);
}

function normalizeMaxConcurrentMolecules(value: number | undefined): number {
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  if (value < 1) {
    throw new Error('FormulaDispatcher: maxConcurrentMolecules must be at least 1');
  }
  return Math.floor(value);
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Default conversation-id generator. Uses crypto.randomUUID for
 * collision-free ids. Tests inject a deterministic counter via
 * FormulaDispatcherOptions.conversationIdGenerator.
 */
function createDefaultConversationIdGenerator(): ConversationIdGenerator {
  return {
    next(): string {
      return `conv-${randomUUID()}`;
    },
  };
}
