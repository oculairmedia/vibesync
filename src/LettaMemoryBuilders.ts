/** Loose issue shape consumed by Letta memory builders. Accepts DB rows, bd issues, and synthesized activity entries. */
export interface MemoryIssue {
  id?: string | number;
  identifier?: string;
  title?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | number | null;
  labels?: string[] | string | null;
  modifiedOn?: number | string | null;
  modifiedAt?: number | string | null;
  createdOn?: number | string | null;
  createdAt?: number | string | null;
  previousStatus?: string | null;
  component?: string | null;
  // Activity log fields
  type?: string;
  issue?: string;
  timestamp?: string | number;
  // Dolt change log fields
  change_type?: string;
  issue_id?: string;
  status_label?: string;
  updated_at?: string | number | null;
}

interface StatusCountRow {
  status?: string | null;
  count?: number | string | null;
}

interface TypeStatRow {
  issue_type?: string | null;
  component?: string | null;
  status?: string | null;
  count?: number | string | null;
}

interface DoltActivityChange {
  action?: string | null;
  id?: string | number | null;
  issue_id?: string | number | null;
  title?: string | null;
  from_status?: string | null;
  to_status?: string | null;
  status?: string | null;
  status_label?: string | null;
  updated_at?: string | number | null;
  timestamp?: string | number | null;
  diff_type?: string | null;
  change_type?: string | null;
}

interface DoltActivityData {
  changes?: DoltActivityChange[];
  summary?: Record<string, number>;
  byStatus?: Record<string, number>;
  since?: string | null;
}

type Issue = MemoryIssue;

export interface MemoryProject {
  identifier?: string;
  name?: string;
  description?: string | null;
  status?: string | null;
}

export function buildProjectMeta(project: MemoryProject, repoPath: string | null, gitUrl: string | null): Record<string, unknown> {
  return {
    name: project.name,
    identifier: project.identifier ?? project.name,
    description: project.description ?? '',
    status: project.status ?? 'active',
    repository: { filesystem_path: repoPath || null, git_url: gitUrl || null },
  };
}

export function buildBoardConfig(): Record<string, unknown> {
  return {
    statuses: {
      open: 'Task not yet started or in backlog',
      'in-progress': 'Task actively being worked on',
      closed: 'Task completed or cancelled',
    },
    priorities: {
      P0: 'Urgent - critical blocker requiring immediate attention',
      P1: 'High - important issue that should be addressed soon',
      P2: 'Medium - normal priority task',
      P3: 'Low - nice to have, can be deferred',
      P4: 'Backlog - no immediate plans to address',
    },
    workflow: {
      description: 'Git-tracked issue workflow',
      status_flow: 'open → in-progress → closed',
      note: 'Status changes are tracked in the issue history',
    },
    wip_policies: {
      description: 'Work-in-progress limits not enforced at tracker level',
      note: 'Teams should manage WIP limits through process and discipline',
    },
  };
}

export function buildBoardMetrics(issues: Issue[]): Record<string, unknown> {
  const statusCounts: Record<string, number> = { open: 0, 'in-progress': 0, closed: 0 };
  issues.forEach((issue) => {
    const status = issue.status || 'open';
    if (Object.hasOwn(statusCounts, status)) statusCounts[status]!++;
  });
  const total = issues.length;
  const completionRate = total > 0 ? ((statusCounts.closed! / total) * 100).toFixed(1) : 0;
  return {
    total_tasks: total, by_status: statusCounts, wip_count: statusCounts!['in-progress'],
    completion_rate: `${completionRate}%`,
    active_tasks: statusCounts.open! + (statusCounts['in-progress'] || 0),
  };
}

