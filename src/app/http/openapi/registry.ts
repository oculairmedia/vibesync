import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ApiSchemas } from './schemas.js';

export const registry = new OpenAPIRegistry();

/** The bearer token checked by the formula and molecule routes when VIBESYNC_ORCHESTRATION_TOKEN is set. */
export const orchestrationAuth = registry.registerComponent('securitySchemes', 'orchestrationToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Required by the formula-run and molecule routes when the service sets VIBESYNC_ORCHESTRATION_TOKEN; open otherwise.',
});

/**
 * Every schema, registered as a named component. `register()` returns a copy
 * tagged with the component name; a route must use that copy, or the
 * description inlines the schema and never references the component. Routes
 * import these, not the untagged `ApiSchemas`.
 */
export const Components = Object.fromEntries(
  Object.entries(ApiSchemas).map(([name, schema]) => [name, registry.register(name, schema)]),
) as typeof ApiSchemas;

export { ApiSchemas };
