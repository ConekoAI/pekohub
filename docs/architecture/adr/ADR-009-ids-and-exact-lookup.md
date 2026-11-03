# ADR-009: One ID format per kind; people and pekos are found only by exact ID

Date: 2026-11-02
Status: Accepted
Supersedes: the public directory of ADR-003 (listing, search, curated feeds of pekos)
Related: ADR-005 (share URL `/peko/:owner/:name`), ADR-008 (seeds as text)

## Context

The website advertised public pekos: a homepage section, a Pekos page with search,
categories and "trending / new / featured" feeds, backed by `/v1/discovery/*` and
`/v1/instances/public*`. A peko runs on someone's computer and talks for them. People
make one public so others can reach it, not to have it promoted to strangers, and a
listing invites scraping and unwanted traffic.

People, pekos and seeds also had no common naming. A peko's page was
`/peko/alice/ada`, a seed's `/seeds/alice/ada`, and a person had no page. The same
`alice/ada` named both a peko and a seed.

## Decision

### D1. One ID format per kind, and the ID is the page

| Kind   | ID                                  | Page                    |
|--------|-------------------------------------|-------------------------|
| person | `@alice`                            | `pekohub.ai/@alice`     |
| peko   | `@alice/ada`                        | `pekohub.ai/@alice/ada` |
| seed   | `alice/ada`, or `alice/ada@1.2.0`   | `pekohub.ai/alice/ada`  |

`@` marks someone you can talk to; a bare `owner/name` is something you download.
Handles are account namespaces and are lowercase; peko and seed names keep their case.
The parser and formatter live in `@pekohub/shared` (`parseHubRef`, `formatHubRef`), so
the backend, the website and the Pages Functions read IDs the same way. It also reads a
pasted link to a page, including the old `/peko/…`, `/p/…` and `/seeds/…` forms.

Links already shared keep working. `frontend/public/_redirects` sends
`/peko/:owner/:name` and `/p/:owner/:name` to `/@:owner/:name`, and
`/seeds/:owner/:name` to `/:owner/:name`, with a 301 at the edge so link previews
follow. The single-page app redirects the same paths for in-app navigation.
`shareUrl` on directory answers, seed `webUrl`, and `GET /v1/meta` `pages` (URL
templates per kind) emit the new forms.

### D2. People and pekos are found only by their exact ID

Like an account on Discord, a public peko is reachable by anyone who has its ID. It is
never listed, browsed, featured or searched by text. People follow the same rule.

- The homepage peko section, the Pekos page and its feeds are removed. `/pekos` and
  `/discover` redirect to search.
- `GET /v1/discovery/search`, `/v1/discovery/feed/:feed`, `/v1/instances/public` and
  `/v1/instances/public/search` answer `410 { code: "pekos_not_listed" }`, so an older
  client can say why its list is empty.
- Pekos are no longer indexed. The Meilisearch plugin deletes the old `instances` index
  on startup, and the Postgres search has no peko query.
- A person's page (`GET /v1/people/:handle`) shows their profile and their published
  seeds, never their pekos.

Seeds stay browsable and full-text searchable.

### D3. `@owner/name` means the peko made public most recently

A peko's name is unique on its computer, but one owner may run two pekos with the same
name on two computers, and both may be public. Before this ADR the directory answered
`409 ambiguous` and the share link broke.

When two pekos match, the one made public most recently wins. `instances.published_at` is
set when a peko becomes public, by the runtime's announce or the owner console. It is
cleared when the peko stops being public. Resolution (`getByHandle`, used by the
directory, the public profile and chat) orders public before non-public, then
`published_at` newest first, then most recently seen. A handle always resolves, and the
409 is gone.

We did not refuse to make the second same-named peko public because:

- Most changes to exposure arrive as runtime announces over the tunnel. Refusing one would
  take the peko offline, or reject the whole announce, for a naming clash its owner
  can't see from the desktop.
- Both pekos belong to the same owner (an announce must carry the runtime's own account),
  so no one else can take over a handle. The owner chooses which one the ID means by
  making that one public again, or the other one private.
- The Hub ID stays the unambiguous address for machines. `@owner/name` is for people.

### D4. One search space

`GET /v1/search?q=` reads the query as an ID first:

- `@alice` or `@alice/ada` returns that person, or that public peko, in `exact`, and
  nothing else.
- `alice/ada[@1.2.0]` returns the seed in `exact`, plus a public peko `@alice/ada` if one
  exists (an exact match, labelled as a peko), then a text search for `alice ada` over
  seeds in `items`.
- Anything else is a full-text search over seeds.

`queryKind` says how the query was read. The website has one search box in the nav, and
results on `/search`, each labelled person, peko or seed.

## Consequences

- No one can discover pekos by browsing. Owners share the ID or the link.
- Desktop builds that parse only `/peko/…` share links can't read the new `/@…` links.
  The desktop is updated to accept both, and a typed `@alice/ada` (peko-desktop PR). Its
  Discover page, which read `/v1/discovery/search`, becomes an exact-ID lookup.
- `featured` and `category` on instances no longer affect anything. The columns stay
  until a migration removes them.
- Pages Functions: Pages routes every two-segment path, `/@…` included, to
  `functions/[owner]/[name].ts`, which branches on the `@`. `/@owner` has its own
  `functions/@[owner]/index.ts`. `_routes.json` keeps built assets off Functions.

## Amendment (2026-11-03): the website searches seeds only

People talk on the desktop, so that is where they look someone up. The website's search
box (in the nav, on the home page, on `/seeds`) now searches seeds only, with results on
`/seeds?q=`; it shows no person or peko hits. A leading `@` is dropped, so `@alice` finds
alice's seeds, and an exact seed ID (`alice/ada`) comes first. `/search`, `/pekos` and
`/discover` redirect to `/seeds`. A person's page (`/@alice`) is reached from their
seeds, as on GitHub; a peko's page from its share link.

`GET /v1/search` is unchanged: the desktop still uses its `exact` hits to find a person or
a peko by ID and add them as a contact.
