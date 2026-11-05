/**
 * Public exports for src/engine/runtime/.
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


export type { AgentIdResolver } from './dispatch-helpers.js';

export { IrohWrapperProvider, IROH_PROVIDER_KIND } from './iroh-wrapper-provider.js';
export type { IrohWrapperProviderOptions } from './iroh-wrapper-provider.js';
export { IrohConnection } from './iroh/connection.js';
export type { IrohConnectionOptions, IrohDialer, IrohLink } from './iroh/connection.js';


