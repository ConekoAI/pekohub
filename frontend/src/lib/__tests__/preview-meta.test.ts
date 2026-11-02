import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  clip,
  escapeHtml,
  headTags,
  pagePreview,
  pekoPreview,
  personPreview,
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
      'https://pekohub.ai/@alice/ada',
    );
    expect(preview).toEqual({
      title: "Ada — Alice's peko on PekoHub",
      description: 'Reads papers and keeps notes',
      url: 'https://pekohub.ai/@alice/ada',
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

  it("builds a person's preview, naming no pekos", () => {
    const preview = personPreview({ handle: 'alice', displayName: 'Alice' }, 'alice', 'https://pekohub.ai/@alice');
    expect(preview).toEqual({
      title: 'Alice (@alice) on PekoHub',
      description: 'Alice on PekoHub, and the seeds they publish.',
      url: 'https://pekohub.ai/@alice',
      type: 'profile',
    });
    expect(personPreview({ error: 'No one has that handle' }, 'x', 'u')).toBeNull();
  });

  describe('a two-segment page is a peko or a seed by its ID', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubApi() {
      const fetched: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        fetched.push(url);
        const body = url.includes('/v1/public/pekos/')
          ? { liveInstance: { publicName: 'Ada', owner: { name: 'Alice' } } }
          : { name: 'ada', displayName: 'Ada seed' };
        return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      });
      return fetched;
    }

    it('/@alice/ada looks up the public peko', async () => {
      const fetched = stubApi();
      const preview = await pagePreview('https://api.test', '@Alice', 'ada', 'u');
      expect(fetched).toEqual(['https://api.test/v1/public/pekos/alice/ada']);
      expect(preview?.title).toBe("Ada — Alice's peko on PekoHub");
    });

    it('/alice/ada@1.2.0 looks up the seed', async () => {
      const fetched = stubApi();
      const preview = await pagePreview('https://api.test', 'alice', 'ada@1.2.0', 'u');
      expect(fetched).toEqual(['https://api.test/v1/seeds/alice/ada']);
      expect(preview?.title).toBe('Ada seed — a seed by alice on PekoHub');
    });
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
      request: new Request('https://pekohub.ai/@alice/missing'),
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
