import { describe, expect, it, vi } from 'vitest';

import {
  LettaTeamsCliMissingError,
  LettaTeamsSdkMissingError,
  LettaTeamsVersionMismatchError,
  assertLettaTeamsVersionMatch,
  parseSemver,
  type VersionCheckDeps,
} from '../../../src/letta/LettaTeamsVersionCheck.js';

function makeDeps(overrides: Partial<VersionCheckDeps> = {}): Partial<VersionCheckDeps> {
  return {
    readSdkPackageJson: () => ({ version: '0.10.0' }),
    resolveCliPath: () => '/usr/local/bin/letta-teams',
    readCliVersion: () => '0.10.0',
    setEnv: () => undefined,
    ...overrides,
  };
}

describe('parseSemver', () => {
  it('parses X.Y.Z', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
  });
  it('strips a leading v', () => {
    expect(parseSemver('v0.10.1')).toEqual([0, 10, 1]);
  });
  it('ignores trailing pre-release suffix', () => {
    expect(parseSemver('0.10.0-beta.1')).toEqual([0, 10, 0]);
  });
  it('throws on unparseable input', () => {
    expect(() => parseSemver('not-a-version')).toThrow();
  });
});

describe('assertLettaTeamsVersionMatch', () => {
  it('passes through on exact match and returns resolved versions+path', () => {
    const setEnv = vi.fn();
    const result = assertLettaTeamsVersionMatch({
      env: {},
      deps: makeDeps({ setEnv }),
    });
    expect(result).toEqual({
      sdkVersion: '0.10.0',
      cliVersion: '0.10.0',
      cliPath: '/usr/local/bin/letta-teams',
    });
    expect(setEnv).toHaveBeenCalledWith('LETTA_TEAMS_CLI_ENTRY', '/usr/local/bin/letta-teams');
  });

  it('passes through on patch-only drift (major+minor still match)', () => {
    expect(() =>
      assertLettaTeamsVersionMatch({
        env: {},
        deps: makeDeps({
          readSdkPackageJson: () => ({ version: '0.10.0' }),
          readCliVersion: () => '0.10.7',
        }),
      }),
    ).not.toThrow();
  });

  it('throws LettaTeamsVersionMismatchError on minor skew with actionable npm command', () => {
    let caught: unknown = null;
    try {
      assertLettaTeamsVersionMatch({
        env: {},
        deps: makeDeps({
          readSdkPackageJson: () => ({ version: '0.10.0' }),
          readCliVersion: () => '0.8.1',
        }),
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LettaTeamsVersionMismatchError);
    const err = caught as LettaTeamsVersionMismatchError;
    expect(err.sdkVersion).toBe('0.10.0');
    expect(err.cliVersion).toBe('0.8.1');
    expect(err.message).toContain('npm install -g letta-teams@0.10.0');
  });

  it('throws LettaTeamsVersionMismatchError on major skew', () => {
    expect(() =>
      assertLettaTeamsVersionMatch({
        env: {},
        deps: makeDeps({
          readSdkPackageJson: () => ({ version: '1.0.0' }),
          readCliVersion: () => '0.10.0',
        }),
      }),
    ).toThrow(LettaTeamsVersionMismatchError);
  });

  it('throws LettaTeamsCliMissingError when CLI cannot be resolved', () => {
    expect(() =>
      assertLettaTeamsVersionMatch({
        env: {},
        deps: makeDeps({ resolveCliPath: () => null }),
      }),
    ).toThrow(LettaTeamsCliMissingError);
  });

  it('throws LettaTeamsSdkMissingError when SDK package.json is unresolvable', () => {
    expect(() =>
      assertLettaTeamsVersionMatch({
        env: {},
        deps: makeDeps({ readSdkPackageJson: () => null }),
      }),
    ).toThrow(LettaTeamsSdkMissingError);
  });

  it('throws LettaTeamsSdkMissingError when SDK package.json has no version', () => {
    expect(() =>
      assertLettaTeamsVersionMatch({
        env: {},
        deps: makeDeps({ readSdkPackageJson: () => ({}) }),
      }),
    ).toThrow(LettaTeamsSdkMissingError);
  });

  it('does NOT overwrite LETTA_TEAMS_CLI_ENTRY when the operator already set it', () => {
    const setEnv = vi.fn();
    assertLettaTeamsVersionMatch({
      env: { LETTA_TEAMS_CLI_ENTRY: '/custom/letta-teams' },
      deps: makeDeps({
        resolveCliPath: (cliEntryEnv) => cliEntryEnv ?? null,
        setEnv,
      }),
    });
    expect(setEnv).not.toHaveBeenCalled();
  });

  it('passes the env override down to resolveCliPath', () => {
    const resolveCliPath = vi.fn(() => '/anything');
    assertLettaTeamsVersionMatch({
      env: { LETTA_TEAMS_CLI_ENTRY: '/explicit' },
      deps: makeDeps({ resolveCliPath }),
    });
    expect(resolveCliPath).toHaveBeenCalledWith('/explicit');
  });
});
