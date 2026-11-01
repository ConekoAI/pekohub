# PekoHub changelog

## 0.1.0 — pre-launch

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
<<<<<<< HEAD
=======

>>>>>>> origin/master
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
