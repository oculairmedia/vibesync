import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export interface RenderInput {
  readonly packRoot: string;
  readonly template: string;
  readonly context: Readonly<Record<string, string | number | boolean>>;
}

const ESCAPED_DOLLAR = '\u0000VIBESYNC_DOLLAR\u0000';
const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function renderTemplate(input: RenderInput): string {
  const templatePath = resolveTemplatePath(input.packRoot, input.template);
  const raw = readFileSync(templatePath, 'utf8');
  const escaped = raw.replaceAll('$$', ESCAPED_DOLLAR);
  const rendered = escaped.replace(VARIABLE_PATTERN, (_match, name: string) => {
    const value = input.context[name];
    if (value === undefined) {
      throw new Error(`renderTemplate: missing variable "${name}" in ${input.template}`);
    }
    return String(value);
  });
  return rendered.replaceAll(ESCAPED_DOLLAR, '$');
}

function resolveTemplatePath(packRoot: string, template: string): string {
  const root = resolve(packRoot);
  const candidate = resolve(root, template);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error(`renderTemplate: template path escapes pack root: ${template}`);
  }
  return candidate;
}
