import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTRACT_SCHEMA_VERSION,
  EVOLUTION_POLICY,
  CONTRACTS,
  toJsonSchema,
  toJsonSchemaBundle,
  FormulaContract,
  OrchestrationEventContract,
  SessionEventContract,
  MoleculeRootExec,
  ApiErrorContract,
  type ContractName,
} from '../../../../src/orchestration/contracts/index.js';

const ALL_NAMES = Object.keys(CONTRACTS) as ContractName[];

describe('contract versioning (vibesync-jxri.3)', () => {
  it('every top-level contract requires schema_version = the current version', () => {
    for (const name of ALL_NAMES) {
      // MoleculeRootExec/StepExec are embedded metadata, not top-level payloads.
      if (name === 'MoleculeRootExec' || name === 'MoleculeStepExec' || name === 'SessionEvent') continue;
      const parsed = CONTRACTS[name].safeParse({ schema_version: CONTRACT_SCHEMA_VERSION });
      // Should fail for missing required fields but NOT for schema_version.
      const versionIssue = !parsed.success && parsed.error.issues.find((i) => i.path[0] === 'schema_version');
      expect(versionIssue, `${name} should accept the current schema_version`).toBeFalsy();
    }
  });

  it('rejects a wrong schema_version (breaking-version guard)', () => {
    const r = FormulaContract.safeParse({ schema_version: 999, name: 'f', steps: [{ name: 's', role: 'coder' }] });
    expect(r.success).toBe(false);
  });

  it('the generated JSON Schema bundle is itself versioned and covers every contract', () => {
    const bundle = toJsonSchemaBundle();
    expect(bundle['schema_version']).toBe(CONTRACT_SCHEMA_VERSION);
    const contracts = bundle['contracts'] as Record<string, unknown>;
    for (const name of ALL_NAMES) expect(contracts[name], `${name} in bundle`).toBeDefined();
  });

  it('the committed schema bundle is in sync with the generator (no drift)', () => {
    const committed = readFileSync(
      join(process.cwd(), 'docs', 'reference', 'orchestration-contracts.schema.json'),
      'utf8',
    );
    const generated = JSON.stringify(toJsonSchemaBundle(), null, 2) + '\n';
    expect(committed).toBe(generated);
  });
});

describe('valid corpus (vibesync-jxri.3)', () => {
  it('accepts a well-formed Formula', () => {
    const r = FormulaContract.safeParse({
      schema_version: 1, name: 'onboard-feature', description: 'x',
      when_to_use: 'backlog item', steps: [
        { name: 'mayor', role: 'mayor' },
        { name: 'coder', role: 'coder', depends_on: ['mayor'], turn_timeout_ms: 900000 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('accepts a MoleculeRootExec with the closed outcome enum', () => {
    for (const outcome of ['completed', 'failed', 'cancelled']) {
      expect(MoleculeRootExec.safeParse({ formula: 'code-review', outcome }).success).toBe(true);
    }
  });

  it('accepts every SessionEvent variant', () => {
    const ts = '2026-07-17T20:00:00Z';
    const events = [
      { kind: 'started', ts },
      { kind: 'first-token', ts },
      { kind: 'message-delta', ts, text: 'hi' },
      { kind: 'tool-call', ts, tool: 'Agent', args: {} },
      { kind: 'tool-result', ts, tool: 'Agent', result: {}, ok: true },
      { kind: 'usage', ts, prompt: 10, completion: 5 },
      { kind: 'turn-done', ts, stopReason: 'end_turn' },
      { kind: 'error', ts, code: 'sse_read_error', message: 'timed out' },
      { kind: 'stopped', ts },
    ];
    for (const e of events) expect(SessionEventContract.safeParse(e).success, e.kind).toBe(true);
  });

  it('accepts an OrchestrationEvent with an OPEN kind vocabulary', () => {
    for (const kind of ['dispatcher/formula.completed', 'runtime/session.error', 'health-patrol/session.stalled', 'dispatcher/some.future.kind']) {
      const r = OrchestrationEventContract.safeParse({
        schema_version: 1, id: 'ev-1', ts: '2026-07-17T20:00:00Z', layer: 'dispatcher', kind,
      });
      expect(r.success, kind).toBe(true);
    }
  });
});

describe('invalid corpus (vibesync-jxri.3)', () => {
  it('rejects a Formula with zero steps', () => {
    expect(FormulaContract.safeParse({ schema_version: 1, name: 'f', steps: [] }).success).toBe(false);
  });
  it('rejects a non-RFC3339 timestamp', () => {
    expect(SessionEventContract.safeParse({ kind: 'started', ts: '2026-07-17 20:00:00' }).success).toBe(false);
    expect(SessionEventContract.safeParse({ kind: 'started', ts: 1234567890 }).success).toBe(false);
  });
  it('rejects a MoleculeRootExec outcome outside the closed enum', () => {
    expect(MoleculeRootExec.safeParse({ formula: 'f', outcome: 'partial' }).success).toBe(false);
  });
  it('rejects an OrchestrationEvent with an unknown LAYER (closed set)', () => {
    expect(OrchestrationEventContract.safeParse({
      schema_version: 1, id: 'e', ts: '2026-07-17T20:00:00Z', layer: 'aliens', kind: 'x/y',
    }).success).toBe(false);
  });
  it('rejects an unknown SessionEvent kind (closed provider vocabulary)', () => {
    expect(SessionEventContract.safeParse({ kind: 'telepathy', ts: '2026-07-17T20:00:00Z' }).success).toBe(false);
  });
});

describe('evolution / compatibility policy (vibesync-jxri.3)', () => {
  it('FORWARD-COMPAT: unknown fields are TOLERATED (ignored), not rejected', () => {
    // A newer producer adds a field; an older consumer must still accept it.
    const r = FormulaContract.safeParse({
      schema_version: 1, name: 'f', steps: [{ name: 's', role: 'coder', future_field: 42 }],
      brand_new_top_level_field: { anything: true },
    });
    expect(r.success).toBe(true);
  });

  it('FORWARD-COMPAT: OPEN vocabularies accept new values without a bump', () => {
    // New event kind + new role name — neither breaks an old consumer.
    expect(OrchestrationEventContract.safeParse({
      schema_version: 1, id: 'e', ts: '2026-07-17T20:00:00Z', layer: 'dispatcher', kind: 'dispatcher/brand.new.event',
    }).success).toBe(true);
    expect(FormulaContract.safeParse({
      schema_version: 1, name: 'f', steps: [{ name: 's', role: 'brand-new-role' }],
    }).success).toBe(true);
  });

  it('BACKWARD-COMPAT: an older payload (only required fields) still validates', () => {
    // The minimal historical shape — no optional fields — must still parse.
    expect(ApiErrorContract.safeParse({ schema_version: 1, detail: 'boom' }).success).toBe(true);
    expect(MoleculeRootExec.safeParse({ formula: 'code-review' }).success).toBe(true);
  });

  it('policy constants document the rules the tests enforce', () => {
    expect(EVOLUTION_POLICY.unknownFieldTolerance).toBe('ignore');
    expect(EVOLUTION_POLICY.versionField).toBe('schema_version');
    expect(EVOLUTION_POLICY.timestampFormat).toBe('rfc3339-utc');
  });

  it('every contract emits a JSON Schema (generated docs/types where practical)', () => {
    for (const name of ALL_NAMES) {
      const js = toJsonSchema(name);
      expect(js, name).toBeTypeOf('object');
      expect(Object.keys(js).length, name).toBeGreaterThan(0);
    }
  });
});
