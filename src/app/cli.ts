#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';

// ── Types ───────────────────────────────────────────────────────────

interface GlobalOpts {
  apiUrl: string;
  json: boolean;
  timeout: number;
}

interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

// ── Helpers ────────────────────────────────────────────────────────

const program = new Command();

function getGlobalOpts(): GlobalOpts {
  const opts = program.opts() as Record<string, unknown>;
  return {
    apiUrl: String(opts.apiUrl || 'http://localhost:3099').replace(/\/+$/, ''),
    json: Boolean(opts.json),
    timeout: Number(opts.timeout) || 5000,
  };
}

async function fetchJson<T = unknown>(path: string, options: FetchOptions = {}): Promise<T> {
  const { apiUrl, timeout } = getGlobalOpts();
  const url = path.startsWith('http') ? path : `${apiUrl}${path}`;
  const { timeoutMs, ...fetchOptions } = options;
  const requestTimeout = Number(timeoutMs) || timeout;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const res = await fetch(url, { ...fetchOptions, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${body || res.statusText}`);
    }
    return await res.json() as T;
  } catch (err) {
    clearTimeout(timer);
    if ((err as Error)?.name === 'AbortError')
      throw new Error(`Timeout after ${requestTimeout}ms: ${url}`);
    if ((err as { code?: string })?.code === 'ECONNREFUSED')
      throw new Error(`Connection refused: ${url}`);
    throw err;
  }
}

async function probe(url: string, timeoutMs?: number): Promise<{ ok: boolean; status?: number; error?: string }> {
  const saved = getGlobalOpts().timeout;
  const controller = new AbortController();
  const ms = timeoutMs ?? saved;
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: (err as Error)?.message || String(err) };
  }
}

function formatTable(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_: string, i: number) =>
    Math.max(...all.map((r: (string | number | null | undefined)[]) => String(r[i] ?? '').length)),
  );
  const sep = widths.map((w: number) => '─'.repeat(w + 2)).join('┼');
  const fmt = (row: (string | number | null | undefined)[], color: (s: string) => string): string =>
    row.map((c: string | number | null | undefined, i: number) =>
      ` ${color(String(c ?? '').padEnd(widths[i]!))} `).join('│');

  const lines: string[] = [fmt(headers, chalk.bold as (s: string) => string), sep];
  for (const row of rows) lines.push(fmt(row, (s) => s));
  return lines.join('\n');
}

function die(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function preview(value: unknown, max = 80): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function compactPayload(value: unknown): string {
  const payload = toRecord(value);
  const entries = Object.entries(payload).filter(([, v]) => v !== undefined && v !== null);
  return entries.map(([k, v]) => `${k}=${preview(v, 60)}`).join(' ');
}

async function watchMoleculeEvents(moleculeId: string): Promise<number> {
  const { apiUrl, timeout } = getGlobalOpts();
  const controller = new AbortController();
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    controller.abort();
  };
  process.once('SIGINT', onSigint);
  try {
    const headersTimer = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(`${apiUrl}/molecules/${encodeURIComponent(moleculeId)}/events`, { signal: controller.signal });
    clearTimeout(headersTimer);
    if (!response.ok || !response.body) throw new Error(`event stream failed: HTTP ${response.status}`);
    const body = response.body;
    let buffer = '';
    let eventType = 'message';
    let exitCode = 0;
    for await (const chunk of body) {
      buffer += Buffer.from(chunk).toString('utf8');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseFrame(frame, eventType);
        eventType = 'message';
        if (parsed) {
          eventType = parsed.nextEventType;
          if (parsed.data) {
            const event = toRecord(parsed.data);
            const kind = String(event.kind ?? parsed.eventType);
            const ts = event.ts ? new Date(String(event.ts)).toLocaleTimeString() : new Date().toLocaleTimeString();
            console.log(`${ts} ${kind} ${compactPayload(event.payload)}`.trim());
            if (kind === 'dispatcher/formula.failed') exitCode = 1;
            if (kind === 'dispatcher/formula.completed' || kind === 'dispatcher/formula.failed') return exitCode;
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    return exitCode;
  } catch (error) {
    if (interrupted) return 130;
    throw error;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function parseSseFrame(frame: string, currentEventType: string): { eventType: string; nextEventType: string; data: unknown } | null {
  let eventType = currentEventType;
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return { eventType, nextEventType: eventType, data: null };
  const dataRaw = dataLines.join('\n');
  try {
    return { eventType, nextEventType: eventType, data: JSON.parse(dataRaw) };
  } catch {
    return { eventType, nextEventType: eventType, data: dataRaw };
  }
}

// ── Program ────────────────────────────────────────────────────────

program
  .name('vibesync')
  .description('Vibesync CLI')
  .version('2.0.0')
  .option('--api-url <url>', 'API server base URL', 'http://localhost:3099')
  .option('--json', 'Force JSON output')
  .option('--timeout <ms>', 'Request timeout in ms', '5000');

// ── status ─────────────────────────────────────────────────────────

program
  .command('status')
  .description('System health check')
  .action(async () => {
    const { apiUrl, json } = getGlobalOpts();
    const checks: [string, string, string][] = [];

    // API server
    try {
      await fetchJson('/health');
      checks.push(['API Server', chalk.green('OK'), apiUrl]);
    } catch (err) {
      checks.push(['API Server', chalk.red('FAIL'), (err as Error)?.message || String(err)]);
    }

    // Registry projects
    try {
      const data = toRecord(await fetchJson('/api/registry/projects'));
      checks.push(['Registry', chalk.green('OK'), `${data.total ?? 0} projects`]);
    } catch (err) {
      checks.push(['Registry', chalk.red('FAIL'), (err as Error)?.message || String(err)]);
    }

    // UI proxy
    try {
      const r = await probe('http://localhost:3110');
      checks.push([
        'UI Proxy',
        r.ok ? chalk.green('OK') : chalk.red('FAIL'),
        r.ok ? 'http://localhost:3110' : r.error || `HTTP ${r.status}`,
      ]);
    } catch (err) {
      checks.push(['UI Proxy', chalk.red('FAIL'), (err as Error)?.message || String(err)]);
    }

    // External URL
    try {
      const r = await probe('https://vibesync.oculair.ca/api/health');
      checks.push([
        'External URL',
        r.ok ? chalk.green('OK') : chalk.red('FAIL'),
        r.ok ? 'vibesync.oculair.ca' : r.error || `HTTP ${r.status}`,
      ]);
    } catch (err) {
      checks.push(['External URL', chalk.red('FAIL'), (err as Error)?.message || String(err)]);
    }

    if (json) {
      const result = checks.map(([component, , details]) => ({
        component,
        status: details,
      }));
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(chalk.bold('\nSystem Health\n'));
      console.log(formatTable(['Component', 'Status', 'Details'], checks));
      console.log();
    }

    const hasFail = checks.some(([, s]) => s.includes('FAIL'));
    process.exit(hasFail ? 1 : 0);
  });

// ── projects ───────────────────────────────────────────────────────

program
  .command('projects')
  .description('List projects')
  .option('--filter <key=value>', 'Filter query param (e.g. status=active)')
  .action(async (opts: Record<string, unknown>) => {
    const { json: jsonOut } = getGlobalOpts();
    let path = '/api/registry/projects';
    if (opts.filter) {
      const [key, val] = String(opts.filter).split('=');
      if (key && val) path += `?${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
    }

    try {
      const data = toRecord(await fetchJson(path));
      const projects = toArray(data.projects);

      if (jsonOut) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      if (!projects.length) {
        console.log(chalk.yellow('No projects found.'));
        return;
      }

      const rows = projects.map((p: unknown) => {
        const project = toRecord(p);
        return [
          project.identifier || '',
          project.name || '',
          project.tech_stack || '',
          project.letta_agent_id ? chalk.green('✓') : chalk.red('✗'),
          String(project.issue_count ?? ''),
        ];
      });
      console.log(formatTable(['Identifier', 'Name', 'Tech Stack', 'Agent', 'Issues'], rows as never));
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

// ── project <identifier> ──────────────────────────────────────────

program
  .command('project <identifier>')
  .description('Show project detail')
  .action(async (identifier: string) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const project = toRecord(
        await fetchJson(`/api/registry/projects/${encodeURIComponent(identifier)}`),
      );
      const issueData = toRecord(
        await (fetchJson(`/api/registry/projects/${encodeURIComponent(identifier)}/issues`) as Promise<unknown>).catch(
          () => null,
        ) ?? {},
      );

      if (jsonOut) {
        console.log(JSON.stringify({ project, issues: issueData }, null, 2));
        return;
      }

      console.log(chalk.bold(`\nProject: ${project.identifier || identifier}\n`));

      const meta: [string, unknown][] = [
        ['Name', project.name],
        ['Identifier', project.identifier],
        ['Tech Stack', project.tech_stack],
        ['Status', project.status],
        ['Filesystem Path', project.filesystem_path],
        ['Letta Agent ID', project.letta_agent_id || chalk.yellow('none')],
        ['Issues', project.issue_count],
        ['Git URL', project.git_url],
      ];
      for (const [k, v] of meta) {
        if (v !== undefined && v !== null) {
          console.log(`  ${chalk.bold(k + ':')} ${v}`);
        }
      }

      if (issueData.issues) {
        const byStatus: Record<string, number> = {};
        for (const issue of toArray(issueData.issues)) {
          const safeIssue = toRecord(issue);
          const s = String(safeIssue.status || 'unknown');
          byStatus[s] = (byStatus[s] || 0) + 1;
        }
        console.log(chalk.bold(`\n  Issues (${issueData.total}):`));
        for (const [status, count] of Object.entries(byStatus)) {
          console.log(`    ${status}: ${count}`);
        }
      }
      console.log();
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

program
  .command('project-register <filesystemPath>')
  .description('Register a project from an absolute filesystem path')
  .option('--name <name>', 'Override project display name')
  .option('--git-url <url>', 'Set git URL after registration')
  .action(async (filesystemPath: string, opts: Record<string, unknown>) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const data = toRecord(
        await fetchJson('/api/registry/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            filesystem_path: filesystemPath,
            name: opts.name,
            git_url: opts.gitUrl,
          }),
        }),
      );
      const project = toRecord(data.project);

      if (jsonOut) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.green(`Project registered: ${project.identifier}`));
      console.log(`  Path: ${project.filesystem_path}`);
      if (project.git_url) {
        console.log(`  Git URL: ${project.git_url}`);
      }
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

program
  .command('project-update <identifier>')
  .description('Update a registered project path or git URL')
  .option('--filesystem-path <path>', 'New absolute filesystem path')
  .option('--git-url <url>', 'New git URL')
  .action(async (identifier: string, opts: Record<string, unknown>) => {
    const { json: jsonOut } = getGlobalOpts();
    const updates: Record<string, unknown> = {};

    if (opts.filesystemPath !== undefined) {
      updates.filesystem_path = opts.filesystemPath;
    }
    if (opts.gitUrl !== undefined) {
      updates.git_url = opts.gitUrl;
    }

    if (!Object.keys(updates).length) {
      die('Provide --filesystem-path and/or --git-url');
    }

    try {
      const data = toRecord(
        await fetchJson(`/api/registry/projects/${encodeURIComponent(identifier)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        }),
      );
      const project = toRecord(data.project);

      if (jsonOut) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(chalk.green(`Project updated: ${project.identifier}`));
      console.log(`  Path: ${project.filesystem_path || chalk.yellow('none')}`);
      console.log(`  Git URL: ${project.git_url || chalk.yellow('none')}`);
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

program
  .command('project-beads-remote <identifier>')
  .description('Show Beads/DoltHub remote provisioning status for a project')
  .action(async (identifier: string) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const data = toRecord(
        await fetchJson(`/api/projects/${encodeURIComponent(identifier)}/beads-remote`),
      );

      if (jsonOut) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const remote = toRecord(data.beads_remote);
      console.log(chalk.bold(`\nBeads Remote: ${identifier}\n`));
      console.log(`  Status: ${remote.status || 'not_provisioned'}`);
      console.log(`  Remote: ${remote.url || chalk.yellow('not set')}`);
      console.log(`  Name:   ${remote.name || chalk.yellow('not set')}`);
      if (remote.last_push_at) console.log(`  Last push: ${remote.last_push_at}`);
      if (remote.error) console.log(`  Error: ${chalk.red(String(remote.error))}`);
      console.log();
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

program
  .command('project-provision-beads-remote <identifier>')
  .description('Provision a project-scoped private DoltHub remote for Beads')
  .option('--no-push', 'Configure the remote without pushing Beads data')
  .action(async (identifier: string, opts: Record<string, unknown>) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const data = toRecord(
        await fetchJson(`/api/projects/${encodeURIComponent(identifier)}/beads-remote/provision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ push: opts.push !== false }),
        }),
      );

      if (jsonOut) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const provisioning = toRecord(data.provisioning);
      console.log(chalk.green(String(data.message || 'Beads remote provisioned')));
      console.log(`  Remote: ${provisioning.remote_url || chalk.yellow('not set')}`);
      console.log(`  Repo:   ${provisioning.owner || '—'}/${provisioning.repo || '—'}`);
      console.log(`  Pushed: ${provisioning.pushed ? chalk.green('yes') : chalk.yellow('no')}`);
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

const formula = program.command('formula').description('Formula orchestration commands');

formula
  .command('list')
  .description('List available orchestration formulas')
  .action(async () => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const data = toRecord(await fetchJson('/formulas'));
      const formulas = toArray(data.formulas);
      if (jsonOut) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      if (!formulas.length) {
        console.log(chalk.yellow('No formulas found.'));
        return;
      }
      const rows = formulas.map((item) => {
        const f = toRecord(item);
        return [f.pack, f.name, f.description, f.stepCount];
      });
      console.log(formatTable(['Pack', 'Name', 'Description', 'Steps'], rows as never));
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

formula
  .command('run <name>')
  .description('Run an orchestration formula')
  .requiredOption('--input <text>', 'Top-level input for the formula')
  .option('--pack <name>', 'Pack name', 'gastown')
  .option('--motivating-bead <id>', 'Motivating Beads issue id')
  .option('--watch', 'Stream molecule events after starting')
  .action(async (name: string, opts: Record<string, unknown>) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const body: Record<string, unknown> = { input: String(opts.input), pack: String(opts.pack || 'gastown') };
      if (opts.motivatingBead) body.motivatingBeadId = String(opts.motivatingBead);
      const data = toRecord(await fetchJson(`/formulas/${encodeURIComponent(name)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (jsonOut) console.log(JSON.stringify(data, null, 2));
      else {
        console.log(`moleculeId: ${chalk.green(String(data.moleculeId ?? ''))}`);
        console.log(`path: /molecules/${String(data.moleculeId ?? '')}`);
      }
      if (opts.watch && typeof data.moleculeId === 'string') {
        const code = await watchMoleculeEvents(data.moleculeId);
        process.exitCode = code;
      }
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

formula
  .command('status <moleculeId>')
  .description('Show formula molecule status')
  .action(async (moleculeId: string) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const data = toRecord(await fetchJson(`/molecules/${encodeURIComponent(moleculeId)}`));
      if (jsonOut) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      console.log(chalk.bold(`\nMolecule: ${String(data.moleculeId ?? moleculeId)} (${String(data.status ?? 'unknown')})\n`));
      const rows = toArray(data.steps).map((item) => {
        const step = toRecord(item);
        return [step.stepName, step.role, step.status, preview(step.output, 60)];
      });
      console.log(formatTable(['Step', 'Role', 'Status', 'Output'], rows as never));
      console.log();
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

formula
  .command('resume <moleculeId>')
  .description('Re-attach to running formula molecule tasks after restart')
  .option('--watch', 'Stream molecule events after resuming')
  .action(async (moleculeId: string, opts: Record<string, unknown>) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const data = toRecord(await fetchJson(`/molecules/${encodeURIComponent(moleculeId)}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }));
      if (jsonOut) console.log(JSON.stringify(data, null, 2));
      else console.log(`resumed: ${chalk.green(String(data.moleculeId ?? moleculeId))}`);
      if (opts.watch) {
        const code = await watchMoleculeEvents(String(data.moleculeId ?? moleculeId));
        process.exitCode = code;
      }
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

formula
  .command('cancel <moleculeId>')
  .description('Cancel a running formula molecule')
  .action(async (moleculeId: string) => {
    const { json: jsonOut } = getGlobalOpts();
    try {
      const data = toRecord(await fetchJson(`/molecules/${encodeURIComponent(moleculeId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      }));
      if (jsonOut) console.log(JSON.stringify(data, null, 2));
      else console.log(`cancelled: ${chalk.green(String(data.moleculeId ?? moleculeId))}`);
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

formula
  .command('events <moleculeId>')
  .description('Stream formula molecule events')
  .action(async (moleculeId: string) => {
    try {
      process.exitCode = await watchMoleculeEvents(moleculeId);
    } catch (err) {
      die((err as Error)?.message || String(err));
    }
  });

program.parse();
