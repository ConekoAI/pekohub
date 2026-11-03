# PekoHub changelog

## 0.1.0 — pre-launch

- Reports and moderation (gap map B2/B3). Signed-in people report a seed (or one version),
  a public peko, a person or a group from a Report button on its page (`POST /v1/reports`,
  10 an hour per account). Accounts have a role, `user` / `moderator` / `admin`; moderators
  see the open reports on `/admin` and can hide a seed, yank a version, force a peko off the
  Hub (pushed down its tunnel; its runtime can't re-announce it until a moderator restores
  it), or suspend the account behind it (signed out everywhere, runtimes disconnected and
  refused at the handshake). Every action is in the `moderation` audit log. Reading another
  namespace's audit log now needs the admin role in every environment; before, any signed-in
  account could outside production. Migration `0009_moderation`.
- Errors reach Sentry when a DSN is set: the API's 5xx answers, tunnel faults, scheduled-job
  failures and crashes (`SENTRY_DSN`), and the website's uncaught errors and route errors
  (`VITE_SENTRY_DSN`, whose host the CSP then allows). Neither sends URLs' query strings,
  headers or cookies; without a DSN the SDK isn't loaded.
- `/health` checks the database: 503 with `"database":"unreachable"` when `select 1` fails or
  takes over 5 s. `/metrics` needs `Authorization: Bearer $METRICS_TOKEN` and doesn't exist
  without one. `/docs` exists only with `API_DOCS=true` and no longer calls the API an OCI
  registry.
- `fly.production.toml`, a nightly encrypted backup to R2 (`backup-production.yml`), a tunnel
  and health probe (`scripts/probe-uptime.mjs`, `uptime.yml`) and a restore drill
  (`scripts/restore-drill.sh`), all described in DEPLOYMENT.md; the workflows stay off until
  their secrets and variables are set.
- A peko changes owner only when the new owner accepts (ADR-081 D4, amended). Transferring
  makes an offer (`POST …/transfer` answers 202; one open offer per peko, for 7 days);
  the recipient accepts with `POST …/transfer/accept` or declines with `DELETE …/transfer`,
  which also withdraws it, and `GET /v1/me/transfers` lists both directions. The owner
  console shows incoming offers with Accept / Decline. A transfer started on the runtime
  (`principal_transfer`) is answered "Offered to @…" and the runtime learns the new owner
  when it is accepted. Migration `0009_transfer_offers_api_key_prefix`.
- API keys: a new key's lookup prefix is `pkr_` + 12 hex characters, unique (a 6-character
  one collided at a few thousand keys and locked the second key out), and keys are stored
  as SHA-256 instead of bcrypt, which cost every key-authenticated request about 0.3 s of
  CPU. Older keys keep working and are rehashed on first use.
- A request that isn't signed in answers 401 everywhere (some routes answered 500), and a
  server error answers "Internal Server Error" without its message; the detail goes to the
  log. The test app uses the same error handler as the server.
- The relay takes at most 600 channel events and 120 channel invites a minute from a runtime;
  more are dropped (the sender's outbox resends them). Metrics
  `hub.channel_event.rate_limited`, `hub.channel_invite.rate_limited`.
- A removed seed version is never published again: removing a version (or the seed) clears
  its text but keeps its number, so `alice/ada@1.0.0` always means one seed. The publisher
  can publish new versions under the name.
- The per-IP limits on sign-in, OAuth and the chat proxy forget idle IPs and track at most
  50,000. `/v1/auth/me` and `/v1/auth/refresh`, which every website load calls, are under
  the global limit only; the rest of `/v1/auth/*` allows 20 a minute (was 10).
- First sign-in no longer fails when the name is taken. A new account's handle comes from
  the GitHub login or the Google address before the `@`, made valid (lowercase letters,
  digits, `-`, `_`, at most 39 characters — what `@handle` IDs accept) and numbered when
  someone holds it (`john-2`). Before, a second "john" across providers got a 500 on every
  sign-in, and a GitHub login kept its capitals, so `@Alice` was never found.
- `POST /v1/instances` is gone. A peko's row is made only by its runtime's announce: a row
  made over HTTP could take a peko's ID (runtimes derive it from their DID and the peko's
  name) and block its registration for good.
