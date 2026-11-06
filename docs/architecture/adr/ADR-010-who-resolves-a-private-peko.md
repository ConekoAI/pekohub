# ADR-010: Who resolves a private peko

Date: 2026-11-06
Status: D1–D2 Accepted; D3 Proposed (needs peko-runtime and peko-desktop)
Related: ADR-073 (actor addresses), ADR-081 (one online copy), peko-runtime
ADR-090/091/092/095 (cross-runtime DMs, groups, people's DMs)

## Context

`GET /v1/principals/by-hub-id/:hubId` and `GET /v1/principals/by-handle/:owner/:name`
answer with where a peko runs and who it is: `name`, `hubId`, `localId`, `identityKey`,
`principalDid`, `runtimeId`, `instanceId`, `ownerSubject`, `ownerHandle`, `exposure`,
and (after pekohub#77's follow-up) `status`, `avatar`, `description`.

Since ADR-073 (#43, 2026-10-13), a registered private peko resolved for its owner **and
for any signed-in account or registered peko**, by either path. ADR-073 chose this on
purpose: "Private routing is available to authenticated accounts and registered
principals; recipient runtimes enforce their own chat grants." The Hub is a directory,
not an ACL (hub H4 / runtime R4): chat grants and contacts live on the peko's runtime.
The Hub keeps no DMs and no peko members of groups (`hub_groups` /
`hub_group_members` list accounts only).

Who calls these endpoints for a peko they don't own:

| Caller | Path | Why it needs a private hit |
|---|---|---|
| runtime `Contacts.resolve principal:hub:<id>` (`tools/builtin/channel/contacts.rs`) | by Hub ID, as the peko | first contact: learn a peko its owner was told about |
| runtime `ChannelSend principal:hub:<id>` (`channel_send.rs`) | by Hub ID, as the peko | first DM to it |
| runtime group invite / creator check (`tunnel_channel_port.rs`, `daemon/state.rs`) | by Hub ID, as the peko | verify an inviter or invitee it may never have met |
| runtime person DM (`tunnel/user_dm.rs`) | by Hub ID, as the person | a person opens a DM with someone else's peko (ADR-095) |
| desktop `remote_principal_adopt_dms` (`commands/remote_principal.rs`) | by Hub ID, as the person | list the pekos the person has DMs with (D5), incl. contacts' private ones |
| — | by handle | **no caller** — the runtime only resolves its own pekos by handle, locally (`LocalFirstAgentDirectory`, empty owner) |

For every Hub-ID caller, the Hub sees no tie between caller and peko: the grant that makes
the call legitimate is on the target's runtime. So the Hub can't tell a contact from a
stranger by Hub ID. By handle it doesn't have to: nobody but the owner looks a private
peko up that way. And handles are guessable (`@alice/ada`, `@alice/helper`), so the wide
rule made by-handle an enumeration oracle for private pekos — existence, runtime,
identity key and now liveness — for anyone with an account. A Hub ID is a random UUID
learned only from the owner, a shared channel's roster, or a DM.

## Decision

### D1. A private peko's handle is its owner's alone

By handle, a registered private peko resolves only for its owner: the person
(`Bearer` token of the owner account), or one of the owner's own registered pekos
(`PekoPrincipal` proof from a peko whose Hub record has the same owner — a peko on the
person's other computer). Anyone else, signed in or not, gets **404**, not 403: a 403
would confirm the peko exists. Public pekos resolve by handle for anyone, as before.

### D2. A private peko's Hub ID stays its address

By Hub ID, a registered private peko resolves for its owner, its owner's pekos, any
other signed-in account, and any registered peko. Anonymous callers get 403. This is
ADR-073 unchanged: the Hub ID is what an owner hands out so others can reach the peko,
and the peko's runtime refuses anyone it hasn't granted. Narrowing it without the
runtime would break first contact, group invitations, people's DMs and the desktop's
DM list.

The cost is what a Hub-ID holder learns beyond routing: the name, owner handle, local
id, runtime id and — since #77's follow-up — whether it's online and its face. D3 is how
to stop that.

### D3 (proposed). Strangers get only what a first message needs

Split the by-Hub-ID answer:

- **Route** — `hubId`, `identityKey`, `principalDid`, `exposure`: enough to sign a first
  DM invitation to it and verify its replies. Anyone signed in.
- **Profile** — `name`, `ownerHandle`, `ownerSubject`, `localId`, `runtimeId`,
  `instanceId`, `status`, `avatar`, `description`. Owner and owner's pekos only.

That needs three changes outside the Hub:

1. **Runtime: address cross-runtime traffic by Hub ID, not runtime id.** The Hub already
   maps a Hub ID to its one online runtime (ADR-081). Today runtimes put
   `recipientRuntimeId` from the directory into tunnel envelopes and cache it
   (`tunnel_channel_port.rs` link cache). With Hub routing by Hub ID, the sender needs no
   runtime id, and a stranger stops learning which runtime (and so which person's
   computer set) hosts the peko.
2. **Runtime: carry the peer's profile in the conversation.** A DM invitation's
   acceptance and the peko's posts carry its signed name/avatar/description; the runtime
   keeps the latest per peer and returns it with `channel_peko_dms` (and `Contacts`).
   Liveness comes from the conversation (last post, delivery receipts), not the Hub.
3. **Desktop: read DM peers from the runtime.** `remote_principal_adopt_dms` and the
   contact rows take name/avatar/status from the runtime's DM list instead of
   `by-hub-id`; they keep calling the Hub only for the owner's own pekos on other
   computers (`/v1/me/accessible-pekos`).

Once all three ship, the Hub drops the profile fields for non-owners (one branch in
`resolvePrincipalTarget`).

Rejected:

- **The Hub stores grants or contacts** (runtimes announce, per private peko, who may
  resolve it). It moves the ACL to the Hub and hands the Hub each person's social graph,
  against H4/R4.
- **The Hub asks the peko's runtime on each lookup.** An offline runtime would refuse
  everyone, a first message to an offline peko (durable delivery, runtime ADR-072)
  could not even be addressed, and the round trip itself tells the caller whether the
  peko is online.

## Consequences

- D1 needs no runtime or desktop change: neither resolves someone else's private peko by
  handle. The runtime maps a 404 to `DirectoryError::NotFound`; the desktop treats 403
  and 404 alike.
- Tests: `tests/integration/addressing.test.ts` ("a private peko's handle resolves only
  for its owner; its Hub ID for anyone signed in") and
  `tests/integration/principal_directory.test.ts` cover owner, owner's peko, other
  account, other account's peko, and anonymous on both paths.
- Until D3, adding fields to the by-Hub-ID answer widens what any Hub-ID holder learns;
  new fields should be Route-or-Profile classified when added.
