import { describe, it, expect } from 'vitest';
import {
  clip,
  escapeHtml,
  headTags,
  pekoPreview,
  seedPreview,
  withPreview,
  type Context,
} from '~/lib/preview';

describe('link previews (Pages Functions)', () => {
  it('builds a peko preview from its public profile', () => {
    const preview = pekoPreview(
      { liveInstance: { publicName: 'Ada', description: 'Reads   papers\nand keeps notes', owner: { name: 'Alice' } } },
      'alice',
      'ada',
      'https://pekohub.ai/peko/alice/ada',
    );
    expect(preview).toEqual({
      title: "Ada — Alice's peko on PekoHub",
      description: 'Reads papers and keeps notes',
      url: 'https://pekohub.ai/peko/alice/ada',
      type: 'profile',
    });
    expect(pekoPreview({ error: 'Peko not found' }, 'a', 'b', 'u')).toBeNull();
  });

  it('builds a seed preview, with a fallback description', () => {
    const preview = seedPreview({ name: 'ada', displayName: null, description: '' }, 'alice', 'ada', 'u');
    expect(preview?.title).toBe('ada — a seed by alice on PekoHub');
    expect(preview?.description).toContain('grow your own peko');
    expect(seedPreview(null, 'a', 'b', 'u')).toBeNull();
  });

  it('escapes everything that lands in the head', () => {
    const tags = headTags({ title: '"><script>x</script>', description: "it's <b>", url: 'https://h/p?a=1&b=2', type: 'profile' });
    expect(tags).not.toContain('<script>');
    expect(tags).toContain('&quot;&gt;&lt;script&gt;');
    expect(tags).toContain('it&#39;s &lt;b&gt;');
    expect(tags).toContain('a=1&amp;b=2');
    expect(escapeHtml('&')).toBe('&amp;');
  });

  it('clips long descriptions to one preview line', () => {
    const long = clip('word '.repeat(100), 50);
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long.endsWith('…')).toBe(true);
  });

  it('serves the page unchanged when the API has nothing', async () => {
    const page = new Response('<html><head><title>PekoHub</title></head></html>', {
      headers: { 'content-type': 'text/html' },
    });
    const context: Context = {
      request: new Request('https://pekohub.ai/peko/alice/missing'),
      env: {},
      params: { owner: 'alice', name: 'missing' },
      next: async () => page,
    };
    expect(await withPreview(context, async () => null)).toBe(page);
    expect(
      await withPreview(context, async () => {
        throw new Error('API down');
      }),
    ).toBe(page);
  });
});
