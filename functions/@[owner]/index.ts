import { fetchJson, personPreview, withPreview, type Context } from '../../frontend/src/lib/preview';

/** `/@alice`: a person's own title and description in link previews (hub ADR-009). */
export const onRequestGet = (context: Context) =>
  withPreview(context, async (api, handle, _name, url) =>
    personPreview(await fetchJson(`${api}/v1/people/${encodeURIComponent(handle.toLowerCase())}`), handle, url),
  );
