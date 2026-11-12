import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TurnLimitPreserver {
  preserve(input: { readonly workdir: string; readonly workBeadId: string; readonly moleculeId: string }): Promise<string>;
}

export interface TurnLimitRecordStore {
  appendNoteToBead(beadId: string, note: string): Promise<void>;
  addCommentToBead(beadId: string, comment: string): Promise<void>;
}

export function turnLimitRecord(work: string, moleculeId: string): string {
  return `TURN-LIMIT WIP RECORD (${moleculeId}):\n${work}`;
}

/**
 * Saves a step's uncommitted work when its turn limit is reached
 * (vibesync-9lzk.57). The work is committed onto `wip/<bead>/<molecule>`
 * WITHOUT touching the checkout: a throwaway index builds the commit from the
 * working tree, so the worktree stays on its work branch with its files as they
 * were, ready for whoever picks the bead up. A failed push keeps the local
 * branch and says so.
 */
export class GitTurnLimitPreserver implements TurnLimitPreserver {
  async preserve(input: { readonly workdir: string; readonly workBeadId: string; readonly moleculeId: string }): Promise<string> {
    const branch = `wip/${input.workBeadId}/${input.moleculeId}`;
    const changedFiles = await changedPaths(input.workdir);
    if (changedFiles.length === 0) return NO_UNCOMMITTED_WORK;
    await commitWorkingTreeTo(input.workdir, branch, `${input.workBeadId} ${input.moleculeId}: turn limit reached`);
    const files = `changed files:\n${changedFiles.join('\n')}`;
    try {
      await git(input.workdir, ['push', '-u', 'origin', branch]);
      return `WIP branch ${branch}; ${files}`;
    } catch (error) {
      return `WIP branch ${branch} committed locally; push failed: ${message(error)}; ${files}`;
    }
  }
}

export const NO_UNCOMMITTED_WORK = 'no uncommitted work';

async function git(workdir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  return (await execFileAsync('git', ['-C', workdir, ...args], { encoding: 'utf8', env })).stdout.trim();
}

/** Every path that differs from HEAD: modified, staged or untracked (ignored files excluded). */
async function changedPaths(workdir: string): Promise<string[]> {
  const lists = await Promise.all([
    git(workdir, ['diff', '--name-only', 'HEAD']),
    git(workdir, ['diff', '--cached', '--name-only']),
    git(workdir, ['ls-files', '--others', '--exclude-standard']),
  ]);
  return [...new Set(lists.flatMap((list) => list.split('\n')).filter(Boolean))];
}

/** A commit of the working tree on top of HEAD, written to `branch`, leaving HEAD, the index and the files alone. */
async function commitWorkingTreeTo(workdir: string, branch: string, subject: string): Promise<void> {
  const indexFile = join(tmpdir(), `vibesync-wip-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    await git(workdir, ['read-tree', 'HEAD'], env);
    await git(workdir, ['add', '-A'], env);
    const tree = await git(workdir, ['write-tree'], env);
    const author = ['-c', 'user.name=VibeSync Engine', '-c', 'user.email=vibesync-engine@localhost'];
    const commit = await git(workdir, [...author, 'commit-tree', tree, '-p', 'HEAD', '-m', subject]);
    await git(workdir, ['branch', '--force', branch, commit]);
  } finally {
    await rm(indexFile, { force: true });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
