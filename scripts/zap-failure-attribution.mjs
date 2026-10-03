#!/usr/bin/env bun
// ZAP baseline failure attribution (#382). A red `ZAP baseline` step means one
// of two completely different things, and the job's colour cannot tell them
// apart:
//
//   * the SCANNER could not run — an infrastructure abort (run 37118454475:
//     `Failed to access summary file /home/zap/zap_out.json`, then `docker`
//     exit code 3, no report written); nothing to fix in the site;
//   * the SCAN RAN and FOUND NEW ALERTS — the site regressed.
//
// The distinguishing line exists only inside the step log, so a reader — or a
// future automated triage — cannot tell "the scanner broke" from "the site
// regressed" without opening it. This module turns the evidence that outlives
// the failed step into a named class, and writes it to the job summary.
//
// WHERE THE CLASS COMES FROM (the action is a black box; this is its interface)
//
// 1. `zaproxy/action-baseline@de8ad967…` (v0.15.0) index.js:60-76. It runs
//    `docker run <image> zap-baseline.py …` and branches on the container's exit
//    code:
//      * exit 3       → `core.setFailed('failed to scan the target: …')` and
//                       `return`: `processReport` never runs, so there is no
//                       `FAIL-NEW:` line, no `zap_scan` artifact and no issue —
//                       exactly run 37118454475's shape;
//      * exit 1 or 2  → with `fail_action: true`: `setFailed('Scan action
//                       failed as ZAP has identified alerts, starting to
//                       analyze the results. …')`, then `processReport` runs and
//                       prints `FAIL-NEW:`/`WARN-NEW:` and uploads the report.
// 2. The image's own contract (`docker/zap-baseline.py` at the pinned digest's
//    commit 2665d97, header lines 31-34, exit sites 497-516 and 695-708):
//      0: Success · 1: At least 1 FAIL · 2: At least one WARN and no FAILs ·
//      3: Any other failure.
//
// So the container's exit code IS the class, and the action never passes
// `--rm`, so the aborted container is still on the runner when an
// `if: failure()` step runs. Nothing here weakens the gate: the scan step keeps
// `fail_action: true`, and this runs only after it has already failed.
//
// The classification is a pure function of (step outcomes, container exit code,
// report presence) so it can be asserted directly — see
// tests/scripts/zap-failure-attribution.test.mjs.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Exit contract of the baseline script inside the pinned image. */
export const ZAP_EXIT_CONTRACT = {
  0: "Success — the scan ran and found no new alerts.",
  1: "At least 1 FAIL — the scan ran and found FAIL-level alerts.",
  2: "At least one WARN and no FAILs — the scan ran and found WARN-level alerts.",
  3: "Any other failure — the scan could not complete; no report was written.",
};

export const ZAP_CLASSES = {
  imagePreflight: "image-preflight-failed",
  scanAborted: "scan-aborted",
  failAlerts: "scan-found-fail-alerts",
  warnAlerts: "scan-found-warn-alerts",
  containerFailed: "scanner-container-failed",
  postScan: "post-scan-failure",
  noContainer: "no-container-found",
  notZap: "not-a-zap-failure",
  wiring: "outcomes-missing",
};

/**
 * Pick the ZAP container from the runner's container list.
 *
 * Three lookups, in order, each one reported by name so the output never hides
 * which one produced the id:
 *   1. `docker ps -a --filter ancestor=<image>` — the precise filter;
 *   2. the container that appeared between the pre-pull step's snapshot and now
 *      — deterministic, and independent of docker's filter semantics;
 *   3. the most recently created container — this job starts exactly one.
 * The fallbacks exist because the filter could not be exercised against a live
 * docker daemon where this was written (the socket is not readable outside the
 * docker group); the id is reported alongside its method so a wrong pick is
 * visible rather than silent.
 */
export function chooseContainer({ ancestor = [], before = [], after = [], latest = null } = {}) {
  const first = ancestor.find(Boolean);
  if (first) return { id: first, method: "docker ps --filter ancestor" };

  const seen = new Set(before);
  const appeared = after.find((id) => id && !seen.has(id));
  if (appeared) return { id: appeared, method: "new container since the pre-pull snapshot" };

  if (latest) return { id: latest, method: "most recently created container" };
  return { id: null, method: "none — no container found" };
}

/**
 * Read the ZAP JSON report the action asks for (`-J report_json.json`, written
 * into the workspace the container mounts at /zap/wrk). Presence is the
 * corroborating signal for the scan class: the abort path writes nothing.
 * The risk-code tally is corroboration only — the gate's own FAIL-NEW/WARN-NEW
 * counts come from the action's rule-file comparison, not from this tally.
 */
