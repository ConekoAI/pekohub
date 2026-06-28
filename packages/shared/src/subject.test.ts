import { describe, it, expect } from 'vitest';
import {
  EMPTY_OWNER_SUBJECT,
  isEmptyOwnerSubject,
  isSessionPeer,
  parseSubject,
  Subject,
  subjectFromString,
  subjectId,
  subjectToString,
  SubjectKinds,
} from './subject.js';

describe('Subject', () => {
  describe('parseSubject / subjectToString round-trips', () => {
    const cases: Array<[string, Subject]> = [
      ['user:alice', { kind: 'user', id: 'alice' }],
      ['principal:helper', { kind: 'principal', id: 'helper' }],
      ['public', { kind: 'public' }],
    ];
    for (const [wire, parsed] of cases) {
      it(`parses "${wire}"`, () => {
        expect(parseSubject(wire)).toEqual(parsed);
      });
      it(`serialises ${parsed.kind} back to "${wire}"`, () => {
        expect(subjectToString(parsed)).toBe(wire);
      });
    }
  });

  it('treats the empty string as the empty-owner sentinel', () => {
    expect(parseSubject('')).toEqual(EMPTY_OWNER_SUBJECT);
    expect(isEmptyOwnerSubject(parseSubject(''))).toBe(true);
    expect(isEmptyOwnerSubject({ kind: 'user', id: 'alice' })).toBe(false);
    expect(isEmptyOwnerSubject(null)).toBe(false);
  });

  it('rejects the legacy `team:` wire token (ADR-041 clean break)', () => {
    // The Subject enum dropped the Team variant. A wire string
    // starting with `team:` should fail to parse.
    expect(parseSubject('team:eng')).toBeNull();
    expect(SubjectKinds).not.toContain('team');
  });

  it('rejects unknown kinds', () => {
    expect(parseSubject('robot:helper')).toBeNull();
  });

  it('rejects empty ids on non-public kinds', () => {
    expect(parseSubject('user:')).toBeNull();
    expect(parseSubject('principal:')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(parseSubject(null)).toBeNull();
    expect(parseSubject(undefined)).toBeNull();
  });

  describe('subjectId', () => {
    it('returns the id component for user/principal', () => {
      expect(subjectId({ kind: 'user', id: 'alice' })).toBe('alice');
      expect(subjectId({ kind: 'principal', id: 'helper' })).toBe('helper');
    });
    it('returns "public" for the unauthenticated kind', () => {
      expect(subjectId({ kind: 'public' })).toBe('public');
    });
  });

  describe('isSessionPeer', () => {
    it('true for user and principal (they carry per-session identity)', () => {
      expect(isSessionPeer({ kind: 'user', id: 'alice' })).toBe(true);
      expect(isSessionPeer({ kind: 'principal', id: 'helper' })).toBe(true);
    });
    it('false for public (no identity)', () => {
      expect(isSessionPeer({ kind: 'public' })).toBe(false);
    });
  });

  describe('subjectFromString', () => {
    it('returns the empty-owner sentinel on empty input', () => {
      expect(subjectFromString('', 'user')).toEqual(EMPTY_OWNER_SUBJECT);
    });
    it('parses a fully-qualified wire string', () => {
      expect(subjectFromString('principal:helper', 'user')).toEqual({
        kind: 'principal',
        id: 'helper',
      });
    });
    it('falls back to defaultKind for un-prefixed strings', () => {
      expect(subjectFromString('alice', 'user')).toEqual({ kind: 'user', id: 'alice' });
    });
    it('public is not a valid default kind', () => {
      // @ts-expect-error — public is excluded from the defaultKind type
      expect(() => subjectFromString('alice', 'public')).not.toThrow();
    });
  });
});