- Refresh tokens forgive a race. A token rotated in the last 30 seconds still refreshes
  while the token that replaced it is live, so two tabs, two desktop calls or a retry after
  a lost response no longer read as theft and sign the account out of every app. A copy
  presented after its successor was spent still revokes every session.
- The tunnel takes messages of at most 16 MiB (`ws` allowed 100 MiB, before the handshake
  too); a bigger one closes the socket with 1009.
- Sign-in hands the website its token in the URL fragment (`/auth/callback#token=…`), which
  never reaches a server or a Referer, and the page drops it from the address bar. Every
  website page carries a Content-Security-Policy (scripts from the site only, API origin
  from `PEKOHUB_API`, no framing), HSTS, `nosniff` and `X-Frame-Options: DENY`, added by
  `functions/_middleware.ts`.
- The website shows "Sign in" at once. Without a saved token it no longer asks the API who
  is signed in (it could only answer 401) and waited on that round trip — a CORS preflight
  and a request to a cold or stopped API — with a spinner. GET requests drop their
  `Content-Type` header, so reads cross-origin no longer pay a preflight. An expired access
  token is now refreshed from the refresh cookie instead of showing a returning visitor as
  signed out, and sign-in loads the user before leaving `/auth/callback`.
- The website is redesigned: navy surfaces, one brand-blue accent, flat cards and hairline
  borders in place of the cyan/violet gradients, glows and graph paper. Pages say less — no
  mono eyebrow labels or explanatory subtitles. The home page is a hero, four short
  features, "Set up with your agent" and three questions; the footer is one row of links.
  The owner console tabs are text-only and the manage dialog's options are one line each.
  Destructive actions and errors keep a soft red; it is the only other hue.
- Set up with your agent: the home and download pages carry a prompt to paste into a
  coding agent (Claude Code, Codex, …), which installs the peko CLI, adds a model, starts
  the daemon and creates a first peko, asking the person for the model, key and name. The
  install command sits beside it.
- The website searches seeds only, from one box in the header (ADR-009 amendment): results
  on `/search?q=`, `/` focuses it, and people and pekos never show. A leading `@` is
  dropped, so `@alice` finds alice's seeds. There is no seed directory any more: `/seeds`,
  `/pekos` and `/discover` redirect to `/search`. Finding a person or peko by ID is the
  desktop's job; `GET /v1/search` keeps its `exact` hits for it.
- Groups get IDs, pages and invite links (peko-runtime ADR-092 D3–D6). A group's home
  registers it over the tunnel (`group_register` → `group_registered { groupId }`); the Hub
  assigns a bare-number ID (a snowflake, like a Discord server's), so group names can be
  anything and needn't be unique. The Hub keeps the name, owner, home and visibility
  (`invite_only` or `public`) and the accounts in the group as the home reports them
  (`group_roster`) — never posts or peko members. `/g/<id>` is the group's page: a public
  group shows to anyone; an invite-only one only with an invite link (`?invite=<token>`, a
  JWS signed by the home runtime, checked for signature and expiry). Searching a bare number
  opens that group. `tunnel_group_join_request` relays a person's request to join (with the
  invite, when there is one) to the home, which decides. A person's devices learn their
  groups with `account_groups_request` → `account_groups` (and `GET /v1/me/groups`). Group
  history is read from the home like a peko's (`GET /v1/groups/:id/history`, members only,
  decided by the home); a peko's runtime may ask a group's home for history signed with the
  peko's own key. Migration `0008_group_registry`.
- People can be invited to groups on other computers (peko-runtime ADR-092 D2). The relay
  carries `tunnel_group_invitation`, which a group's home sends to a person's account and
  the Hub delivers to every runtime registered to that account (an offline one wakes the
  home when it connects; at most 60 a minute per runtime), and `tunnel_group_join`, the
  person's answer, relayed to the home only from a runtime registered to that person.
  Neither is stored. Metrics: `hub.group_invitation.*`, `hub.group_join.*`.
