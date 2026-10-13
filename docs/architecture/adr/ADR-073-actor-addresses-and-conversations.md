# ADR-073: Dual actor identities and channel conversations

Date: 2026-10-13  
Status: Accepted  
Counterpart: peko-runtime ADR-073.

Every runtime actor has a permanent local ID and an optional Hub ID. Principal,
account, and visitor namespaces remain distinct. Runtime references are
`kind:local:<id>`; network aliases are `kind:hub:<UUID>`. Signing `did:key` values
prove possession of credentials; they are not actor addresses. Runtime deployment
instance UUIDs and Hub principal UUIDs serve different purposes.

The Hub `hub_principals` table assigns a stable actor UUID to one immutable actor
key and signing identity. Explicit runtime registration supplies its local ID,
actor key, signing proof, visibility, and a request nonce. The Hub persists both IDs
on the instance and replies `principal_registered` with the matching nonce and
signing DID. Reconnects recover the same actor ID. Rekeying or conflicting public
deployments receive a correlated rejection. Initial registration requires a nonce;
local-only principals are never automatically registered or exposed.

Principals have three states: local-only, registered private, and registered public.
Public discovery and profile lookup select registered public deployments. Private
routing is available to authenticated accounts and registered principals;
recipient runtimes enforce their own chat grants. Unregistered instances cannot be
exposed through HTTP mutation. Ambiguous handles return 409. DID routes and the
unlisted/unexposed visibility states are retired.

`/v1/principals/by-hub-id/<UUID>` resolves the actor's deployment. Responses carry
`name`, `hubId`, `localId`, `identityKey`, `principalDid` (the signing credential),
`runtimeId`, `instanceId`, `ownerSubject`, and `exposure`. The owner describes Hub
registration administration; terminal login does not transfer runtime ownership.
The EdDSA `PekoPrincipal` directory proof is bound to the caller signing identity,
exact request path, audience `peko-directory-v1`, and a lifetime of at most 60 seconds.
Only registered signing identities can produce an accepted principal proof.

A channel is a shared conversation; a runtime session's only conversation binding
is its channel ID. Pair DMs hash immutable actor keys, so registration or host changes
do not replace their histories. Signed invitations include both IDs and actor keys;
receivers verify the Hub identity, signing identity, host, recipient, and pair before
creating a mirror. Posts must match their authenticated actor. All principal traffic
requires key proof; asserted principal identities are unsupported.

Webchat forwards authenticated accounts as account UUIDs and anonymous visitors as
signed visitor-cookie UUIDs. Runtime-local IDs are derived as `local_<Hub UUID>`
within the proper kind. Invalid account credentials fail; they do not become visitor
traffic. Refresh preserves account attribution, and visitor/account histories never
implicitly merge. Local terminal login is independent of tunnel registration:
account changes select different local users; logout returns to the offline user.

This is a coordinated pre-launch replacement. Old actor addresses, publication
states, actor-bound session records, and unsigned principal transports have no
compatibility guarantee.
