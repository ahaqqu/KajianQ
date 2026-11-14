import {
  type ChatTraceModel,
  type Trace,
  type TraceProviderCall,
  traceProviderCalls,
} from "@app/contracts";
import { CITATION_SUPPORT_PURPOSE, EMBED_PURPOSE } from "@app/kajianq-domain";
import { RERANK_PURPOSE } from "@app/rag-core";

/**
 * The models that served an answer, in first-call order, each with the short
 * roles its calls served. One entry per model, roles deduplicated, so a model
 * that served two stages stays one row; the panel localizes the roles it knows
 * and shows any other verbatim.
 */
export function traceModelsOf(trace: Trace): ChatTraceModel[] {
  const models: ChatTraceModel[] = [];
  for (const call of traceProviderCalls(trace)) {
    const role = traceCallRole(call);
    const model = models.find((entry) => entry.id === call.modelId);
    if (model === undefined) {
      models.push({ id: call.modelId, roles: [role] });
    } else if (!model.roles.includes(role)) {
      model.roles.push(role);
    }
  }
  return models;
}

/** The role a recorded call served, from its stage and the purpose label its
 * producer records: the retriever's embed and rerank calls share a stage, and
 * the reviewer's citation screen shares the reviewer stage with the LLM review.
 * A stage this map does not name keeps its own name rather than an invented
 * label. */
function traceCallRole(call: TraceProviderCall): string {
  if (call.stage === "retriever" && call.purpose === EMBED_PURPOSE) return "embedding";
  if (call.stage === "retriever" && call.purpose === RERANK_PURPOSE) return "reranker";
  if (call.stage === "reviewer" && call.purpose === CITATION_SUPPORT_PURPOSE)
    return "citation_check";
  return call.stage;
}
