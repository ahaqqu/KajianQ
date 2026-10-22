# ADR-0059: The chat provider is a named profile, with Ollama Cloud admitted for personal data on its retention terms and DeepSeek retained as the rollback

## Decision

The provider config carries **named profiles**, and one deployment value selects the set of role chains a process wires. The `default` profile is the checked-in chain set, and the absence of the value is the same set; a named profile overrides individual role chains. Profiles are configuration, not a code path: an unknown profile is a configuration failure at wiring time, never a fallback to the default.

**Ollama Cloud joins the allowlist as a paid chat vendor.** A profile re-heads the chat serving roles on it — the generator, the reviewer, the live reviewer and the cheap chain — while the embedder, the translation role and the decision vendor stay where they are. The profile's chains carry no candidate from the default vendor: a missing key fails with the typed missing-key error instead of silently answering from DeepSeek.

**Personal data may route through Ollama Cloud on its zero-retention, no-training terms; no signed processing agreement is on file.** That absence is the accepted basis, recorded by the owner, not an oversight: the register and the privacy notice state the terms and the missing agreement plainly rather than implying a DPA exists. This is the recorded exception to the register rule that personal data rides paid terms under a processing agreement.

**The switch is justified by capacity already paid for, not by unit price.** The owner holds an already-paid legacy Ollama subscription; routing chat through it stops the token spend from being incremental. At published pay-as-you-go rates the two vendors price the model identically, so this is not a cheaper-per-token decision — it is subscription-backed, sunk-cost capacity, and it would stop being the right choice if the subscription lapsed.

**DeepSeek remains the default and the rollback.** Removing the profile value restores the default chains exactly — no config edit, no migration and no revert.

## Why

A single edit to the served chains would make a switch a config diff and leave no record of which posture a deployment runs; a named profile makes the choice explicit in one value and keeps the default posture from drifting while the alternative is evaluated. A default-vendor tail is rejected for the same reason a fallback is rejected on a profile's chain: a missing key would resolve into a working-looking deployment on the wrong vendor, and the trace would no longer say which vendor answered.

The privacy basis is the trade the owner accepted: zero retention and no training are the properties that matter for a question that can reveal religious conviction, and they are contractual terms rather than an Art. 28 instrument. The register states the absence so a reader can judge it; a signed agreement would replace the basis, not be assumed.

Rejected: making Ollama Cloud the default — a profile is the switch, and the untouched default has to remain the rollback. Rejected: a per-switch edit to the model config, which leaves no named posture and no single value to remove.

## Consequences

- The default chains are unchanged, so the rollback is the absence of one value and needs no code, config or data change.
- Every call keeps its model identity on the trace, so a switched deployment is distinguishable from the default in persisted traces.
- The register and the notice carry the vendor's row, its permitted verdict and the no-DPA basis; a signed agreement rewrites that row's note, not this decision.
- The provider seam resolves every candidate from configuration as before; vendor identity stays in the config, not in engine code.
- The free-tier rule is unchanged: the switched chains still carry a non-personal tail, so the personal-data filter remains exercised on the switched path.
