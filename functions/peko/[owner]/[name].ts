import { fetchJson, pekoPreview, withPreview, type Context } from '../../../frontend/src/lib/preview';

/** `/peko/<owner>/<name>`: the peko's own title and description in link previews. */
export const onRequestGet = (context: Context) =>
  withPreview(context, async (api, owner, name, url) =>
    pekoPreview(
      await fetchJson(`${api}/v1/public/pekos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`),
      owner,
      name,
      url,
    ),
  );
