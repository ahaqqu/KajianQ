# ADR-0021: The pipeline runner owns the run's scope, config and trace assembly

## Decision

1. **Typed dispatch.** One runner walks the stages (Router → Retriever → Assembler → Generator → Reviewer), emits the deterministic stage-boundary trace events from stage results, and validates and assembles the final trace in one place. Stages append the events the runner cannot observe — LLM calls, refusals, reviews — through the run's sink.
2. **Per-run config isolation.** A run config carrying opaque per-stage model ids and filters — no vendor names — reaches every stage through one run context.
3. **Lifecycle and disposal.** Stages dispose through the run's scope, torn down last-in-first-out on completion and on failure.
4. **The run owns the answer.** The generator and the reviewer return a draft; the runner owns the final answer and the trace that explains it.

## Why

The two design principles — pluggable by configuration and traceable by design — resemble a service-graph meta-framework closely enough that the resemblance had to be answered. The framework composes an agent harness; this composes a RAG pipeline. Its introspection describes live wiring, not the persisted per-answer trace the product requires, and its string-keyed services would weaken the compile-time boundary the seams rest on. One consumer exists, so a full runtime is a platform cost paid before it is earned.

A single collection point is also what makes an untraced call a defect rather than an omission: cost, tokens and latency are recorded where the call happens, and no stage assembles its own trace.

Rejected: adopting cordis now; leaving the trace assembled by each caller.

## Consequences

- Pipeline wiring goes through the runner; a hand-assembled trace or ad-hoc stage wiring is a defect.
- Cost recording rides the run's sink, so an untraced LLM call is a gap the types make visible.
- The stage signatures carry a run context and the generator returns a draft, per ADR-0018.
- **Revisit when** a second consumer appears and the stage and provider surface outgrows a config map, or live wiring introspection is needed beyond persisted traces.
