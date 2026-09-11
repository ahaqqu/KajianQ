import { Effect } from "effect";
import { loadProviderConfig, resolveRole, parseCandidateKey } from "@app/infra";
import * as evalpkg from "@app/eval";

const { retryInMs } = evalpkg;

/**
 * Candidate wiring for the embedding-benchmark CLI (#9): each
 * `embedder-candidates` chain entry is resolved into its own
 * single-candidate config so every model is measured alone — never behind a
 * fallback chain that could silently substitute another model. Runs through
 * the Provider seam (ADR-0022); vendor names live only in models.json.
 *
 * Thermo A3: the env record is injected by the composition root (the CLI's
 * `process.env`) — this module never reaches for the ambient `process`,
 * matching the binder discipline `loadEmbedBenchConfig` follows; the key
 * itself is read only inside `resolveRole`.
 */
export function loadCandidates(config, env) {
  return config.roles["embedder-candidates"].chain.map((key) => {
    const [vendor, modelId] = parseCandidateKey(key);
    const vendorConfig = config.vendors[vendor];
    const apiKeyEnv = vendorConfig.apiKeyEnv;
    const apiKey = env[apiKeyEnv];
    if (!apiKey) {
      throw new Error(`embed-bench: missing ${apiKeyEnv} for ${modelId}`);
    }
    const singleConfig = {
      vendors: { [vendor]: vendorConfig },
      roles: { embedder: { chain: [key] } },
    };
    const { provider } = resolveRole(singleConfig, "embedder", {
      env: { [apiKeyEnv]: apiKey },
    });
    return { modelId, provider };
  });
}

/** Sleep for ms (batch pacing between vendor calls). */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Embed all texts in batches through a Provider, surfacing per-call costs.
 * The free tier's embed-content quota counts ITEMS per minute (not requests),
 * so pacing is item-aware: the delay between batches targets ~800 items/min
 * (`batchDelayMs` overrides), and a rate-limit failure backs off — preferring
 * the vendor's own "retry in Ns" hint (`retryInMs` from the engine module),
 * else a 30s doubling (up to 8 waits).
 */
export async function embedAll(
  provider,
  texts,
  { batchSize, dimensions, onCost, batchDelayMs, log },
) {
  const delay = batchDelayMs ?? Math.max(1_000, Math.round((batchSize / 800) * 60_000));
  const vectors = new Array(texts.length);
  let rateLimitStalls = 0;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    let result;
    for (;;) {
      try {
        result = await Effect.runPromise(
          provider.embed({
            texts: batch,
            ...(dimensions != null ? { dimensions } : {}),
          }),
        );
        break;
      } catch (err) {
        const message = String(err?.message ?? err);
        const rateLimited = message.includes("429") || message.includes("quota");
        if (!rateLimited || rateLimitStalls >= 8) {
          throw new Error(
            `embed-bench: ${provider.modelId} embeddings failed: ${message.slice(0, 300)}`,
          );
        }
        const hinted = retryInMs(message);
        const waitMs = hinted ?? 30_000 * 2 ** rateLimitStalls;
        rateLimitStalls += 1;
        log?.warn("rate limited — backing off", {
          modelId: provider.modelId,
          backoffMs: waitMs,
          stall: rateLimitStalls,
          maxStalls: 8,
        });
        await sleep(waitMs);
      }
    }
    rateLimitStalls = 0;
    if (result.vectors.length !== batch.length) {
      throw new Error(
        `embed-bench: ${provider.modelId} returned ${result.vectors.length} vectors for ${batch.length} texts`,
      );
    }
    for (let j = 0; j < batch.length; j += 1) vectors[i + j] = [...result.vectors[j]];
    if (onCost) onCost(result.cost);
    if (i + batchSize < texts.length && delay > 0) await sleep(delay);
  }
  return vectors;
}

/**
 * The expansion micro-task runner (ADR-0014): for each case, ask the cheap
 * router LLM to pick Arabic expansion terms from the glossary slice, parse
 * the selection, and score against the expected term. Every call's cost
 * lands in the caller's sink (traceability rule 2 — no untraced LLM call).
 *
 * Thermo A1: the system prompt and user-prompt shaping arrive as opaque
 * strings from the domain pack (`EXPANSION_SYSTEM_PROMPT` /
 * `expansionUserPrompt`) — this engine-side runner names no language and no
 * domain. Thermo C2: a selection that picks any distractor term fails the
 * case even when the expected term is also present.
 */