export function buildHotspots(issues: Issue[]): Record<string, unknown> {
  const hotspots: { blocked_items: Record<string, unknown>[]; ageing_wip: Record<string, unknown>[]; high_priority_open: Record<string, unknown>[] } = { blocked_items: [], ageing_wip: [], high_priority_open: [] };
  const now = Date.now();
  const AGEING_THRESHOLD_DAYS = 7;
  const AGEING_THRESHOLD_MS = AGEING_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  issues.forEach((issue) => {
    const status = issue.status || 'open';
    const title = issue.title || '';
    const description = issue.description || '';
    const blockedKeywords = ['blocked', 'blocker', 'waiting on', 'waiting for', 'stuck'];
    const isBlocked = blockedKeywords.some((kw) => title.toLowerCase().includes(kw) || description.toLowerCase().includes(kw));

    if (isBlocked) {
      hotspots.blocked_items.push({ id: issue.identifier ?? issue.id, title, status });
    }

    if (status === 'in-progress' && issue.modifiedOn) {
      const updatedAt = typeof issue.modifiedOn === 'number' ? issue.modifiedOn : new Date(issue.modifiedOn).getTime();
      const age = now - updatedAt;
      if (age > AGEING_THRESHOLD_MS) {
        const ageInDays = Math.floor(age / (24 * 60 * 60 * 1000));
        hotspots.ageing_wip.push({ id: issue.identifier ?? issue.id, title, age_days: ageInDays, last_updated: issue.modifiedOn });
      }
    }

    if (status === 'open' && issue.priority) {
      const priority = String(issue.priority).toLowerCase();
      if (priority === 'urgent' || priority === 'high') {
        hotspots.high_priority_open.push({ id: issue.identifier ?? issue.id, title, priority: issue.priority });
      }
    }
  });

  hotspots.ageing_wip.sort((a, b) => (b.age_days as number) - (a.age_days as number));
  hotspots.blocked_items = hotspots.blocked_items.slice(0, 10);
  hotspots.ageing_wip = hotspots.ageing_wip.slice(0, 10);
  hotspots.high_priority_open = hotspots.high_priority_open.slice(0, 10);

  return {
    ...hotspots,
    summary: { blocked_count: hotspots.blocked_items.length, ageing_wip_count: hotspots.ageing_wip.length, high_priority_count: hotspots.high_priority_open.length },
  };
}

export function buildBacklogSummary(issues: Issue[]): Record<string, unknown> {
  const openItems = issues.filter(issue => issue.status === 'open');
  const priorityOrder: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

  openItems.sort((a, b) => {
    const aPriority = normalizePriority(a.priority);
    const bPriority = normalizePriority(b.priority);
    return (priorityOrder[aPriority] ?? 4) - (priorityOrder[bPriority] ?? 4);
  });

  const topItems = openItems.slice(0, 15).map((issue) => ({
    id: issue.identifier ?? issue.id, title: issue.title || 'Untitled', priority: normalizePriority(issue.priority),
  }));

  return {
    total_backlog: openItems.length, top_items: topItems,
    priority_breakdown: {
      urgent: openItems.filter((t) => normalizePriority(t.priority) === 'urgent').length,
      high: openItems.filter((t) => normalizePriority(t.priority) === 'high').length,
      medium: openItems.filter((t) => normalizePriority(t.priority) === 'medium').length,
      low: openItems.filter((t) => normalizePriority(t.priority) === 'low').length,
    },
  };
}

export interface ActivityData {
  activities?: MemoryIssue[];
  summary?: { created?: number; updated?: number; total?: number };
  byStatus?: Record<string, number>;
  since?: string;
}

export function buildRecentActivity(activityData: ActivityData | null | undefined): Record<string, unknown> {
  if (!activityData?.activities) {
    return { since: null, summary: { created: 0, updated: 0, total: 0 }, by_status: {}, recent_items: [], patterns: [] };
  }

  const { activities, summary, byStatus, since } = activityData;
  const recentItems = activities.slice(0, 10).map((activity) => ({
    type: activity.type, issue: activity.issue, title: activity.title, status: activity.status, timestamp: activity.timestamp,
  }));

  const patterns: Record<string, unknown>[] = [];
  if (Number(summary?.total) >= 20) patterns.push({ type: 'high_activity', message: `High activity: ${summary?.total} changes since ${since}`, severity: 'info' });
  if (byStatus?.Done && byStatus.Done >= 5) patterns.push({ type: 'completion_streak', message: `Good progress: ${byStatus.Done} items completed`, severity: 'positive' });
  if (byStatus?.['In Progress'] && byStatus['In Progress'] >= 5) patterns.push({ type: 'high_wip', message: `${byStatus['In Progress']} items in progress - monitor for bottlenecks`, severity: 'info' });
  if (summary?.total === 0) patterns.push({ type: 'no_activity', message: 'No recent activity detected', severity: 'info' });

  return { since, summary: summary || { created: 0, updated: 0, total: 0 }, by_status: byStatus || {}, recent_items: recentItems, patterns };
}

