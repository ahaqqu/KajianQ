# ADR-0017: Anonymous sessions in owned tables behind the store seam, not a hosted identity provider

## Decision

v1 has no user accounts, no login, no OAuth and no email or password: a visitor's browser receives an anonymous Bearer session, and that is the whole identity model. Users and sessions are first-class product tables behind the `RagStore` seam — minted, resolved and cascaded only through the adapter — and no hosted identity provider is adopted.

Expiry is enforced on read, and the reclamation of expired sessions is a scheduled job that removes the expired rows and the users they leave without a session; it logs its outcome and never throws, because a scheduled run has no client to fail to. The erasure endpoint cascades the user's whole subtree.

## Why

A hosted identity product solves "who are you" — accounts, OAuth, passwords — while this product needs only "give this browser a token so feedback and rate limits persist", so adopting one adds material machinery for a problem v1 does not have. Its own API reads and writes its schema outside the persistence seam, which is a second persistence path and a seam violation: using it faithfully breaks the rule, and using only its schema through the adapter defeats its point. It couples auth to one vendor, while owned tables travel with the schema when the store changes. And it bills per active user — a cost axis for tokens that are otherwise free to mint.

Rejected: a vendor's hosted identity product; an identity SDK in the engine or the app.

## Consequences

- The session store is a set of tables the schema owns, so changing it is an adapter change rather than an application change.
- Expiry is a storage-reclamation concern rather than a correctness one: a read path rejects an expired row whether or not the reclamation has run.
- No vendor identity SDK enters the engine or the app; the boundary gate already forbids vendor coupling there.
- **Revisit when** real user identity arrives — saved reading lists, cross-device history or paid tiers make a hosted identity product genuinely useful, and migrating anonymous sessions to named ones becomes its own decision with cost, seam and lock-in trade-offs.
