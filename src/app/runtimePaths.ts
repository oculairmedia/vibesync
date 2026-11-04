import path from 'node:path';

export function getAppRoot(): string {
  return process.env.VIBESYNC_APP_ROOT || process.cwd();
}

export function resolveFromAppRoot(...segments: string[]): string {
  return path.join(getAppRoot(), ...segments).replace(/\\/g, '/');
}
