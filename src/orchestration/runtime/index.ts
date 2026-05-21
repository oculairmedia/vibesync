/**
 * Public exports for src/orchestration/runtime/.
 *
 * Higher layers import from this module; they MUST NOT reach into the
 * individual files directly. This re-export shape is the layering
 * boundary for the runtime sub-tree.
 */

export type {
  ContentBlock,
  PromptResult,
  RuntimeProvider,
  SessionEvent,
  SessionHandle,
  SessionSpec,
} from './provider.js';

export { LettaPMAgentProvider } from './letta-pm-agent-provider.js';
export type { LettaPMAgentServices } from './letta-pm-agent-provider.js';

export {
  LettaCodeSubagentProvider,
  createDefaultPersonaLoader,
  buildPuppetMessage,
  parseSseFrame,
  translateShimEvent,
} from './letta-code-subagent-provider.js';
export type {
  LettaCodeSubagentProviderOptions,
  PersonaLoader,
} from './letta-code-subagent-provider.js';

export { LettaTeamsProvider } from './letta-teams-provider.js';
export type {
  LettaTeamsProviderOptions,
  MemoryBlockInput,
  MemoryBlockSeedOptions,
  MemoryBlockSeeder,
  ToolAttacher,
  ToolAttachResult,
  TeammateDeleter,
} from './letta-teams-provider.js';

export { A2UIProvider } from './a2ui-provider.js';
export type { A2uiCapability } from './a2ui-provider.js';

export { ACPProvider } from './acp-provider.js';