- Your history with a remote peko follows you (peko-runtime ADR-091). The relay carries two
  new tunnel messages, `tunnel_channel_history_request` and `tunnel_channel_history`: a
  person's runtime asks a peko's host for a page of their conversation, and the host answers.
  A request is relayed only from the runtime registered to the person's account (as for every
  person-authored envelope), at most 120 a minute per runtime; to an offline host it notes
  the waiter, so the person's runtime catches up when the host is back. The Hub never stores
  or logs either. New `GET /v1/public/pekos/:owner/:name/history?before=&after=&limit=` for
  clients without a runtime: signed-in only, the caller's own conversation, read from the
  host (`503 host_offline` when it isn't connected). Metrics: `hub.channel_history.*`.
- A message to a runtime that was offline goes out as soon as that runtime reconnects. When
  the relay drops a channel envelope because its recipient is offline, it remembers that the
  sender waits on it (runtime ids only, in memory, up to 30 days; never the envelope). When the
  recipient connects, each waiting sender still connected gets `peer_runtime_online
  { runtimeId }` and resends from its outbox at once, instead of at its next backoff tick (up to
  an hour). Needs peko-runtime with the matching change (peko-runtime#543). Metric:
  `hub.peer_runtime_online.sent`.
- People, pekos and seeds share one search space with one ID format per kind (ADR-009):
  a person is `@alice`, a peko `@alice/ada`, a seed `alice/ada` (or `alice/ada@1.2.0`), and
  each ID is its page: `pekohub.ai/@alice`, `/@alice/ada`, `/alice/ada`. Old `/peko/…`,
  `/p/…` and `/seeds/…` links redirect (301 at the edge, `frontend/public/_redirects`).
  `shareUrl`, seed `webUrl` and the new `GET /v1/meta` `pages` templates use the new forms.
- Public pekos are no longer advertised. Like an account on Discord, a public peko is
  reachable by its exact ID only and is never listed, featured or searched by text. The
  homepage peko section, the Pekos page and its feeds are gone (`/pekos`, `/discover` →
  `/search`). `/v1/discovery/search`, `/v1/discovery/feed/:feed`, `/v1/instances/public`
  and `/v1/instances/public/search` answer 410 `pekos_not_listed`. Pekos are no longer
  indexed, and Meilisearch's old `instances` index is dropped on startup. People are
  exact-ID only too: `GET /v1/people/:handle` and the page `/@alice` show a profile and
  published seeds, never pekos.
- One search box (nav, `/search`, the homepage): `GET /v1/search` reads the query as an ID
  first. `@alice` or `@alice/ada` returns that person or public peko in `exact`, and nothing
  else. `alice/ada` returns that seed, and a public `@alice/ada` labelled as a peko, before
  the seed text search. Anything else searches seeds. The response adds `queryKind` and `exact`.
- `@owner/name` always names one peko. When an owner has two public pekos with one name,
  the one made public most recently wins (`instances.published_at`, set when a peko
  becomes public by announce or console, cleared when it stops). The directory no longer
  answers 409 "ambiguous".
- Link previews follow the new pages: Pages Functions `functions/[owner]/[name].ts` (a peko
  for `/@…`, otherwise a seed) and `functions/@[owner]/index.ts` (a person), with
  `_routes.json` keeping built assets off Functions.
- Fixed: without Meilisearch, seed search could report another seed's version (the
  version subquery bound `id` to `bundle_versions`).

- The API runs on nothing but Postgres. Meilisearch, Redis and blob storage are optional:
  without `MEILISEARCH_URL`, search (`/v1/search`, the directory's search and feeds) reads
  Postgres directly (`services/pg-search.ts`); without `REDIS_URL`, quotas and throttles stay
  in memory; without `S3_*`, there is no blob store (seeds are text, nothing stores blobs).
  `MIGRATION_DATABASE_URL` gives drizzle-kit a direct connection where the app uses a pooler.
  Staging deploys to Fly.io with Neon (`fly.staging.toml`, DEPLOYMENT.md), stopping when idle.
- An owner console. The signed-in area has four tabs — **Pekos**, **Seeds**, **Runtimes**,
  **Account** — instead of mixing in public pages. New: `/dashboard/runtimes` (each
  computer: connected now or last seen, pekos it has online, unregister),
  `/dashboard/seeds` (your published seeds with downloads), a **Signed-in apps** panel on
  Account (Peko desktop, the CLI: sessions, last active, sign out everywhere), and an
  **Owner** tab on a peko to transfer it to another account by handle. API:
  `GET /v1/runtimes` adds `connected` and `pekoCount`; `GET /v1/seeds?owner=<handle>`;
  `GET /v1/auth/apps` and `DELETE /v1/auth/apps/:clientId`; the transfer endpoint takes
  `{ ownerHandle }` as well as `{ ownerId }`.
- The website leads to the desktop app. A new landing page says what a peko is, shows how
  to get one in three steps, and puts **Download Peko** first; a `/download` page offers
  Peko desktop for macOS, Windows and Linux (the visitor's platform marked) and the `peko`
  CLI one-liner. New `/status` (live checks of the API, directory and seed registry from
  the browser), `/terms` and `/privacy` (plain-language drafts), per-page tab titles, and
  a footer with Product / Resources / Legal links.
- Share links preview properly: Cloudflare Pages Functions write each peko's and seed's
  title, description, OpenGraph and Twitter tags (and canonical URL) into the page for
  crawlers, from the API (`PEKOHUB_API`), and serve it unchanged when the API is down.

- A tunnel contract check (`scripts/check-tunnel-contract.mjs`, CI job "Tunnel contract")
  type-checks every message peko-runtime sends or accepts — its golden samples in
  `peko-rs/core/src/tunnel/fixtures/tunnel_messages.json` — against the Hub's
  `TunnelMessage`, and lists types only one side knows. It found and this fixes the drift:
  `authorSignature` on channel envelopes, `creatorDid` and `kind` on invites, the
  `received` channel event and `via` / `msg_id` / `reply_to` / `attachments` on posts,
  `hubId` / `identityKey` / `name` on invite members, and `agentDid` on announces. The
  `invite_mint` / `invite_minted` / `invite_revoke` / `invite_revoked` types are Hub-only
  (the runtime has no handler) and are listed as known drift.

- An envelope that speaks for a person (`sourcePrincipalDid = user:hub:<account>`,
  runtime ADR-090 D3) is relayed only from the runtime registered to that account. A
  person has no signing key, so their runtime vouches for them; this check stops a
  registered runtime from claiming another account's person. Refused envelopes are
  dropped and counted (`hub.channel_{event,invite}.rejected_person_account`); the tunnel
  stays up.
- The registry publishes seeds as text (ADR-008). `POST /v1/seeds` takes `{ seed, version,
  readme? }` from a signed-in user and publishes `<handle>/<name>`; the Hub refuses a seed
  carrying an identity, owner, grants, or deployment state, and anything over 64 KB.
  `GET /v1/seeds`, `/v1/seeds/:owner/:name`, and `…/versions/:v/seed.toml` (download,
  `latest` works) serve them; the publisher deprecates and deletes. The website gains
  `/seeds/new` (paste or drop the file), and the seed page leads with Download plus the
  `peko create … -s …` command. Migration `0007_seed_content` adds
  `bundle_versions.content` and the seed summary columns on `bundles`. The OCI surface
  (`/v2/*`), `/v1/bundles/*`, the `/api/v1` aliases, blob GC (`GC_*` settings), and the
  shared OCI types are removed — the runtime registry client that used them was deleted in
  runtime ADR-066 D7. Seeds pushed through OCI stay in the database but are not listed.

- The API lives on `api.pekohub.ai` and the website on `pekohub.ai`. `GET /v1/meta` names
  both (`apiOrigin`, `webOrigin`, `tunnelUrl`), and directory answers
  (`/v1/principals/by-hub-id/…`, `/by-handle/…`) carry `shareUrl`, a public peko's link on
  the website (null otherwise), so clients never build one origin from the other.
  `PUBLIC_ORIGIN` defaults to `https://api.pekohub.ai`. `DEPLOYMENT.md` describes the two
  hosts (and `pekohub.org` as a redirect) instead of the retired dual-hostname split.

- An OAuth 2.0 authorization server signs in Peko desktop and the Peko CLI (ADR-007).
  The desktop uses authorization code + PKCE with a loopback redirect
  (`GET /oauth/authorize` → the website's `/authorize` consent page → `POST /oauth/token`).
  The CLI uses the device grant (`POST /oauth/device/code`, approved on the website's
  `/device` page). Refresh tokens rotate and stay with the client they were issued to; the
  website's refresh cookie refuses them. `POST /oauth/revoke` signs an app out. Migration
  `0006_oauth_server` adds `oauth_authorization_codes`, `oauth_device_codes`, and
  `refresh_tokens.client_id`. Signing in on the website now returns to the page that asked.
- The website no longer offers chat. A peko's page (`/peko/:owner/:name`) is a profile with
  **Open in Peko** (`peko://add-peko?url=…`), which adds the peko in the desktop app; the
  desktop messages it over the user's own runtime. The ToS and quota fields left the owner
  dashboard, and the landing page drops the hard-coded "relay online" badge and the retired
  `peko push` / `peko pull` commands.
- The public chat proxy (`POST /v1/public/pekos/:owner/:name/chat`) stays, for clients with no
  runtime of their own. Anonymous visitor chat is off unless `ALLOW_VISITOR_CHAT=true`: without
  it, a caller with no `Authorization` header gets 401 `sign_in_required`, and the profile
  endpoint sets no visitor cookie.
- Pekos reach the discovery index again: indexing named no primary key, and Meilisearch can't
  infer one from `id` next to `ownerId`, so every peko document was rejected and the directory
  stayed empty. `indexInstance` now names `id`.
- The directory lookups (`/v1/principals/by-hub-id/:hubId`, `/by-handle/...`) answer with
  `ownerHandle`, the owning account's handle: with `name`, a peko's share path
  `/peko/<ownerHandle>/<name>`. The desktop builds an owner's share link from it.
- A peko's avatar (an emoji or short monogram) arrives on its runtime's `instance_announce`.
  The hub keeps it in `instances.avatar` (migration `0005_peko_avatar`) and serves it on the
  public peko record, `/v1/me/accessible-pekos`, and discovery hits (read from the row, so a
  change shows at once). The web profile header and directory cards show it. An announce
  without the field (older runtimes) leaves it unchanged; `null`, or anything that isn't a
  short emoji or monogram, clears it.
- A chat the runtime refuses (a `proxied_response` with status ≥ 400 before any reply
  text) ends the stream with an `event: error` frame carrying the reason, instead of
  writing the refusal as the peko's reply. `PUBLIC_ORIGIN` is documented in
  `backend/.env.example`: it is the bridge-token issuer and must match the hub a
  runtime registered with (`http://localhost:3000` locally).
- Hub records an online principal's owner (ADR-081 §5): announces never change it (a
  differing announce is refused and the runtime is sent `principal_owner_changed`);
  registering under another account needs that account's approval; only the recorded
  owner transfers it, via `POST /v1/principals/by-hub-id/:hubId/transfer` or the
  `principal_transfer` tunnel message from a runtime whose account is the owner.
- One online copy per principal (ADR-081): a principal's Hub ID links to exactly one
  runtime; moving it needs the owner account's approval (implicit for the runtime's
  own account, else `POST /v1/principals/by-hub-id/:hubId/move`), and the old runtime
  receives `principal_unlinked`. Channel events and invites from a registered
  principal are relayed only from its linked runtime.
- One live tunnel per runtime: a newcomer is considered only after proving its key
  and never displaces a live connection; stale ones are replaced.
- `DELETE /v1/runtimes/:did` lets the owning account unregister a runtime.
- Assign stable Hub principal UUIDs separately from deployment instance UUIDs and
  runtime-local actor IDs. Correlate explicit registration receipts, verify signing
  proof, and reject immutable-key reassignment.
- Replace DID directory routes and publication states with Hub-ID lookup and
  local-only / registered private / registered public semantics. Expose both IDs in
  resolution and public profiles; reject ambiguous handles and unregistered exposure.
- Keep account and visitor webchat identities distinct, refresh account credentials
  consistently, and verify registered principal directory proofs.
- Align channel invites and member profiles with the runtime's dual identity and
  channel-only conversation contract (ADR-073).