export async function runExpansionCases({
  evalpkg: ep,
  provider,
  cases,
  budget,
  onCost,
  systemPrompt,
  userPrompt,
  log,
}) {
  const results = [];
  for (const c of cases) {
    if (budget.wouldExceed()) {
      log?.warn("budget cap hit — expansion task aborted");
      break;
    }
    const reply = await Effect.runPromise(
      provider.generate({
        turns: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt(c.query, c.slice) },
        ],
      }),
    );
    onCost(reply.cost);
    const picked = ep.parseExpansionSelection(reply.text);
    results.push({
      caseId: c.id,
      correct: ep.scoreExpansionCase(
        { picked, parseError: picked.length === 0 ? "empty selection" : undefined },
        c.expectedTerm,
        c.distractors,
      ),
      picked,
      expectedTerm: c.expectedTerm,
    });
  }
  return results;
}

/**
 * The benchmark loop: embed the doc corpus (both tracks) per candidate, then
 * score all directions. Probes are self-retrieval: a probe's query vector is
 * the doc's own track vector (already computed above), so no second embedding
 * pass is needed — this measures the pure alignment of the embedding space
 * and halves the item spend. Returns one result per candidate; `onCell`
 * receives each scored cell for live progress output.
 */
export async function runCandidates({
  evalpkg: ep,
  candidates,
  allDocs,
  probes,
  batchSize = 96,
  onCost,
  onCell,
  log,
}) {
  const vectorByDocIdPrimary = new Map();
  const vectorByDocIdSecondary = new Map();
  const results = [];
  for (const { modelId, provider } of candidates) {
    const startedAt = Date.now();
    log.info("embedding with candidate", { modelId });
    const docPrimaryVecs = await embedAll(
      provider,
      allDocs.map((d) => d.textAr),
      {
        batchSize,
        onCost,
        log,
      },
    );
    const docSecondaryVecs = await embedAll(
      provider,
      allDocs.map((d) => d.textId ?? ""),
      {
        batchSize,
        onCost,
        log,
      },
    );
    vectorByDocIdPrimary.clear();
    vectorByDocIdSecondary.clear();
    for (let i = 0; i < allDocs.length; i += 1) {
      vectorByDocIdPrimary.set(allDocs[i].id, docPrimaryVecs[i]);
      vectorByDocIdSecondary.set(allDocs[i].id, docSecondaryVecs[i]);
    }
    const docVectorsPrimary = allDocs.map((_, i) => ({
      id: allDocs[i].id,
      vector: docPrimaryVecs[i],
    }));
    const docVectorsSecondary = allDocs.map((_, i) => ({
      id: allDocs[i].id,
      vector: docSecondaryVecs[i],
    }));

    // Self-retrieval probes: reuse the doc's track vector as the query.
    const probeQueries = (list, vectorById) =>
      list
        .map((q) => {
          const docId = q.relevantIds[0];
          const vector = vectorById.get(docId);
          return vector ? { query: q, vector } : null;
        })
        .filter((x) => x !== null);

    const cells = [];
    cells.push(
      ep.scoreDirection(
        "secondary→primary",
        probeQueries(probes.crossLingual, vectorByDocIdSecondary),
        docVectorsPrimary,
      ),
    );
    cells.push(
      ep.scoreDirection(
        "primary→primary",
        probeQueries(probes.monolingual, vectorByDocIdPrimary),
        docVectorsPrimary,
      ),
    );
    cells.push(
      ep.scoreDirection(
        "secondary→secondary",
        probeQueries(probes.idFallback, vectorByDocIdSecondary),
        docVectorsSecondary,
      ),
    );
    for (const cell of cells) onCell(modelId, cell);

    const result = { modelId, cells, costMicroUsd: 0, elapsedMs: Date.now() - startedAt };
    result.gate = ep.evaluateGate({ cells });
    results.push(result);
  }
  return results;
}
