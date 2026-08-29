#!/usr/bin/env bun
/**
 * provider-smoke.mjs — exercise every keyed vendor through the Provider
 * seam end to end and print cost per call (#5 AC).
 *
 *   bun run provider:smoke
 *
 * Vendors whose api-key env (GEMINI_API_KEY, DASHSCOPE_API_KEY,
 * DEEPSEEK_API_KEY, MOONSHOT_API_KEY) is absent are reported NOT RUN and do
 * NOT fail the script — CI stays green before the keys exist (#2); tracked
 * in #92. A keyed vendor that fails its call exits non-zero.
 *
 * Also drills the cheap-tier fallback chain (spec §3.4): the first cheap
 * candidate is forced to fail (fetch that returns 429) and the chain must
 * answer with the second candidate's model id.
 */
import { loadProviderConfig, resolveRole } from "../src/index";

const config = loadProviderConfig();

const SMOKED_ROLES = [
  { role: "generator", call: "generate" },
  { role: "translation", call: "generate" },
  { role: "cheap", call: "generate" },
  { role: "embedder", call: "embed" },
  { role: "reviewer", call: "generate" },
  { role: "reviewer-live", call: "generate" },
];

const PROMPT = {
  turns: [
    { role: "user", content: "Reply with the single word: ready" },
  ],
};

function microUsd(cost) {
  return `$${(cost.costMicroUsd / 1e6).toFixed(6)} USD`;
}

function row(name, status, detail) {
  const statusTag =
    status === "ok" ? "\x1b[32mOK\x1b[0m" : status === "not-run" ? "\x1b[33mNOT RUN\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(
    `  ${name.padEnd(34)} ${statusTag.padEnd(20)} ${detail ?? ""}`,
  );
}

let failures = 0;

console.log("provider-smoke: role drill through the Provider seam\n");

for (const { role, call } of SMOKED_ROLES) {
  const { provider, missingKeys } = resolveRole(config, role, {
    env: process.env,
  });
  if (missingKeys.length > 0) {
    row(`${role} (${call})`, "not-run", `missing ${missingKeys.join(", ")}`);
    continue;
  }
  try {
    let result;
    if (call === "embed") {
      result = await provider.embed({ texts: ["smoke test"], dimensions: 1536 });
      if (result.vectors.length !== 1 || result.vectors[0].length === 0) {
        throw new Error("embedding returned an empty vector");
      }
    } else {
      result = await provider.generate(PROMPT);
      if (!result.text || result.text.trim().length === 0) {
        throw new Error("generate returned empty text");
      }
    }
    row(
      `${role} (${call})`,
      "ok",
      `${result.cost.modelId}  in=${result.cost.tokensIn} out=${result.cost.tokensOut}  ${microUsd(result.cost)}  ${result.cost.latencyMs}ms`,
    );
  } catch (err) {
    failures += 1;
    row(`${role} (${call})`, "fail", String(err?.message ?? err));
  }
}

console.log("\nprovider-smoke: cheap-tier fallback drill (forced 429 on first candidate)\n");
const missingCheap = config.roles.cheap.chain
  .map((key) => config.vendors[key.slice(0, key.indexOf(":"))].apiKeyEnv)
  .filter((envName) => !process.env[envName]);
if (missingCheap.length > 0) {
  row("cheap fallback", "not-run", `missing ${missingCheap.join(", ")}`);
} else {
try {
  const failingFirst = async (url, init) => {
    const body = JSON.parse(init.body);
    // Fail only the first cheap candidate's model; the fallback answers.
    const first = config.roles.cheap.chain[0];
    if (body.model === first.slice(first.indexOf(":") + 1)) {
      return new Response(JSON.stringify({ error: { message: "forced 429" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }
    return fetch(url, init);
  };
  const { provider } = resolveRole(config, "cheap", {
    env: process.env,
    fetchImpl: failingFirst,
  });
  const result = await provider.generate(PROMPT);
  const chain = config.roles.cheap.chain;
  const firstModel = chain[0].slice(chain[0].indexOf(":") + 1);
  if (result.cost.modelId === firstModel) {
    throw new Error(
      `fallback did not trigger: answered by first candidate ${firstModel}`,
    );
  }
  row(
    "cheap fallback",
    "ok",
    `failed ${firstModel} → answered by ${result.cost.modelId}  ${microUsd(result.cost)}`,
  );
} catch (err) {
  failures += 1;
  row("cheap fallback", "fail", String(err?.message ?? err));
}
}

if (failures > 0) {
  console.error(`\nprovider-smoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\nprovider-smoke: all keyed vendors green");