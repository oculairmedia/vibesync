import fs from 'node:fs';
import path from 'node:path';
import { stripUrlCredentials } from '../utils';

export function extractFilesystemPath(description: string | null | undefined): string | null {
  if (!description) {
    return null;
  }

  const patterns = [/(?:Path|Filesystem|Directory|Location):\s*([^\n\r]+)/i];

  for (const pattern of patterns) {
    const match = description.match(pattern);
    if (match) {
      const p = match[1]!.trim();
      return p.replace(/[,;.]$/, '').trim();
    }
  }

  return null;
}

export function getGitUrl(repoPath: string): string | null {
  const { execSync } = require('node:child_process');

  try {
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      return null;
    }

    const url = execSync('git remote get-url origin', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    // SECURITY (vibesync-6kg): `git remote get-url origin` returns the URL
    // exactly as configured, including any inlined `https://<token>@host/...`
    // credential. Strip it before returning so callers/storage never see it.
    return stripUrlCredentials(url || null);
  } catch {
    return null;
  }
}

export function validateGitRepoPath(repoPath: string | null | undefined): { valid: boolean; reason?: string } {
  if (!repoPath || typeof repoPath !== 'string') {
    return { valid: false, reason: 'path is null or not a string' };
  }

  if (!path.isAbsolute(repoPath)) {
    return { valid: false, reason: `path is not absolute: ${repoPath}` };
  }

  if (!fs.existsSync(repoPath)) {
    return { valid: false, reason: `path does not exist on disk: ${repoPath}` };
  }

  try {
    const stat = fs.statSync(repoPath);
    if (!stat.isDirectory()) {
      return { valid: false, reason: `path is not a directory: ${repoPath}` };
    }
  } catch {
    return { valid: false, reason: `cannot stat path: ${repoPath}` };
  }

  const gitDir = path.join(repoPath, '.git');
  if (!fs.existsSync(gitDir)) {
    return { valid: false, reason: `not a git repository (no .git): ${repoPath}` };
  }

  return { valid: true };
}

interface HulyProject {
  identifier: string;
  description?: string | null;
}

export function determineGitRepoPath(hulyProject: HulyProject): string {
  const filesystemPath = extractFilesystemPath(hulyProject.description);
  if (filesystemPath && fs.existsSync(filesystemPath)) {
    console.log(`[Vibe] Using filesystem path from Huly: ${filesystemPath}`);
    return filesystemPath;
  }

  const placeholder = `/opt/stacks/huly-sync-placeholders/${hulyProject.identifier}`;
  console.log(`[Vibe] Using placeholder path: ${placeholder}`);
  return placeholder;
}

export async function resolveGitUrl(
  filesystemPath: string,
  { timeoutMs = 3000 }: { timeoutMs?: number } = {},
): Promise<string | null> {
  if (!filesystemPath || !fs.existsSync(path.join(filesystemPath, '.git'))) {
    return null;
  }

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: filesystemPath,
      timeout: timeoutMs,
    });

    return cleanGitUrl((stdout as string).trim());
  } catch {
    return null;
  }
}

export function cleanGitUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;

  const url = rawUrl
    .replace(/https?:\/\/[^@]+@github\.com\//, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '');

  if (!url.startsWith('https://github.com/')) return null;

  return url;
}
