# ADR-0065: Host configuration lives in one protected repository applied by a root applier, and a merge is the deploy

## Decision

1. **One repository holds every host configuration file.** A directory per project, plus one for the files projects share. Each directory's manifest is the complete list of what that project installs: destination, ownership, mode, how placeholders render and which validator gates it. A project's review route is its code ownership; only the shared directory may write a path that does not carry a project's own name.
2. **A root-owned applier on the box is the only writer.** On a timer it fetches the protected branch, refuses anything that is not on it, renders placeholders from root-only environment files, validates every candidate before touching an installed file, applies the set as one recorded transaction, and restores the previous bytes when any step fails.
3. **A merge is the deploy.** After the one-time bootstrap, no human privileged step exists between an approved change and the live host, and no second path writes the same files.
4. **Secrets, hostnames, certificate paths and keys never enter the repository.** Only placeholders and example templates are committed; real values live in root-only files on the box.
5. **The security boundary is the protected branch plus code ownership,** because merge rights to the repository equal control of the box's web tier. The applier refuses a commit from an unprotected branch, a dirty checkout and an unmerged local commit; review is what keeps a malicious merge out, and the boundary is only as strong as the hosting plan's protection feature.
6. **Blast radius is the whole host.** One merged change can rewrite any managed file, including the privilege grants and the units that run as root. Validation and rollback bound mistakes; they do not bound intent. That trade is accepted because the alternative is a privileged manual edit on every change.
7. **Migration is ordered, and the old path is frozen rather than forked.** Reverse-proxy sites move first, then units and schedules, then rotation, database posture and privilege grants. Until the applier is bootstrapped and owns the files, the serving repository's provisioning path stays in place as the deploy's comparison baseline; the switchover retires its install path and repoints the baseline, so the two never write at once.

## Why

Configuration for one host is split across several project repositories, ad-hoc files and root-only environment files, so every change is a privileged manual step and a merged change can sit inert while the deploy still reports healthy. The alternatives are worse: per-project repositories with per-project appliers multiply the root path that must be trusted; a CI job holding a write key on the box makes every workflow run a deployment credential; and an automatic applier behind an unprotected branch turns one careless push into a host-wide change. One reviewed repository, one root applier and one protected branch keep the trust decision in review and the mechanism out of human hands.

## Consequences

- The applier's journal and recorded previous state are the rollback evidence: a failed transaction restores the prior bytes and records its status, and an interrupted one is recovered before the next pass.
- Validation is a precondition, not a post-check: a candidate set is rejected whole, so one validator's failure leaves no part of the change on disk.
- Only paths a manifest declares are owned by the repository. Account creation, deployed application trees, secrets and the application deploy stay with the serving project until a later decision moves them.
- The timer interval, not the merge, sets how quickly a change reaches the box; a converged box is a no-op pass that restarts nothing.
- **Revisit when** a second writer needs access (branch protection must be active first), a second host is added (one applier per host, or a shared-roots decision), a project needs a path outside its namespace (a shared-file decision, not a manifest edit), or the merging account itself becomes the threat the applier must survive.
