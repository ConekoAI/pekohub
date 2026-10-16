# ADR-081: One online copy per principal

Date: 2026-10-15 (Hub-recorded owner: 2026-10-16)
Status: Accepted
Counterpart: peko-runtime ADR-081 (actor identity, ownership, and a single online copy)
Refines: ADR-073 (dual actor identities)

## Context

A principal can be copied to many runtimes; every copy holds the same
signing key and immutable actor key. Hub previously let several runtimes
deploy one Hub principal (only duplicate *public* deployments were
rejected), and a new tunnel connection displaced the live one before the
newcomer had proven its key — so a copied runtime directory, or a replayed
hello, could knock the original offline.

## Decision

1. **Runtime registration proves the runtime key** (unchanged, now the only
   path) and binds the runtime to one account. That account is the
   runtime's local user (runtime ADR-081 D3). `DELETE /v1/runtimes/:did`
   lets the owning account unregister a runtime: its instances leave the
   directory and its tunnel closes.
2. **One live tunnel per runtime.** A connection is considered only after it
   has signed the challenge, and it never displaces a connection heard from
   within the last two heartbeat intervals; such a newcomer is refused. A
   stale connection is replaced, so a restarted runtime reconnects within
   about a minute.
3. **A principal's Hub ID is linked to exactly one runtime**
   (`instances_hub_id_unique`). Registering a principal already linked
   elsewhere is a move. It needs an explicit registration request and the
   approval of the principal's owner account — implicit when that account
   also owns the requesting runtime, otherwise given through
   `POST /v1/principals/by-hub-id/:hubId/move { runtimeId }` (one use,
   one hour). Hub then removes the old instance and sends the old runtime
   `principal_unlinked`; a stale copy that re-announces later receives
   `principal_unlinked` instead of being re-linked. Key possession cannot
   decide a move: every copy holds the key.
4. **Principal traffic is relayed only from the linked runtime.** A channel
   event or invite whose `sourcePrincipalDid` is a registered principal is
   dropped unless its link points at the sending runtime.
5. **Hub's record is an online principal's owner.** `ownerSubject` is a Hub
   user; the registration administrator is the runtime's account.
   - **Announces never change it.** A runtime must announce the recorded
     owner. An announce naming another is refused, and the linked runtime
     is sent `principal_owner_changed` with the recorded owner, which it
     writes into its config before re-announcing. A local edit of the
     owner is therefore undone the next time the principal goes online.
   - **First registration needs the owner's consent.** A principal never
     online may register under the runtime's own account. Naming another
     account as owner needs that account's approval through the same
     `POST /v1/principals/by-hub-id/:hubId/move { runtimeId }`; for a
     principal never online, any account may approve, and the approval
     admits only a registration naming the approver as owner.
   - **Only the recorded owner transfers it**, to an existing Hub user:
     through `POST /v1/principals/by-hub-id/:hubId/transfer { ownerId }`,
     or over the tunnel (`principal_transfer`) when the linked runtime's
     account is the recorded owner. Hub writes the new owner, withdraws
     pending link approvals, audits `principal.owner_transfer`, and sends
     the linked runtime `principal_owner_changed`; a refused tunnel request
     gets `principal_transfer_rejected`.
6. Retired: replace-on-reconnect, and the terminal-login `local_<UUID>`
   derivation described in ADR-073 (the runtime no longer has a separate
   terminal login).

## Migration

`0004_single_online_copy` keeps the most recently seen instance per Hub ID,
adds the unique index, and creates `principal_move_approvals`. Pre-launch:
no compatibility path for older runtimes.
