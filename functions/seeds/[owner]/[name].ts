import { fetchJson, seedPreview, withPreview, type Context } from '../../../frontend/src/lib/preview';

/** `/seeds/<owner>/<name>`: the seed's own title and description in link previews. */
export const onRequestGet = (context: Context) =>
  withPreview(context, async (api, owner, name, url) =>
    seedPreview(
      await fetchJson(`${api}/v1/seeds/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`),
      owner,
      name,
      url,
    ),
  );
