# PekoHub changelog

## 0.1.0 — pre-launch

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