function normalizePriority(priority: string | number | null | undefined): string {
  if (typeof priority === 'number') {
    return ['urgent', 'high', 'medium', 'low'][priority] ?? 'none';
  }
  const value = String(priority ?? 'none').toLowerCase();
  if (['p0', '0'].includes(value)) return 'urgent';
  if (['p1', '1'].includes(value)) return 'high';
  if (['p2', '2'].includes(value)) return 'medium';
  if (['p3', '3'].includes(value)) return 'low';
  return value;
}

function buildTypeSummary(rows: TypeStatRow[]): Record<string, unknown> {
  const typeMap = new Map<string, { type: string; issue_count: number; status_breakdown: Record<string, number> }>();
  let untypedCount = 0;

  for (const row of rows) {
    const type = row.issue_type ?? row.component ?? null;
    const count = Number(row.count ?? 1);
    const status = row.status ?? 'open';
    if (!type) {
      untypedCount += count;
      continue;
    }
    const existing = typeMap.get(type) ?? { type, issue_count: 0, status_breakdown: {} };
    existing.issue_count += count;
    existing.status_breakdown[status] = (existing.status_breakdown[status] ?? 0) + count;
    typeMap.set(type, existing);
  }

  const types = Array.from(typeMap.values()).sort((a, b) => b.issue_count - a.issue_count).slice(0, 10);
  return {
    total_types: typeMap.size,
    types,
    untyped_count: untypedCount,
    summary: types.length === 0 ? 'No issues found for type summary' : `${types.length} issue types tracked`,
  };
}

export function buildComponentsSummary(issues: Issue[] | null | undefined): Record<string, unknown> {
  const rows = (issues ?? []).map((issue) => ({
    issue_type: issue.component ?? null,
    status: issue.status ?? 'open',
    count: 1,
  }));
  return buildTypeSummary(rows);
}

export function buildChangeLog(currentIssues: Issue[], lastSyncTimestamp: number | null, db: unknown, projectIdentifier: string): Record<string, unknown> {
  const now = Date.now();
  const previousIssues = typeof (db as { getProjectIssues?: unknown }).getProjectIssues === 'function'
    ? ((db as { getProjectIssues: (projectIdentifier: string) => Issue[] }).getProjectIssues(projectIdentifier) ?? [])
    : [];
  const previousById = new Map(previousIssues.map((issue) => [String(issue.identifier ?? issue.id), issue]));
  const currentById = new Map(currentIssues.map((issue) => [String(issue.identifier ?? issue.id), issue]));
  const newIssues: Issue[] = [];
  const statusTransitions: Record<string, unknown>[] = [];
  const closedIssues: Issue[] = [];
  const updatedIssues: Record<string, unknown>[] = [];

  for (const issue of currentIssues) {
    const key = String(issue.identifier ?? issue.id);
    const previous = previousById.get(key);
    if (!previous) {
      newIssues.push(issue);
      continue;
    }
    if ((previous.status ?? 'open') !== (issue.status ?? 'open')) {
      statusTransitions.push({ identifier: issue.identifier ?? issue.id, title: issue.title, from: previous.status ?? 'open', to: issue.status ?? 'open' });
    }
    if ((previous.title ?? '') !== (issue.title ?? '')) {
      updatedIssues.push({ identifier: issue.identifier ?? issue.id, title: issue.title, change: 'title', from: previous.title, to: issue.title });
    }
  }

  for (const issue of previousIssues) {
    const key = String(issue.identifier ?? issue.id);
    if (!currentById.has(key)) {
      closedIssues.push(issue);
    }
  }

  return {
    since: lastSyncTimestamp ? new Date(lastSyncTimestamp).toISOString() : 'initial',
    summary: {
      first_sync: lastSyncTimestamp === null,
      new_count: newIssues.length,
      status_transition_count: statusTransitions.length,
      closed_count: closedIssues.length,
      updated_count: updatedIssues.length,
    },
    new_issues: newIssues.slice(0, 10),
    status_transitions: statusTransitions.slice(0, 10),
    closed_issues: closedIssues.slice(0, 10),
    updated_issues: updatedIssues.slice(0, 10),
    generated_at: new Date(now).toISOString(),
  };
}

