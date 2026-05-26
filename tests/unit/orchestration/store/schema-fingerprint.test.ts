import { describe, expect, it } from 'vitest';

import {
  BD_FINGERPRINT_BD_VERSION,
  BD_FINGERPRINT_TABLES,
  EXPECTED_BD_SCHEMA_FINGERPRINT,
  WrongBdSchemaError,
  canonicalizeCreateTableSql,
  computeSchemaFingerprint,
  perTableHashes,
} from '../../../../src/orchestration/store/schema-fingerprint.js';

const issuesCreate = `CREATE TABLE \`issues\` (
  \`id\` varchar(255) NOT NULL,
  \`title\` varchar(500) NOT NULL,
  \`metadata\` json DEFAULT (json_object()),
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`;

const issuesCreateReflowed = `CREATE TABLE \`issues\` (\`id\` varchar(255) NOT NULL,
    \`title\` varchar(500) NOT NULL,    \`metadata\` json DEFAULT (json_object()),
    PRIMARY KEY (\`id\`))    ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`;

const issuesCreateLowercased = `create table \`issues\` (
  \`id\` varchar(255) not null,
  \`title\` varchar(500) not null,
  \`metadata\` json default (json_object()),
  primary key (\`id\`)
) engine=innodb default charset=utf8mb4 collate=utf8mb4_0900_bin`;

const issuesCreateDrifted = `CREATE TABLE \`issues\` (
  \`id\` varchar(255) NOT NULL,
  \`title\` varchar(500) NOT NULL,
  \`metadata\` json DEFAULT (json_object()),
  \`new_column\` varchar(64) DEFAULT '',
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`;

const depsCreate = `CREATE TABLE \`dependencies\` (
  \`issue_id\` varchar(255) NOT NULL,
  \`depends_on_issue_id\` varchar(255),
  \`depends_on_id\` varchar(255) NOT NULL GENERATED ALWAYS AS (coalesce(\`depends_on_issue_id\`)) STORED,
  PRIMARY KEY (\`issue_id\`,\`depends_on_id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin`;

describe('canonicalizeCreateTableSql', () => {
  it('collapses whitespace runs, strips space around punctuation, and lowercases', () => {
    expect(canonicalizeCreateTableSql('CREATE   TABLE  Foo  ( x INT )')).toBe('create table foo(x int)');
  });

  it('is stable across cosmetic line-break and indentation drift', () => {
    expect(canonicalizeCreateTableSql(issuesCreate)).toBe(canonicalizeCreateTableSql(issuesCreateReflowed));
  });

  it('is stable across keyword-case drift', () => {
    expect(canonicalizeCreateTableSql(issuesCreate)).toBe(canonicalizeCreateTableSql(issuesCreateLowercased));
  });
});

describe('computeSchemaFingerprint', () => {
  it('is order-independent — passing tables in any order produces the same hash', () => {
    const rows1 = [
      { table: 'issues', createTableSql: issuesCreate },
      { table: 'dependencies', createTableSql: depsCreate },
    ];
    const rows2 = [
      { table: 'dependencies', createTableSql: depsCreate },
      { table: 'issues', createTableSql: issuesCreate },
    ];
    expect(computeSchemaFingerprint(rows1)).toBe(computeSchemaFingerprint(rows2));
  });

  it('is stable across cosmetic whitespace drift', () => {
    const a = computeSchemaFingerprint([{ table: 'issues', createTableSql: issuesCreate }]);
    const b = computeSchemaFingerprint([{ table: 'issues', createTableSql: issuesCreateReflowed }]);
    expect(a).toBe(b);
  });

  it('changes when a real column is added (drift detection)', () => {
    const a = computeSchemaFingerprint([{ table: 'issues', createTableSql: issuesCreate }]);
    const b = computeSchemaFingerprint([{ table: 'issues', createTableSql: issuesCreateDrifted }]);
    expect(a).not.toBe(b);
  });

  it('changes when a generated-column expression changes', () => {
    const original = { table: 'dependencies', createTableSql: depsCreate };
    const mutated = {
      table: 'dependencies',
      createTableSql: depsCreate.replace(
        'coalesce(`depends_on_issue_id`)',
        'coalesce(`depends_on_issue_id`,`depends_on_wisp_id`)',
      ),
    };
    expect(computeSchemaFingerprint([original])).not.toBe(computeSchemaFingerprint([mutated]));
  });
});

describe('perTableHashes', () => {
  it('produces a row per table that changes when only that table drifts', () => {
    const before = perTableHashes([
      { table: 'issues', createTableSql: issuesCreate },
      { table: 'dependencies', createTableSql: depsCreate },
    ]);
    const after = perTableHashes([
      { table: 'issues', createTableSql: issuesCreateDrifted },
      { table: 'dependencies', createTableSql: depsCreate },
    ]);
    expect(after.dependencies).toBe(before.dependencies);
    expect(after.issues).not.toBe(before.issues);
  });
});

describe('WrongBdSchemaError', () => {
  it('reports the bd version pin and drifted-table list in its message', () => {
    const err = new WrongBdSchemaError({
      expected: 'a'.repeat(64),
      actual: 'b'.repeat(64),
      bdVersionPin: '1.0.4',
      perTableDrift: [
        { table: 'issues', expectedHash: 'aaa', actualHash: 'bbb' },
        { table: 'dependencies', expectedHash: 'ccc', actualHash: 'ddd' },
      ],
    });
    expect(err.name).toBe('WrongBdSchemaError');
    expect(err.message).toContain('bd 1.0.4');
    expect(err.message).toContain('issues');
    expect(err.message).toContain('dependencies');
    expect(err.bdVersionPin).toBe('1.0.4');
    expect(err.perTableDrift).toHaveLength(2);
  });
});

describe('vendored constants', () => {
  it('include the tables the daemon INSERTs into or SELECTs from', () => {
    // If the daemon starts touching a new table, add it to BD_FINGERPRINT_TABLES
    // *and* bump EXPECTED_BD_SCHEMA_FINGERPRINT against the live bd schema.
    expect(BD_FINGERPRINT_TABLES).toContain('issues');
    expect(BD_FINGERPRINT_TABLES).toContain('dependencies');
    expect(BD_FINGERPRINT_TABLES).toContain('metadata');
  });

  it('have a non-placeholder fingerprint and pinned bd version', () => {
    expect(EXPECTED_BD_SCHEMA_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    expect(BD_FINGERPRINT_BD_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
