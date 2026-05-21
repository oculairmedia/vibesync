/**
 * LettaServiceToolAttacher — concrete ToolAttacher backed by
 * LettaService's per-tool ensure/attach methods (vibesync-cs2).
 *
 * Lives in src/letta/ on purpose: the orchestration plane defines the
 * ToolAttacher interface but never imports LettaService directly; this
 * file is the one place we cross that boundary. Wire one at
 * application startup and pass it into bootOrchestrationPlane via
 * `BootOrchestrationPlaneOptions.toolAttacher`.
 *
 * Resolution model:
 *   The constructor takes a name → attach-fn map. A spawn that declares
 *   tools = ["dispatch_molecule", "read_file", ...] calls attach() once
 *   per name; names not in the registry resolve to status='unknown' so
 *   the provider can emit a structured warning without failing the
 *   session. Reason: a role's tools array carries both vibesync-managed
 *   tools (dispatch_molecule, search_folder_passages) and built-in /
 *   pre-attached tools the daemon supplies — only the former need
 *   per-spawn wiring here.
 */

import type { ToolAttacher, ToolAttachResult } from '../orchestration/runtime/index.js';

export interface ToolAttachFn {
  /** Returns true if the tool ended up attached (including the already-attached case). */
  (agentId: string): Promise<boolean>;
}

export interface LettaServiceToolAttacherOptions {
  /**
   * name → attach function. Names not in this map resolve to
   * status='unknown' (the caller emits a warning event). Add an entry
   * whenever a new vibesync-managed tool ships.
   */
  readonly attachers: Readonly<Record<string, ToolAttachFn>>;
}

/**
 * Minimal contract pulled out of LettaService so callers can wire this
 * adapter without dragging the rest of LettaService's surface into
 * src/orchestration/. Pass `service` directly in production wiring.
 */
export interface LettaServiceToolMethods {
  attachDispatchMoleculeTool(agentId: string): Promise<boolean>;
  attachSearchFolderPassagesTool(agentId: string): Promise<boolean>;
  attachListFormulasTool(agentId: string): Promise<boolean>;
}

export class LettaServiceToolAttacher implements ToolAttacher {
  private readonly attachers: Readonly<Record<string, ToolAttachFn>>;

  constructor(opts: LettaServiceToolAttacherOptions) {
    this.attachers = opts.attachers;
  }

  async attach(agentId: string, toolName: string): Promise<ToolAttachResult> {
    const fn = this.attachers[toolName];
    if (!fn) return { status: 'unknown' };
    try {
      const ok = await fn(agentId);
      return ok ? { status: 'attached' } : { status: 'error', error: 'attach returned false' };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (message.includes('already attached')) {
        return { status: 'already_attached' };
      }
      return { status: 'error', error: message };
    }
  }
}

/**
 * Build the default vibesync tool registry. Knows about the tools
 * shipped by LettaToolService today: `dispatch_molecule` (vibesync-qen)
 * and `search_folder_passages`. Extend this when a new tool ships its
 * own ensure/attach pair on LettaService.
 */
export function buildDefaultToolAttacher(service: LettaServiceToolMethods): LettaServiceToolAttacher {
  return new LettaServiceToolAttacher({
    attachers: {
      dispatch_molecule: (agentId) => service.attachDispatchMoleculeTool(agentId),
      list_formulas: (agentId) => service.attachListFormulasTool(agentId),
      search_folder_passages: (agentId) => service.attachSearchFolderPassagesTool(agentId),
    },
  });
}
