// Shared fixtures for the docs:links gate suite (#368, #391, #392).
//
// The unit cases build a synthetic tree and never touch the filesystem; the
// real-tree and CLI cases live in `check-markdown-links-tree.test.mjs`, which
// imports the CLI paths from here too.
import { resolve } from "node:path";
import { ROOT, adjudicate, analyse, makeTree } from "../../scripts/check-markdown-links.mjs";

const SCRIPT = resolve(ROOT, "scripts/check-markdown-links.mjs");
export const CLI = SCRIPT;

export { SCRIPT };
export const FAKE_ROOT = "/repo";

/**
 * Every unit case builds a synthetic tree and never touches the filesystem —
 * the classifier, the resolver and the adjudicator are the contract, and the
 * real-tree and CLI cases in `check-markdown-links-tree.test.mjs` prove the
 * wiring end to end.
 */
export function ctxOf({ paths = [], adr = [], skills = [], root = FAKE_ROOT } = {}) {
  return { root, tree: makeTree(paths), adrNames: adr, skillDirs: new Set(skills) };
}

export function scan(text, options = {}) {
  const { relPath = "docs/living.md", allowlist = [], ignored, files, ...treeOptions } = options;
  const ctx = ctxOf(treeOptions);
  const findings = analyse([{ relPath, text }], ctx);
  return adjudicate(findings, { allowlist, ignored, files });
}

export function targets(result) {
  return result.violations.map((v) => v.target);
}
