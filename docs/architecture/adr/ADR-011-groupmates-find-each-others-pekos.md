# ADR-011: People in a group together find each other's pekos by handle; a peko asks to join a group for itself

Date: 2026-11-07
Status: Accepted
Amends: ADR-010 D1
Related: peko-runtime ADR-098 (pekos find, join, and reach each other), ADR-092 (groups, invite links, join requests), ADR-081 D7 (the online link)

## Context

The core use case is two people, each with a peko, working on one repository. On
2026-11-06 it worked only after the people dug Hub UUIDs out of their apps: Gina told
her peko "coordinate with Frank's peko ada", and nothing could turn `@frank/ada` into
an address.

- ADR-010 D1 made a private peko's handle resolve only for its owner, because handles
  are guessable and the wide rule was an enumeration oracle.
- Only a person could ask a group's home to join: `handleGroupJoin` relayed
  `tunnel_group_join_request` only for a `user:hub:` source. A peko had no way to join a
  group by its invite link, and running `peko channel join` in its shell joined its owner.

## Decision

### D1. A private peko's handle also resolves for people in a group with its owner

By handle, a registered private peko resolves for:

- its owner, and the owner's own pekos (ADR-010 D1, unchanged);
- **any account that shares a registered group with the owner** (`hub_group_members`),
  and that account's registered pekos (`PekoPrincipal` proof; the peko's owner is the
  account checked).

Everyone else still gets 404. By Hub ID nothing changes (ADR-010 D2).

The answer carries `ownerHandle`, which the runtime checks against the handle it asked
for (runtime ADR-098 D1).

What this exposes: people in a registered group together can learn the names, routes,
and online status of each other's private pekos by guessing a name. They chose the
group, and the Hub already knows they share it (ADR-092 D6). The Hub learns nothing it
did not hold. Unregistered groups grant nothing, since the Hub does not know of them.

### D2. A peko asks to join a group for itself

`tunnel_group_join_request` may come from a peko: `sourcePrincipalDid` is its signing DID
(`did:key:…`) and the new `sourceHubId` is its Hub ID. The Hub relays it only when:

- `sourceHubId` names a registered peko whose signing DID is `sourcePrincipalDid`;
- the peko's online link points at the sending runtime (ADR-081 D7).

A person's request (`user:hub:<account>`, from a runtime registered to that account) is
unchanged. `tunnel_group_join` (answering an invitation) stays person-only. The home runtime
checks the request end to end: it resolves the Hub ID, compares the key and runtime, and
checks the invite link (runtime ADR-098 D2).

## Consequences

- `instanceService.mayResolvePrivate` gains one join over `hub_group_members` for
  by-handle misses. `tunnel-manager.ts` gains `pekoAsksForItself`.
- Tests: `addressing.test.ts` (groupmates, their pekos, an outsider, anonymous);
  `channel_event_forwarding.test.ts` (a peko's request from its own runtime only, with
  its own Hub ID).
- Rejected: resolving a private peko's handle for anyone who shares a DM with its
  owner. The Hub keeps no DMs (runtime ADR-095 D5), and should not start.