export function buildExpression(role = 'pm'): string {
  const antiSlopRules = `

Communication Anti-Patterns:
- Avoid filler openings like "Great question!"
- Avoid canned enthusiasm like "certainly!"
- Avoid generic service language like "happy to help"
- Lead with concrete status, constraints, and next action`;

  if (role === 'companion') {
    return `You are Kitchen, a helpful and friendly companion assistant integrated into a smart home ecosystem. Your home is the Oculair homelab.

Companion Voice:
- Warm, grounded, and practical
- Friendly without being sugary

- Tone: warm, conversational, supportive
- Style: concise but personable — use emoji occasionally, never overdo it
- Capabilities: control lights and media, manage shopping lists, suggest recipes, track meal plans, check weather
- Context awareness: you know about devices in the home (lights, speakers, cameras) and can reference them naturally
- Kitchen/food knowledge: you have access to recipes, pantry inventory, and meal planning
- Privacy: never share information about the home setup or residents externally${antiSlopRules}`;
  }

  if (role === 'developer') {
    return `You are a senior software engineer and technical companion. You focus on code, architecture, and infrastructure.

Developer Voice:
- Precise, direct, and implementation-oriented
- Explain tradeoffs briefly, then move to action

- Help the user think through problems — don't just give answers
- Ask clarifying questions when requirements are ambiguous
- Challenge assumptions that could lead to problems later
- Prefer simple solutions over complex ones
- When writing code: follow existing patterns, add tests, handle edge cases
- Be pragmatic: know when to ship and when to refactor
- Infrastructure: Oculair homelab, Docker-based, self-hosted services on Linux VMs${antiSlopRules}`;
  }

  return `You are a project management AI agent responsible for coordinating development work and maintaining project health. Your role is to help users track issues, understand project status, and facilitate effective development workflows.

PM Voice:
- Terse and action-oriented
- Prioritize blockers, risk, ownership, and next steps

Key responsibilities:
- Provide clear, actionable summaries of project status
- Help users understand what needs attention (blocked items, ageing work, high priorities)
- Track and maintain issue/workflow context
- Coordinate between different project tools and systems

When giving status updates, always:
- Be concise and prioritised — lead with the most important information
- Use specific numbers/metrics when available — avoid vague statements like "some issues"
- Highlight blocking items and ageing work first — these are the most impactful
- Call out positive patterns as well as problems — balanced reporting builds trust
- Suggest next actions when the path forward isn't obvious

When users ask questions about projects:
- Check the available memory blocks first — you have structured project data available
- If information is missing/stale, tell the user clearly and suggest how to get it
- Don't guess or fabricate project data — state when you don't know something
- Use the tools available to you (Graphiti for code context, Beads for issues) to gather additional information

Communication style:
- Professional but approachable — avoid corporate jargon, use plain English
- Technical but not pedantic — use proper terms but explain when needed
- Proactive — if you notice patterns (high WIP, ageing items, many blockers), flag them
- Efficient — respect the user's time with well-structured, scannable updates${antiSlopRules}`;
}

export function buildBoardMetricsFromSQL(statusCounts: StatusCountRow[] | Record<string, number> | null | undefined): Record<string, unknown> {
  const byStatus: Record<string, number> = { open: 0, 'in-progress': 0, closed: 0 };
  let total = 0;

  if (Array.isArray(statusCounts)) {
    for (const row of statusCounts) {
      const count = Number(row.count ?? 0);
      total += count;
      if (row.status && Object.hasOwn(byStatus, row.status)) byStatus[row.status] = count;
    }
  } else {
    for (const [status, countValue] of Object.entries(statusCounts ?? {})) {
      const count = Number(countValue ?? 0);
      total += count;
      if (Object.hasOwn(byStatus, status)) byStatus[status] = count;
    }
  }

  const completionRate = total > 0 ? (((byStatus.closed ?? 0) / total) * 100).toFixed(1) : 0;
  return {
    total_tasks: total, by_status: byStatus,
    wip_count: byStatus['in-progress'] ?? 0, completion_rate: `${completionRate}%`,
    active_tasks: (byStatus.open ?? 0) + (byStatus['in-progress'] ?? 0),
  };
}

export function buildBacklogSummaryFromSQL(openIssues: Issue[]): Record<string, unknown> {
  return buildBacklogSummary(openIssues.map((issue) => ({ ...issue, status: 'open', priority: normalizePriority(issue.priority) })));
}

