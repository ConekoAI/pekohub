import { describe, expect, it } from 'vitest';
import { formatHubRef, hubRefPath, parseHubRef, type HubRef } from './hub-ids.js';

describe('parseHubRef', () => {
  const ids: Array<[string, HubRef]> = [
    ['@alice', { kind: 'person', handle: 'alice' }],
    ['@alice/ada', { kind: 'peko', owner: 'alice', name: 'ada' }],
    ['alice/ada', { kind: 'seed', owner: 'alice', name: 'ada' }],
    ['alice/ada@1.2.0', { kind: 'seed', owner: 'alice', name: 'ada', version: '1.2.0' }],
  ];
  for (const [text, ref] of ids) {
    it(`reads ${text} and writes it back`, () => {
      expect(parseHubRef(text)).toEqual(ref);
      expect(formatHubRef(ref)).toBe(text);
      expect(hubRefPath(ref)).toBe(`/${text}`);
    });
  }

  it('lowercases handles, keeps names as written', () => {
    expect(parseHubRef('@Alice/Ada')).toEqual({ kind: 'peko', owner: 'alice', name: 'Ada' });
    expect(parseHubRef(' @ALICE ')).toEqual({ kind: 'person', handle: 'alice' });
  });

  it('reads links to pages, new and old', () => {
    expect(parseHubRef('https://pekohub.ai/@alice')).toEqual({ kind: 'person', handle: 'alice' });
    expect(parseHubRef('https://pekohub.ai/@alice/ada')).toEqual({ kind: 'peko', owner: 'alice', name: 'ada' });
    expect(parseHubRef('https://pekohub.ai/%40alice/ada/')).toEqual({ kind: 'peko', owner: 'alice', name: 'ada' });
    expect(parseHubRef('pekohub.ai/@alice/ada')).toEqual({ kind: 'peko', owner: 'alice', name: 'ada' });
    expect(parseHubRef('https://pekohub.ai/alice/ada')).toEqual({ kind: 'seed', owner: 'alice', name: 'ada' });
    expect(parseHubRef('https://pekohub.ai/peko/alice/ada?x=1')).toEqual({ kind: 'peko', owner: 'alice', name: 'ada' });
    expect(parseHubRef('http://localhost:5173/p/alice/ada')).toEqual({ kind: 'peko', owner: 'alice', name: 'ada' });
    expect(parseHubRef('https://pekohub.ai/seeds/alice/ada')).toEqual({ kind: 'seed', owner: 'alice', name: 'ada' });
  });

  it('treats everything else as free text', () => {
    for (const text of ['', 'coding helper', 'ada', '@', '@alice/ada/x', 'a/b/c', '@al ice', '@alice/-x', 'alice/ada@', 'https://pekohub.ai/']) {
      expect(parseHubRef(text)).toBeNull();
    }
  });
});
