import { pagePreview, withPreview, type Context } from '../../frontend/src/lib/preview';

/**
 * `/@alice/ada` (a peko) and `/alice/ada[@1.2.0]` (a seed): the page's own
 * title and description in link previews (hub ADR-009). Pages routes every
 * two-segment path here, `/@…` included; any other page is served unchanged.
 */
export const onRequestGet = (context: Context) => withPreview(context, pagePreview);
