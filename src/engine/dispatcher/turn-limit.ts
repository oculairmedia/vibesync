import { execFile } from 'node:child_process';
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

export class GitTurnLimitPreserver implements TurnLimitPreserver {
  async preserve(input: { readonly workdir: string; readonly workBeadId: string; readonly moleculeId: string }): Promise<string> {
    const branch = `wip/${input.workBeadId}/${input.moleculeId}`;
    const git = async (args: readonly string[]) => (await execFileAsync('git', ['-C', input.workdir, ...args], { encoding: 'utf8' })).stdout.trim();
    const files = await git(['diff', '--name-only', 'HEAD']);
    const untracked = await git(['ls-files', '--others', '--exclude-standard']);
    const staged = await git(['diff', '--cached', '--name-only']);
    const changedFiles = [...new Set([...files.split('\n'), ...untracked.split('\n'), ...staged.split('\n')].filter(Boolean))];
    if (changedFiles.length === 0) return 'no uncommitted work';
    await git(['switch', '-c', branch]);
    await git(['add', '-A']);
    await git(['-c', 'user.name=VibeSync Engine', '-c', 'user.email=vibesync-engine@localhost', 'commit', '-m', `${input.workBeadId} ${input.moleculeId}: turn limit reached`]);
    try {
      await git(['push', '-u', 'origin', branch]);
      return `WIP branch ${branch}; changed files:\n${changedFiles.join('\n')}`;
    } catch (error) {
      return `WIP branch ${branch} committed locally; push failed: ${message(error)}; changed files:\n${changedFiles.join('\n')}`;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