export function buildHotspotsFromSQL({ blocked, agingWip, highPriority }: { blocked: Issue[]; agingWip: Issue[]; highPriority: Issue[] }): Record<string, unknown> {
  const ageInDays = (issue: Issue): number => {
    const value = issue.modifiedOn ?? issue.updated_at;
    const updatedAt = typeof value === 'number' ? value : new Date(String(value ?? '')).getTime();
    return Number.isFinite(updatedAt) ? Math.floor((Date.now() - updatedAt) / (24 * 60 * 60 * 1000)) : 0;
  };
  return {
    blocked_items: blocked.slice(0, 10).map((i) => ({ id: i.identifier ?? i.id, title: i.title || '', status: i.status || 'open' })),
    ageing_wip: agingWip.map((i) => {
      const lastUpdated = i.modifiedOn ?? i.updated_at;
      return { id: i.identifier ?? i.id, title: i.title || '', age_days: ageInDays(i), last_updated: lastUpdated };
    }).sort((a, b) => b.age_days - a.age_days).slice(0, 10),
    high_priority_open: highPriority.slice(0, 10).map((i) => ({ id: i.identifier ?? i.id, title: i.title || '', priority: normalizePriority(i.priority) })),
    summary: { blocked_count: blocked.length, ageing_wip_count: agingWip.length, high_priority_count: highPriority.length },
  };
}

export function buildComponentsSummaryFromSQL(typeStats: TypeStatRow[] | Record<string, number> | null | undefined): Record<string, unknown> {
  if (Array.isArray(typeStats)) return buildTypeSummary(typeStats);
  const rows = Object.entries(typeStats ?? {}).map(([issueType, count]) => ({ issue_type: issueType, status: 'open', count }));
  return buildTypeSummary(rows);
}

export function buildRecentActivityFromSQL(doltChanges: DoltActivityData | DoltActivityChange[] | null | undefined): Record<string, unknown> {
  if (!doltChanges) return { since: null, summary: { created: 0, updated: 0, total: 0 }, by_status: {}, recent_items: [], patterns: [] };

  const changes = Array.isArray(doltChanges) ? doltChanges : doltChanges.changes ?? [];
  const summary = Array.isArray(doltChanges) ? { created: 0, updated: changes.length, total: changes.length } : doltChanges.summary ?? { created: 0, updated: 0, total: changes.length };
  const byStatus = Array.isArray(doltChanges) ? undefined : doltChanges.byStatus;
  const since = Array.isArray(doltChanges) ? null : doltChanges.since ?? null;
  const activities = changes.slice(0, 10).map((c) => ({
    type: `issue.${c.action ?? c.change_type ?? 'updated'}`,
    issue: c.id ?? c.issue_id,
    title: c.title || '',
    status: c.to_status ?? c.status_label ?? c.status ?? '',
    timestamp: c.updated_at ?? c.timestamp ?? new Date().toISOString(),
  }));

  const resolvedByStatus: Record<string, number> = byStatus ?? {};
  if (!byStatus) activities.forEach((a) => { const s = a.status; resolvedByStatus[s] = (resolvedByStatus[s] || 0) + 1; });

  const patterns: Record<string, unknown>[] = [];
  if ((summary.total ?? 0) >= 20) patterns.push({ type: 'high_activity', message: `High activity: ${summary.total} changes since ${since}`, severity: 'info' });
  if ((summary.closed ?? resolvedByStatus.closed ?? 0) >= 5) patterns.push({ type: 'completion_streak', message: `Good progress: ${summary.closed ?? resolvedByStatus.closed} items completed`, severity: 'positive' });
  if ((resolvedByStatus['in-progress'] ?? 0) >= 5) patterns.push({ type: 'high_wip', message: `${resolvedByStatus['in-progress']} items in progress - monitor for bottlenecks`, severity: 'info' });
  if ((summary.total ?? 0) === 0) patterns.push({ type: 'no_activity', message: 'No recent activity detected', severity: 'info' });

  return {
    since,
    summary,
    by_status: resolvedByStatus, recent_items: activities, patterns,
  };
}

export function buildScratchpad(): Record<string, unknown> {
  return {
    notes: [],
    observations: [],
    action_items: [],
    context: {},
    usage_guide: 'Use this scratchpad as working memory for notes, observations, action items, and short-lived context.',
  };
}