export function parseZapReport(text) {
  if (text === null || text === undefined || text === "") {
    return { present: false, parseable: false, siteCount: 0, alertCount: 0, byRisk: {}, top: [] };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      present: true,
      parseable: false,
      error: String(error.message ?? error),
      siteCount: 0,
      alertCount: 0,
      byRisk: {},
      top: [],
    };
  }
  const sites = Array.isArray(data?.site) ? data.site : [];
  const alerts = sites.flatMap((site) => (Array.isArray(site?.alerts) ? site.alerts : []));
  const byRisk = {};
  for (const alert of alerts) {
    const risk = String(alert?.riskcode ?? "unknown");
    byRisk[risk] = (byRisk[risk] ?? 0) + 1;
  }
  const top = alerts.slice(0, 10).map((alert) => ({
    risk: String(alert?.riskcode ?? "?"),
    plugin: String(alert?.pluginid ?? "?"),
    alert: String(alert?.alert ?? alert?.name ?? "(unnamed)"),
    instances: Array.isArray(alert?.instances) ? alert.instances.length : 0,
  }));
  return {
    present: true,
    parseable: true,
    siteCount: sites.length,
    alertCount: alerts.length,
    byRisk,
    top,
  };
}

/**
 * The classification. Pure: no docker, no filesystem — the inputs are the
 * signals the workflow can still read after the failure.
 */
export function classifyZapFailure({
  imageOutcome = "unknown",
  scanOutcome = "unknown",
  container = null,
  report = parseZapReport(null),
} = {}) {
  const signals = {
    imageOutcome,
    scanOutcome,
    containerId: container?.id ?? null,
    containerFoundBy: container?.method ?? null,
    containerExitCode: container?.exitCode ?? null,
    reportPresent: Boolean(report?.present),
    reportParseable: Boolean(report?.parseable),
  };

  if (imageOutcome === "unknown" || scanOutcome === "unknown") {
    // Fail loudly. Without the two step outcomes this classifier cannot name a
    // class, and the default reading of a silent block would be "no ZAP step
    // failed" — the opposite of the truth when the workflow's env wiring drifts.
    return {
      class: ZAP_CLASSES.wiring,
      headline:
        "Cannot attribute: the step outcomes did not reach the classifier, so it must not guess a class.",
      meaning:
        "`.github/workflows/staging.yml` passes `steps.zap-image.outcome` and `steps.zap.outcome` as `ZAP_IMAGE_OUTCOME` / `ZAP_SCAN_OUTCOME`; one of them arrived empty or unknown.",
      nextStep:
        "Read the step log above for the actual failure, then fix the classifier's env wiring in the workflow.",
      signals,
    };
  }

  if (imageOutcome === "failure") {
    return {
      class: ZAP_CLASSES.imagePreflight,
      headline:
        "The pinned ZAP image could not be prepared — the scan never started. This is infrastructure, not a finding about the site.",
      meaning:
        "The `ZAP image pre-pull` step pulls the pinned digest before the action runs, so a registry outage, a revoked digest or a docker daemon failure stops the job by that step's name and the scan never runs.",
      nextStep:
        "Re-run the job. If it repeats, check registry access for ghcr.io and that the pinned digest still resolves (`docker buildx imagetools inspect`).",
      signals,
    };
  }

  if (scanOutcome !== "failure") {
    return {
      class: ZAP_CLASSES.notZap,
      headline: "No ZAP step failed — the attribution step ran on some other red.",
      meaning:
        "This block is written only when the `ZAP image pre-pull` or `ZAP baseline` step failed; a red Golden Set smoke skips both (#360).",
      nextStep: "Read the failing step above; the Golden Set smoke writes its own summary block.",
      signals,
    };
  }

  if (!container?.id) {
    return {
      class: ZAP_CLASSES.noContainer,
      headline: report?.present
        ? "The ZAP step failed after the scan wrote a report, and its container is gone — the failure is downstream of the scan."
        : "The ZAP step failed with no container and no report on the runner.",
      meaning: report?.present
        ? "A report exists, so the scan itself completed; the red came from the step after it (report analysis, issue writing or the artifact upload). The site's alert posture is readable from the report."
        : "Nothing proves whether ZAP started: a docker-level failure before `docker run`, or an abort whose container was removed. The step log is the only remaining evidence.",
      nextStep:
        "Open the step log for `failed to scan the target` (abort) versus `identified alerts` (findings) and file/patch this classifier if it could not see the container.",
      signals,
    };
  }

  const exitCode = container.exitCode;
  const base = { signals };
  if (exitCode === 3) {
    return {
      ...base,
      class: ZAP_CLASSES.scanAborted,
      headline:
        "SCANNER BROKE — ZAP exited 3 (`Any other failure`) and wrote no report. This is an infrastructure abort, not a finding about the site.",
      meaning:
        "The action fails and returns before analysing results, so no `FAIL-NEW:` line, no `zap_scan` artifact and no issue exist for this run — the shape of run 37118454475 (#382).",
      nextStep:
        "Re-run the job (a re-dispatch of the same artifact was green on 37118702128). The container logs are attached to this run as `zap-failure-diagnostics`; if the abort repeats, read those instead of re-diagnosing from scratch.",
    };
  }
  if (exitCode === 1) {
    return {
      ...base,
      class: ZAP_CLASSES.failAlerts,
      headline:
        "SITE REGRESSED — ZAP exited 1: the scan ran and found at least one FAIL-level alert.",
      meaning:
        "The action printed `FAIL-NEW: <n>` and uploaded its `zap_scan` report; the gate is doing its job (#382).",
      nextStep:
        "Read the alert list below and the `zap_scan` artifact. Fix the site or, if the alert is a false positive, add a justified suppression to .github/zap-rules.tsv.",
    };
  }
  if (exitCode === 2) {
    return {
      ...base,
      class: ZAP_CLASSES.warnAlerts,
      headline:
        "SITE REGRESSED — ZAP exited 2: the scan ran and found WARN-level alerts (no FAILs).",
      meaning:
        "With `fail_action: true` a new warning reddens the gate; the action printed `WARN-NEW: <n>` and uploaded its report.",
      nextStep: "Read the alert list below and the `zap_scan` artifact; triage the new warning.",
    };
  }
  if (exitCode === 0) {
    return {
      ...base,
      class: ZAP_CLASSES.postScan,
      headline:
        "SCAN RAN AND PASSED — the container exited 0, so the red came after the scan (report analysis, issue writing or artifact upload).",
      meaning:
        "The site's alert posture is not implicated: the failure is in the step's own plumbing.",
      nextStep:
        "Read the step log's error for the failing post-scan call and file it as a tooling bug.",
    };
  }
  return {
    ...base,
    class: ZAP_CLASSES.containerFailed,
    headline: `SCANNER BROKE — the ZAP container exited ${exitCode}, which is none of the baseline contract's 0/1/2/3.`,
    meaning:
      "An out-of-contract container exit (an OOM kill reports 137, a docker daemon error 125) means the scan did not produce a verdict either way.",
    nextStep:
      "Re-run the job; the container logs are attached to this run as `zap-failure-diagnostics`.",
  };
}

