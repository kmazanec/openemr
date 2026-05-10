import { describe, expect, it } from 'vitest';
import { readUrlPidFromSearch } from './launchPidHandoff';

describe('readUrlPidFromSearch', () => {
  it('returns the pid for a positive integer query value', () => {
    expect(readUrlPidFromSearch('?pid=101')).toBe('101');
    expect(readUrlPidFromSearch('?token_main=abc&pid=42')).toBe('42');
  });

  it('returns null when the pid is missing or empty', () => {
    expect(readUrlPidFromSearch('')).toBeNull();
    expect(readUrlPidFromSearch('?token_main=abc')).toBeNull();
    expect(readUrlPidFromSearch('?pid=')).toBeNull();
  });

  it('rejects non-positive-integer values', () => {
    // Zero and negatives are not real patient ids; legacy setpid()
    // and main_v2.php's pid->puuid lookup both treat them as "no
    // patient", so the SPA's toggle handoff must reject them too —
    // otherwise we'd navigate to /patient/0 and trigger a doomed
    // SMART authorize.
    expect(readUrlPidFromSearch('?pid=0')).toBeNull();
    expect(readUrlPidFromSearch('?pid=-5')).toBeNull();
    expect(readUrlPidFromSearch('?pid=12abc')).toBeNull();
    expect(readUrlPidFromSearch('?pid=abc')).toBeNull();
    expect(readUrlPidFromSearch('?pid=1.5')).toBeNull();
  });
});
