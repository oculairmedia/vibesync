import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  constructor(private readonly opts: { readonly gitTimeoutMs?: number } = {}) {}

  async preserve(input: { readonly workdir: string; readonly workBeadId: string; readonly moleculeId: string }): Promise<string> {
    const branch = `wip/${input.workBeadId}/${input.moleculeId}`;
    const changedFiles = await changedPaths(input.workdir);
    if (changedFiles.length === 0) return NO_UNCOMMITTED_WORK;
    await commitWorkingTreeTo(input.workdir, branch, `${input.workBeadId} ${input.moleculeId}: turn limit reached`);
    const files = `changed files:\n${changedFiles.join('\n')}`;
    try {
      await git(input.workdir, ['push', '-u', 'origin', branch], process.env, this.opts.gitTimeoutMs);
      return `WIP branch ${branch}; ${files}`;
    } catch (error) {
      return `WIP branch ${branch} committed locally; push failed: ${message(error)}; ${files}`;
    }
  }
}

export const NO_UNCOMMITTED_WORK = 'no uncommitted work';

/** No git command may hang the escalation (a push to an unresponsive remote, a credential prompt). */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Runs git with a deadline. git is started as the leader of its own process
 * group and the WHOLE group is killed at the deadline: killing only git leaves
 * its transport helper (`git remote-ext`, `ssh`, a credential helper) running
 * forever under init.
 */
async function git(workdir: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', workdir, ...args], { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* the group is already gone */ }
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
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

/**
 * Commits the work onto `branch`, leaving HEAD, the real index and the files alone.
 * Two layers, so nothing is lost: first the staged state (the real index, which may
 * hold edits the working tree no longer has), then the working tree laid over it.
 * When the two are the same tree, one commit.
 */
async function commitWorkingTreeTo(workdir: string, branch: string, subject: string): Promise<void> {
  const indexFile = join(tmpdir(), `vibesync-wip-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const author = ['-c', 'user.name=VibeSync Engine', '-c', 'user.email=vibesync-engine@localhost'];
  try {
    const stagedTree = await git(workdir, ['write-tree']);
    await git(workdir, ['read-tree', stagedTree], env);
    await git(workdir, ['add', '-A'], env);
    const workingTree = await git(workdir, ['write-tree'], env);
    let tip = await git(workdir, ['rev-parse', 'HEAD']);
    if (stagedTree !== await git(workdir, ['rev-parse', 'HEAD^{tree}'])) {
      tip = await git(workdir, [...author, 'commit-tree', stagedTree, '-p', tip, '-m', `${subject} (staged)`]);
    }
    if (workingTree !== stagedTree) {
      tip = await git(workdir, [...author, 'commit-tree', workingTree, '-p', tip, '-m', `${subject} (working tree)`]);
    }
    await git(workdir, ['branch', '--force', branch, tip]);
  } finally {
    await rm(indexFile, { force: true });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
