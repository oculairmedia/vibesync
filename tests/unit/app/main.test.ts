import { describe, expect, it, vi } from 'vitest';

import { parseShutdownGraceMs } from '../../../src/app/main.js';

describe('parseShutdownGraceMs', () => {
  it('accepts a non-negative integer', () => {
    const warn = vi.fn();
    expect(parseShutdownGraceMs('12000', warn)).toBe(12000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('uses the default for empty, malformed, and negative values and warns', () => {
    for (const raw of ['', 'abc', '-1']) {
      const warn = vi.fn();
      expect(parseShutdownGraceMs(raw, warn)).toBe(20000);
      expect(warn).toHaveBeenCalledWith('VIBESYNC_SHUTDOWN_GRACE_MS', raw);
    }
  });
});
