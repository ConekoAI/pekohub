import { describe, expect, it } from 'vitest';
import { classifyRepo, laneLabel, splitInstallRef, RETIRED_LANES, SEED_LANE } from '~/lib/repo';

/**
 * Pin the registry classification rules the seed directory depends
 * on. These encode an architectural decision, not a formatting
 * preference: the hub is seed-only (pekohub ADR-005 §2 / runtime
 * ADR-056 D6), so the `extensions/` and `agents/` lanes must classify
 * as retired and never render as seeds.
 */

describe('classifyRepo', () => {
  it('recognises the current seed lane', () => {
    const ref = classifyRepo('peko/principals/my-peko');
    expect(ref).toEqual({
      repo: 'peko/principals/my-peko',
      namespace: 'peko/principals',
      name: 'my-peko',
      lane: 'principals',
      isSeed: true,
      isRetired: false,
    });
  });

  it('keeps pre-ADR-005 two-segment paths readable as seeds', () => {
    const ref = classifyRepo('alice/my-peko');
    expect(ref?.lane).toBeNull();
    expect(ref?.namespace).toBe('alice');
    expect(ref?.isSeed).toBe(true);
    expect(ref?.isRetired).toBe(false);
  });

  it.each(RETIRED_LANES)('marks the retired %s lane', (lane) => {
    const ref = classifyRepo(`peko/${lane}/legacy-thing`);
    expect(ref?.lane).toBe(lane);
    expect(ref?.isRetired).toBe(true);
    expect(ref?.isSeed).toBe(false);
  });

  it('rejects paths that are not namespace/name', () => {
    expect(classifyRepo('single')).toBeNull();
    expect(classifyRepo('')).toBeNull();
    expect(classifyRepo('/')).toBeNull();
  });

  it('treats a deeper path as a namespace, not a lane', () => {
    // `peko/principals/team/foo` is not the 3-segment lane shape, so the
    // lane is unknown and the artifact stays visible.
    const ref = classifyRepo('peko/principals/team/foo');
    expect(ref?.lane).toBeNull();
    expect(ref?.namespace).toBe('peko/principals/team');
    expect(ref?.isSeed).toBe(true);
  });
});

describe('laneLabel', () => {
  it('calls the principals lane "seed" for users', () => {
    expect(laneLabel(SEED_LANE)).toBe('seed');
  });

  it('labels lane-less paths as legacy paths', () => {
    expect(laneLabel(null)).toBe('legacy path');
  });

  it('passes unknown lanes through verbatim', () => {
    expect(laneLabel('something-else')).toBe('something-else');
  });
});

describe('splitInstallRef', () => {
  it('splits host, multi-segment repo and tag', () => {
    expect(splitInstallRef('pekohub.ai/peko/principals/ada:1.0.0')).toEqual({
      host: 'pekohub.ai',
      repo: 'peko/principals/ada',
      tag: '1.0.0',
    });
  });

  it('handles a ref with no tag', () => {
    expect(splitInstallRef('pekohub.ai/peko/principals/ada')).toEqual({
      host: 'pekohub.ai',
      repo: 'peko/principals/ada',
      tag: null,
    });
  });

  it('treats a host-less ref as a bare repo', () => {
    expect(splitInstallRef('peko/principals/ada:latest')).toEqual({
      host: null,
      repo: 'peko/principals/ada',
      tag: 'latest',
    });
  });

  it('does not mistake a port for a tag', () => {
    expect(splitInstallRef('localhost:5000/peko/principals/ada:1.0.0')).toEqual({
      host: 'localhost:5000',
      repo: 'peko/principals/ada',
      tag: '1.0.0',
    });
  });

  it('returns null for an empty ref', () => {
    expect(splitInstallRef('   ')).toBeNull();
  });
});
