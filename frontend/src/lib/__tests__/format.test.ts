import { describe, expect, it, vi, afterEach } from 'vitest';
import { compactNumber, formatBytes, formatDate, initials, relativeTime, shortDigest } from '~/lib/format';

afterEach(() => {
  vi.useRealTimers();
});

describe('compactNumber', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1k'],
    [1200, '1.2k'],
    [99_400, '99.4k'],
    [125_000, '125k'],
    [1_250_000, '1.3M'],
    [250_000_000, '250M'],
  ])('formats %i as %s', (input, expected) => {
    expect(compactNumber(input)).toBe(expected);
  });

  it('survives non-finite input', () => {
    expect(compactNumber(Number.NaN)).toBe('0');
    expect(compactNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('relativeTime', () => {
  it('returns a placeholder for missing input', () => {
    expect(relativeTime(null)).toBe('unknown');
    expect(relativeTime(undefined)).toBe('unknown');
  });

  it('buckets recent timestamps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));

    expect(relativeTime(new Date('2026-09-16T11:59:58Z'))).toBe('just now');
    expect(relativeTime(new Date('2026-09-16T11:59:30Z'))).toBe('30s ago');
    expect(relativeTime(new Date('2026-09-16T11:30:00Z'))).toBe('30m ago');
    expect(relativeTime(new Date('2026-09-16T08:00:00Z'))).toBe('4h ago');
    expect(relativeTime(new Date('2026-09-14T12:00:00Z'))).toBe('2d ago');
  });

  it('falls back to an absolute date past 30 days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    expect(relativeTime(new Date('2026-01-02T12:00:00Z'))).toContain('2026');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [2048, '2.0 KB'],
    [1_048_576, '1.0 MB'],
  ])('formats %i as %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected);
  });
});

describe('shortDigest', () => {
  it('elides long digests', () => {
    expect(shortDigest('sha256:abcdef1234567890')).toBe('sha256:abcde…');
  });

  it('leaves short digests alone', () => {
    expect(shortDigest('sha256:abc', 20)).toBe('sha256:abc');
  });
});

describe('formatDate', () => {
  it('returns an em dash for missing input', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not-a-date')).toBe('—');
  });
});

describe('initials', () => {
  it('takes up to two initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('ada')).toBe('A');
    expect(initials('  ')).toBe('');
  });
});