/** The job-summary block. Deliberately names the class in the first line. */
export function renderAttribution(result) {
  const s = result.signals;
  const yesNo = (value) => (value === null || value === undefined ? "unknown" : String(value));
  const lines = [
    `### ZAP baseline attribution — **${result.class}**`,
    "",
    result.headline,
    "",
    "| signal | value |",
    "| --- | --- |",
    `| \`ZAP image pre-pull\` step | ${yesNo(s.imageOutcome)} |`,
    `| \`ZAP baseline\` step | ${yesNo(s.scanOutcome)} |`,
    `| ZAP container | ${s.containerId ? `\`${s.containerId.slice(0, 12)}\`` : "not found"} |`,
    `| found by | ${yesNo(s.containerFoundBy)} |`,
    `| container exit code | ${yesNo(s.containerExitCode)} |`,
    `| \`report_json.json\` | ${s.reportPresent ? (s.reportParseable ? "present, parseable" : "present, UNPARSEABLE") : "absent"} |`,
    "",
    result.meaning,
    "",
    `**Next:** ${result.nextStep}`,
    "",
  ];

  if (result.reportSummary) {
    lines.push(
      "Report corroboration — the gate's own counts come from the action's rule-file comparison, not from this tally:",
      "",
      result.reportSummary,
      "",
    );
  }
  lines.push(
    "Exit contract of the baseline script inside the pinned image (`docker/zap-baseline.py`):",
    "",
  );
  for (const [code, meaning] of Object.entries(ZAP_EXIT_CONTRACT))
    lines.push(`- \`${code}\` — ${meaning}`);
  lines.push(
    "",
    "Attribution #382: the action (v0.15.0, `index.js:60-76`) returns before analysing results on exit 3" +
      ' and analyses them on exit 1/2, so the container\'s exit code separates "the scanner broke" from' +
      ' "the site regressed". Container logs for this run are in the `zap-failure-diagnostics` artifact.',
    "",
  );
  return `${lines.join("\n")}`;
}

