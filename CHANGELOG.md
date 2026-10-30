# PekoHub changelog

## 0.1.0 — pre-launch

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
