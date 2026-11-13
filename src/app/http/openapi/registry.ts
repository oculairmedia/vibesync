import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { ApiSchemas } from './schemas.js';

export const registry = new OpenAPIRegistry();

/** The bearer token checked by the formula and molecule routes when VIBESYNC_ORCHESTRATION_TOKEN is set. */
export const orchestrationAuth = registry.registerComponent('securitySchemes', 'orchestrationToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'Required by the formula-run and molecule routes when the service sets VIBESYNC_ORCHESTRATION_TOKEN; open otherwise.',
});

for (const [name, schema] of Object.entries(ApiSchemas)) {
  registry.register(name, schema);
}

export { ApiSchemas };