/** Add the report tally to the rendered block, when the report was readable. */
export function withReportSummary(result, report) {
  if (!report?.parseable) return result;
  const risks = Object.entries(report.byRisk ?? {})
    .map(([code, count]) => `${count}×risk ${code}`)
    .join(", ");
  const top = (report.top ?? [])
    .map(
      (alert) =>
        `  - risk ${alert.risk} · plugin ${alert.plugin} · ${alert.alert} (${alert.instances} instance(s))`,
    )
    .join("\n");
  return {
    ...result,
    reportSummary: `${report.siteCount} site(s), ${report.alertCount} alert type(s)${risks ? ` (${risks})` : ""}${
      top ? `:\n${top}` : "."
    }`,
  };
}

// ---------------------------------------------------------------------------
// CLI: gather the runner-side signals, write the artifact directory, print the
// job-summary block. Used by .github/workflows/staging.yml on `if: failure()`.
// It always exits 0: the job is already red, and a second failure here would
// only bury the class it exists to report.
// ---------------------------------------------------------------------------
function run(cmd, args = []) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout ?? "";
}

function listContainers(args) {
  return (run("docker", ["ps", "-aq", ...args]) ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function main() {
  const dir = process.env.ZAP_ARTIFACT_DIR || "zap-failure";
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const image = process.env.ZAP_IMAGE || "";
  const notes = [];
  mkdirSync(dir, { recursive: true });

  const ancestor = image ? listContainers(["--filter", `ancestor=${image}`]) : [];
  const before = (() => {
    try {
      return readFileSync(join(dir, "containers-before.txt"), "utf8");
    } catch {
      return "";
    }
  })()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const after = listContainers([]);
  const latest = (run("docker", ["ps", "-aql"]) ?? "").trim() || null;
  const chosen = chooseContainer({ ancestor, before, after, latest });

  let container = null;
  if (chosen.id) {
    const exitCode = (
      run("docker", ["inspect", "-f", "{{.State.ExitCode}}", chosen.id]) ?? ""
    ).trim();
    const status = (run("docker", ["inspect", "-f", "{{.State.Status}}", chosen.id]) ?? "").trim();
    container = {
      id: chosen.id,
      method: chosen.method,
      exitCode: exitCode === "" ? null : Number(exitCode),
      status: status || null,
      notes,
    };
    // The container's own logs are the evidence the failed step's log does not
    // keep; `docker run` carried no --rm, so it is still here.
    const logs = run("docker", ["logs", chosen.id]);
    if (logs !== null) writeFileSync(join(dir, "zap-container.log"), logs);
    else notes.push("docker logs returned nothing");
    const inspect = run("docker", ["inspect", chosen.id]);
    if (inspect) writeFileSync(join(dir, "zap-container-inspect.json"), inspect);
    // ZAP's own log lives in its home directory. HOME=/home/zap/ in the image
    // env; the other two are candidates from earlier image layouts, listed
    // because the path could not be confirmed without a running daemon — the
    // file that was actually found is named in containers.txt.
    for (const candidate of ["/home/zap/zap.log", "/home/zap/.ZAP/zap.log", "/zap/zap.log"]) {
      const target = join(dir, `zap-home${candidate.replaceAll("/", "_")}`);
      if (run("docker", ["cp", `${chosen.id}:${candidate}`, target]) !== null) {
        notes.push(`captured ${candidate}`);
      }
    }
  } else {
    notes.push("no container found: docker ps matched nothing");
  }
  writeFileSync(join(dir, "containers.txt"), `${after.join("\n")}\n`);

  const reportPath = join(workspace, "report_json.json");
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
  const report = parseZapReport(reportText);
  if (report.present) {
    try {
      copyFileSync(reportPath, join(dir, "report_json.json"));
    } catch {
      notes.push("could not copy report_json.json into the artifact directory");
    }
  }

  const result = withReportSummary(
    classifyZapFailure({
      imageOutcome: process.env.ZAP_IMAGE_OUTCOME || "unknown",
      scanOutcome: process.env.ZAP_SCAN_OUTCOME || "unknown",
      container,
      report,
    }),
    report,
  );
  const markdown = renderAttribution(result);
  writeFileSync(join(dir, "attribution.md"), markdown);
  writeFileSync(join(dir, "attribution.json"), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(markdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
