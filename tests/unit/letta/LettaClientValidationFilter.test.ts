import { afterEach, describe, expect, it } from 'vitest';

import {
  installLettaClientValidationFilter,
  uninstallLettaClientValidationFilter,
  type WarnTarget,
} from '../../../src/letta/LettaClientValidationFilter.js';

interface RecordingConsole extends WarnTarget {
  readonly calls: unknown[][];
  readonly originalRef: WarnTarget['warn'];
}

function makeConsole(): RecordingConsole {
  const calls: unknown[][] = [];
  const original: WarnTarget['warn'] = (...args: unknown[]) => {
    calls.push(args);
  };
  return { warn: original, calls, originalRef: original };
}

afterEach(() => {
  uninstallLettaClientValidationFilter();
});

describe('installLettaClientValidationFilter', () => {
  it('is a no-op when LETTA_SILENCE_VALIDATION_SPAM is unset', () => {
    const fake = makeConsole();
    const result = installLettaClientValidationFilter({ env: {}, console: fake });
    expect(result).toBe(false);
    fake.warn('Failed to validate.\n  - foo: bad');
    expect(fake.calls).toEqual([['Failed to validate.\n  - foo: bad']]);
  });

  it('is a no-op when LETTA_SILENCE_VALIDATION_SPAM is "false"', () => {
    const fake = makeConsole();
    expect(
      installLettaClientValidationFilter({
        env: { LETTA_SILENCE_VALIDATION_SPAM: 'false' },
        console: fake,
      }),
    ).toBe(false);
  });

  it('is a no-op when LETTA_SILENCE_VALIDATION_SPAM is "0"', () => {
    const fake = makeConsole();
    expect(
      installLettaClientValidationFilter({
        env: { LETTA_SILENCE_VALIDATION_SPAM: '0' },
        console: fake,
      }),
    ).toBe(false);
  });

  it('drops "Failed to validate." warnings when enabled', () => {
    const fake = makeConsole();
    installLettaClientValidationFilter({
      env: { LETTA_SILENCE_VALIDATION_SPAM: 'true' },
      console: fake,
    });
    fake.warn('Failed to validate.\n  - foo: bad');
    expect(fake.calls).toEqual([]);
  });

  it('passes through unrelated warnings unchanged', () => {
    const fake = makeConsole();
    installLettaClientValidationFilter({
      env: { LETTA_SILENCE_VALIDATION_SPAM: 'true' },
      console: fake,
    });
    fake.warn('some other warning');
    fake.warn('boot completed', { ok: true });
    expect(fake.calls).toEqual([['some other warning'], ['boot completed', { ok: true }]]);
  });

  it('is idempotent — second install does not re-wrap', () => {
    const fake = makeConsole();
    expect(
      installLettaClientValidationFilter({
        env: { LETTA_SILENCE_VALIDATION_SPAM: 'true' },
        console: fake,
      }),
    ).toBe(true);
    const afterFirst = fake.warn;
    expect(
      installLettaClientValidationFilter({
        env: { LETTA_SILENCE_VALIDATION_SPAM: 'true' },
        console: fake,
      }),
    ).toBe(true);
    expect(fake.warn).toBe(afterFirst);
  });

  it('uninstall restores the original warn', () => {
    const fake = makeConsole();
    installLettaClientValidationFilter({
      env: { LETTA_SILENCE_VALIDATION_SPAM: 'true' },
      console: fake,
    });
    expect(fake.warn).not.toBe(fake.originalRef);
    uninstallLettaClientValidationFilter(fake);
    expect(fake.warn).toBe(fake.originalRef);
  });
});
