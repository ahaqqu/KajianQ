/**
 * Where the study's artifacts go and how they land.
 *
 * The directory is a cache, never the repository and never object storage: the study
 * is re-runnable and its output is evidence, so it is written where an operator can read
 * it and a checkout can never carry a corpus artifact by accident.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The default artifact directory, under the per-user cache. */
export const DEFAULT_ARTIFACT_DIR = join(".cache", "kajianq", "sanadset-pilot");

export const REPORT_JSON = "report.json";
export const REPORT_MARKDOWN = "report.md";
export const QUARANTINE_JSON = "quarantine.json";
export const SAMPLE_JSON = "sample-300.json";
export const LABELS_CSV = "labels-template.csv";
export const SPOT_CHECK_CSV = "owner-spotcheck-50.csv";
export const PREDICTIONS_JSON = "sample-predictions.json";

/** The default archive path; `SANADSET_CSV` overrides it. */
export function defaultCsvPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SANADSET_CSV"];
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return join(homedir(), ".cache", "kajianq", "sanadset", "sanadset.csv");
}

/** Resolve the artifact directory: an explicit override, else the per-user cache. */
export function resolveOutDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["SANADSET_STUDY_DIR"];
  if (override !== undefined && override.trim().length > 0) return override.trim();
  return join(homedir(), DEFAULT_ARTIFACT_DIR);
}

export type ArtifactFile = { readonly name: string; readonly content: string };

/** Write every artifact into `dir` (created if absent) and return the paths in write order. */
export function writeArtifactFiles(dir: string, files: readonly ArtifactFile[]): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const path = join(dir, file.name);
    writeFileSync(path, file.content, "utf8");
    written.push(path);
  }
  return written;
}

/** JSON on disk is pretty-printed and newline-terminated: it is evidence, read by humans too. */
export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
