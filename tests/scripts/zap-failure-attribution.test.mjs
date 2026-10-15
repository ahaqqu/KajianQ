import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_CAPTURE_BYTES,
  ZAP_CLASSES,
  ZAP_EXIT_CONTRACT,
  chooseContainer,
  classifyZapFailure,
  parseZapReport,
  renderAttribution,
  runCapture,
  withReportSummary,
} from "../../scripts/zap-failure-attribution.mjs";

/**
 * ZAP baseline failure attribution.
 *
 * The invariant: a red `ZAP baseline` step is DECIDABLE — from evidence that
 * outlives the failed step — as either "the scanner broke" (infrastructure) or
 * "the scan ran and found alerts" (the site regressed), which the job's colour
 * alone cannot tell apart. No case here may weaken the gate.
 */

const container = (over = {}) => ({
  id: "c0ffee1234567890",
  method: "docker ps --filter ancestor",
  exitCode: 3,
  status: "exited",
  ...over,
});

const report = (over = {}) => ({
  present: true,
  parseable: true,
  siteCount: 1,
  alertCount: 0,
  byRisk: {},
  top: [],
  ...over,
});

describe("the class is decidable from evidence that survives the failed step", () => {
  it("trap 1: docker exit 3 with no report is the scanner breaking — never a site reading", () => {
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: container({ exitCode: 3 }),
      report: parseZapReport(null),
    });
    expect(result.class).toBe(ZAP_CLASSES.scanAborted);
    expect(result.headline).toMatch(/SCANNER BROKE/);
    expect(result.headline).toMatch(/infrastructure abort/);
    expect(result.headline).not.toMatch(/regress|alert/i);
    expect(result.signals.reportPresent).toBe(false);
  });

  it("trap 1: docker exit 1 with a report is the site regressing — never an abort", () => {
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: container({ exitCode: 1 }),
      report: report({ alertCount: 1, byRisk: { 3: 1 } }),
    });
    expect(result.class).toBe(ZAP_CLASSES.failAlerts);
    expect(result.headline).toMatch(/SITE REGRESSED/);
    expect(result.headline).not.toMatch(/SCANNER BROKE|infrastructure/i);
  });

  it("docker exit 2 is the scan's WARN branch, named as such", () => {
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: container({ exitCode: 2 }),
      report: report(),
    });
    expect(result.class).toBe(ZAP_CLASSES.warnAlerts);
    expect(result.headline).toMatch(/WARN-level/);
  });

  it("docker exit 0 puts the red after the scan and does not implicate the site", () => {
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: container({ exitCode: 0 }),
      report: report(),
    });
    expect(result.class).toBe(ZAP_CLASSES.postScan);
    expect(result.headline).toMatch(/exited 0/);
    expect(result.headline).toMatch(/after the scan/);
  });

  it("an out-of-contract exit (137 OOM, 125 daemon) is named with its code, not silently classified", () => {
    for (const exitCode of [137, 125, 255]) {
      const result = classifyZapFailure({
        imageOutcome: "success",
        scanOutcome: "failure",
        container: container({ exitCode }),
        report: parseZapReport(null),
      });
      expect(result.class).toBe(ZAP_CLASSES.containerFailed);
      expect(result.headline).toContain(String(exitCode));
    }
  });

  it("trap 2: a failed pre-pull wins over any container still lying on the runner", () => {
    // The scan never started, so whatever container the lookup finds is not a
    // scan verdict — claiming one sends a reader hunting a phantom regression.
    for (const exitCode of [0, 1, 2, 3, null]) {
      const result = classifyZapFailure({
        imageOutcome: "failure",
        scanOutcome: "skipped",
        container: container({ exitCode }),
        report: parseZapReport(null),
      });
      expect(result.class).toBe(ZAP_CLASSES.imagePreflight);
      expect(result.headline).toMatch(/never started/);
      expect(result.headline).not.toMatch(/regress|alerts/i);
    }
  });

  it("trap 3: missing step outcomes are reported as broken wiring, not as 'no ZAP failure'", () => {
    for (const missing of [
      { imageOutcome: "unknown", scanOutcome: "failure" },
      { imageOutcome: "success", scanOutcome: "unknown" },
      { imageOutcome: "unknown", scanOutcome: "unknown" },
      {},
    ]) {
      const result = classifyZapFailure({
        ...missing,
        container: container(),
        report: parseZapReport(null),
      });
      expect(result.class).toBe(ZAP_CLASSES.wiring);
      expect(result.headline).toMatch(/must not guess/);
    }
  });

  it("a red Golden Set smoke skips both ZAP steps and gets no ZAP verdict", () => {
    const result = classifyZapFailure({
      imageOutcome: "skipped",
      scanOutcome: "skipped",
      container: null,
      report: parseZapReport(null),
    });
    expect(result.class).toBe(ZAP_CLASSES.notZap);
    expect(result.meaning).toMatch(/#360/);
  });

  it("trap 3/5: no container and no report admits what it cannot prove", () => {
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: null,
      report: parseZapReport(null),
    });
    expect(result.class).toBe(ZAP_CLASSES.noContainer);
    expect(result.headline).toMatch(/no container and no report/);
    expect(result.meaning).toMatch(/Nothing proves whether ZAP started/);
  });

  it("no container but a report present puts the red downstream of the scan", () => {
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: null,
      report: report(),
    });
    expect(result.class).toBe(ZAP_CLASSES.noContainer);
    expect(result.headline).toMatch(/downstream of the scan/);
  });

  it("trap 4 at the consumer (A2): an unparseable report is not proof the scan completed", () => {
    // `present` alone is not evidence: a truncated write or a proxy error body
    // leaves a report file that proves nothing about the scan.
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: null,
      report: parseZapReport("<html><body>502 Bad Gateway</body></html>"),
    });
    expect(result.class).toBe(ZAP_CLASSES.noContainer);
    expect(result.headline).toMatch(/could not be parsed/);
    expect(result.headline).toMatch(/unproven/);
    expect(result.headline).not.toMatch(/downstream of the scan|SITE REGRESSED/);
    expect(result.meaning).not.toMatch(/so the scan itself completed/);
    expect(renderAttribution(result)).toContain("| `report_json.json` | present, UNPARSEABLE |");
  });

  it("over the whole input cross-product, only a scan that RAN can be blamed on the site", () => {
    const outcomes = ["success", "failure", "skipped", "cancelled"];
    const exits = [0, 1, 2, 3, 137, null];
    const reports = [parseZapReport(null), report(), parseZapReport("<html>502</html>")];
    let checked = 0;
    for (const imageOutcome of outcomes) {
      for (const scanOutcome of outcomes) {
        for (const exitCode of exits) {
          for (const rep of reports) {
            checked += 1;
            const { class: klass, headline } = classifyZapFailure({
              imageOutcome,
              scanOutcome,
              container: exitCode === null ? null : container({ exitCode }),
              report: rep,
            });
            if (klass === ZAP_CLASSES.failAlerts || klass === ZAP_CLASSES.warnAlerts) {
              // The only two classes that name a site verdict require the
              // container's own contract to have reported FAILs or WARNs.
              expect([1, 2], `${klass} at exit ${exitCode}`).toContain(exitCode);
              expect(scanOutcome, `${klass} without a failed scan step`).toBe("failure");
            }
            if (klass === ZAP_CLASSES.scanAborted) expect(exitCode).toBe(3);
            if (klass === ZAP_CLASSES.postScan) expect(exitCode).toBe(0);
            if (klass === ZAP_CLASSES.imagePreflight) expect(imageOutcome).toBe("failure");
            if (klass === ZAP_CLASSES.noContainer && !rep.parseable) {
              // Absent OR unreadable is never proof that the scan completed —
              // the rule must hold at the consumer, not only at the probe.
              expect(headline, `completed-scan claim from ${JSON.stringify(rep)}`).not.toMatch(
                /downstream of the scan/,
              );
            }
          }
        }
      }
    }
    expect(checked).toBe(outcomes.length * outcomes.length * exits.length * reports.length);
  });
});

describe("the container lookup cannot invent a container", () => {
  it("prefers the ancestor filter, then the pre-pull diff, and names the lookup that worked", () => {
    expect(chooseContainer({ ancestor: ["a"], before: ["b"], after: ["a", "b"] })).toEqual({
      id: "a",
      method: "docker ps --filter ancestor, appeared since the pre-pull snapshot",
    });
    expect(chooseContainer({ ancestor: [], before: ["b"], after: ["b", "a"] })).toEqual({
      id: "a",
      method: "new container since the pre-pull snapshot",
    });
  });

  it("says it found nothing rather than returning a wrong id", () => {
    const chosen = chooseContainer({ ancestor: [], before: ["b"], after: ["b"] });
    expect(chosen.id).toBeNull();
    expect(chosen.method).toMatch(/none/);
  });

  it("trap 5 (A1): a newest-container fallback would print SITE REGRESSED from another run's container", () => {
    // A container that predates the snapshot is not this run's scan, and there
    // is deliberately no newest-container fallback to hand it to the classifier.
    const chosen = chooseContainer({ ancestor: [], before: ["a"], after: ["a"], latest: "b" });
    expect(chosen).toEqual({ id: null, method: "none — no container found" });
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: chosen.id === null ? null : { ...chosen, exitCode: 1 },
      report: parseZapReport(null),
    });
    expect(result.class).toBe(ZAP_CLASSES.noContainer);
    expect(result.headline).not.toMatch(/SITE REGRESSED|regress/i);
  });

  it("trap 5 (A1): an ancestor hit that predates the snapshot is not this run's scan either", () => {
    // Tier 1 needs the same provenance filter: on a reused or self-hosted runner
    // a stale container of the pinned image matches the ancestor filter.
    expect(
      chooseContainer({
        ancestor: ["bbbbbbbbbbbb"],
        before: ["bbbbbbbbbbbb"],
        after: ["bbbbbbbbbbbb"],
      }),
    ).toEqual({ id: null, method: "none — no container found" });
    // …and the filter never rejects the scan's own container, which appeared
    // after the snapshot.
    expect(
      chooseContainer({
        ancestor: ["bbbbbbbbbbbb"],
        before: ["aaaaaaaaaaaa"],
        after: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"],
      }),
    ).toEqual({
      id: "bbbbbbbbbbbb",
      method: "docker ps --filter ancestor, appeared since the pre-pull snapshot",
    });
  });

  it("refuses to guess when the pre-pull snapshot could not be read", () => {
    // An unreadable snapshot is not an empty runner: with nothing to intersect
    // against, any id in `ancestor` could be from another run.
    const chosen = chooseContainer({
      ancestor: ["a"],
      before: [],
      after: ["a"],
      snapshotTaken: false,
    });
    expect(chosen.id).toBeNull();
    expect(chosen.method).toMatch(/pre-pull snapshot is unavailable/);
  });

  it("ignores empty lines from docker's output", () => {
    expect(chooseContainer({ ancestor: [""], before: [], after: [] }).id).toBeNull();
  });

  it("property (A1): over the whole lookup cross-product, only a container that appeared since the snapshot can yield a site verdict", () => {
    const ids = ["a", "b", "c"];
    const lists = [[], ["a"], ["b"], ["c"], ["a", "b"]];
    const exits = [0, 1, 2, 3, 137];
    let checked = 0;
    let siteVerdicts = 0;
    for (const ancestor of lists) {
      for (const before of lists) {
        for (const after of lists) {
          for (const exitCode of exits) {
            checked += 1;
            const chosen = chooseContainer({ ancestor, before, after });
            if (!ids.includes(chosen.id)) continue;
            // Provenance: whatever was chosen must not have been on the runner
            // before the pre-pull snapshot, from either lookup.
            expect(before, `${chosen.id} predates the snapshot`).not.toContain(chosen.id);
            const result = classifyZapFailure({
              imageOutcome: "success",
              scanOutcome: "failure",
              container: { ...chosen, exitCode },
              report: parseZapReport(null),
            });
            if (
              result.class === ZAP_CLASSES.failAlerts ||
              result.class === ZAP_CLASSES.warnAlerts
            ) {
              siteVerdicts += 1;
              expect([1, 2]).toContain(exitCode);
            }
          }
        }
      }
    }
    expect(checked).toBe(lists.length ** 3 * exits.length);
    expect(siteVerdicts).toBeGreaterThan(0);
  });
});

describe("the report probe distinguishes absent from unreadable", () => {
  it("treats no report file as absent", () => {
    for (const text of [null, undefined, ""]) expect(parseZapReport(text).present).toBe(false);
  });

  it("trap 4: an unparseable body is present but NOT a readable report", () => {
    const parsed = parseZapReport("<html><body>502 Bad Gateway</body></html>");
    expect(parsed.present).toBe(true);
    expect(parsed.parseable).toBe(false);
    expect(parsed.error).toBeTruthy();
  });

  it("counts alerts by risk code and caps the digest at ten entries", () => {
    const alerts = Array.from({ length: 12 }, (_, i) => ({
      pluginid: String(10000 + i),
      riskcode: i < 2 ? "3" : "1",
      alert: `Alert ${i}`,
      instances: [{ uri: "https://example.test/" }],
    }));
    const parsed = parseZapReport(JSON.stringify({ site: [{ "@name": "t", alerts }] }));
    expect(parsed).toMatchObject({ present: true, parseable: true, siteCount: 1, alertCount: 12 });
    expect(parsed.byRisk).toEqual({ 3: 2, 1: 10 });
    expect(parsed.top).toHaveLength(10);
    expect(parsed.top[0]).toEqual({
      risk: "3",
      plugin: "10000",
      alert: "Alert 0",
      instances: 1,
    });
  });

  it("accepts a valid report with no site array instead of throwing", () => {
    expect(parseZapReport("{}")).toMatchObject({
      present: true,
      parseable: true,
      siteCount: 0,
      alertCount: 0,
    });
  });
});

describe("the job-summary block is what a reader (or triage) sees first", () => {
  const abort = withReportSummary(
    classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: container({ exitCode: 3 }),
      report: parseZapReport(null),
    }),
    parseZapReport(null),
  );

  it("names the class on its first line", () => {
    const md = renderAttribution(abort);
    expect(md.split("\n")[0]).toBe(`### ZAP baseline attribution — **${ZAP_CLASSES.scanAborted}**`);
  });

  it("carries the signals a reader needs to check the verdict", () => {
    const md = renderAttribution(abort);
    expect(md).toContain("| `ZAP image pre-pull` step | success |");
    expect(md).toContain("| `ZAP baseline` step | failure |");
    expect(md).toContain("| container exit code | 3 |");
    expect(md).toContain("| `report_json.json` | absent |");
  });

  it("teaches the exit contract inside the summary, so no one re-derives it from the log", () => {
    const md = renderAttribution(abort);
    for (const [code, meaning] of Object.entries(ZAP_EXIT_CONTRACT)) {
      expect(md).toContain(`- \`${code}\` — ${meaning}`);
    }
  });

  it("points at the artifact that keeps the container logs (the recurrence instruction)", () => {
    expect(renderAttribution(abort)).toMatch(/zap-failure-diagnostics/);
  });

  it("adds the report tally only when a report was readable", () => {
    const silent = renderAttribution(abort);
    expect(silent).not.toMatch(/Report corroboration/);

    const withReport = withReportSummary(
      classifyZapFailure({
        imageOutcome: "success",
        scanOutcome: "failure",
        container: container({ exitCode: 1 }),
        report: report({
          alertCount: 1,
          byRisk: { 3: 1 },
          top: [{ risk: "3", plugin: "40012", alert: "XSS", instances: 2 }],
        }),
      }),
      report({
        alertCount: 1,
        byRisk: { 3: 1 },
        top: [{ risk: "3", plugin: "40012", alert: "XSS", instances: 2 }],
      }),
    );
    const md = renderAttribution(withReport);
    expect(md).toMatch(/Report corroboration/);
    expect(md).toMatch(/1×risk 3/);
    expect(md).toMatch(/plugin 40012 · XSS \(2 instance\(s\)\)/);
  });

  it("ends with exactly one trailing newline (the repo's body normalisation)", () => {
    const md = renderAttribution(abort);
    expect(md.endsWith("\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(false);
  });

  it("carries the capture notes into the signals and the summary (B1)", () => {
    // `captured <path>` is the only record of which candidate log location existed.
    const notes = [
      "docker logs captured 4096 bytes into zap-container.log",
      "captured /home/zap/zap.log",
    ];
    const result = classifyZapFailure({
      imageOutcome: "success",
      scanOutcome: "failure",
      container: container({ exitCode: 3 }),
      report: parseZapReport(null),
      notes,
    });
    expect(result.signals.captureNotes).toEqual(notes);
    const md = renderAttribution(result);
    expect(md).toMatch(/Capture notes/);
    expect(md).toContain("- docker logs captured 4096 bytes into zap-container.log");
    expect(md).toContain("- captured /home/zap/zap.log");
    // containers.txt is the raw `docker ps -aq` id list; no capture note lives there.
    expect(md).not.toMatch(/containers\.txt/);
  });

  it("prints no capture-notes section when there is nothing to report", () => {
    expect(renderAttribution(abort)).not.toMatch(/Capture notes/);
  });
});

// `.github/workflows/staging.yml` is CI metadata, so the pin and the "gate not
// weakened" property are asserted here: a floating tag or a swallowed failure is
// the class of regression no runtime test would report.
const WORKFLOW = resolve(process.cwd(), ".github/workflows/staging.yml");
const workflow = readFileSync(WORKFLOW, "utf8");

/** Whole-line comments are dropped; `:stable` may legitimately appear inside one. */
const directives = (text) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/** The text of one named step, to the next step at the same indentation. */
function stepBlock(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  expect(start, `staging.yml must carry a step named "${name}"`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  // A six-space comment line opens the NEXT step's preamble; comments inside a
  // step are indented deeper. Stopping there keeps steps' prose apart.
  const next = /\n {6}(?:- (?:name|uses|run):|# )/.exec(rest);
  return next ? workflow.slice(start, start + 1 + next.index) : workflow.slice(start);
}

describe("staging.yml: every input to the ZAP step is pinned (#382)", () => {
  it("pins the ZAP container image by digest, in exactly one place", () => {
    const pins = workflow.match(/ghcr\.io\/zaproxy\/zaproxy@sha256:[0-9a-f]{64}/g) ?? [];
    expect(pins, "the image pin must exist and have a single bump site").toHaveLength(1);
    expect(pins[0]).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it("leaves no floating ZAP tag in any directive", () => {
    // `:stable` may appear inside the comment that documents the bump command —
    // a trigger, not an input.
    expect(directives(workflow)).not.toMatch(/zaproxy:stable/);
    expect(directives(workflow)).not.toMatch(/zaproxy\/zaproxy:(?!.*@sha256)/);
  });

  it("feeds the pin to the action through `docker_name`", () => {
    const zap = stepBlock("ZAP baseline");
    expect(zap).toMatch(/docker_name: \$\{\{ env\.ZAP_IMAGE \}\}/);
    expect(workflow).toMatch(/^\s*ZAP_IMAGE: ghcr\.io\/zaproxy\/zaproxy@sha256:[0-9a-f]{64}$/m);
  });

  it("holds the file's own convention: every non-local `uses:` is SHA-pinned", () => {
    // `\s*` under the multiline flag matches newlines and swallows every earlier
    // match, and step-level `uses:` lines are YAML list items.
    const refs = [...directives(workflow).matchAll(/^[ \t]*(?:- )?uses: (\S+)/gm)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const ref of refs) {
      if (ref.startsWith("./")) continue; // the local reusable deploy workflow
      expect(ref, `${ref} is not pinned by SHA`).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("pulls the pinned image before the scan, so a registry failure is attributed first", () => {
    const prepull = stepBlock("ZAP image pre-pull");
    expect(prepull).toMatch(/docker pull "\$ZAP_IMAGE"/);
    const order = ["ZAP image pre-pull", "ZAP baseline", "ZAP failure attribution"].map((name) =>
      workflow.indexOf(`      - name: ${name}\n`),
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });
});

describe("staging.yml: the attribution must not weaken the gate", () => {
  it("keeps the scan failing on findings", () => {
    const zap = stepBlock("ZAP baseline");
    expect(zap).toMatch(/fail_action: true/);
    expect(zap).not.toMatch(/fail_action: false/);
  });

  it("gives the scan step no conditional, no continue-on-error and no fallback", () => {
    const zap = stepBlock("ZAP baseline");
    expect(zap).not.toMatch(/^\s*if:/m);
    expect(zap).not.toMatch(/continue-on-error/);
    expect(zap).not.toMatch(/\|\|\s*true/);
    expect(zap).not.toMatch(/\|\|\s*echo/);
  });

  it("swallows nothing anywhere in the workflow", () => {
    const code = directives(workflow);
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/\|\|\s*true/);
  });

  it("confines the diagnostic fallback to the attribution step, which only runs on failure", () => {
    const attribution = stepBlock("ZAP failure attribution");
    expect(attribution).toMatch(/^\s*if: failure\(\) && \(steps\.zap\.outcome == 'failure'/m);
    // The fallback exists so the summary is never silently empty, on the
    // diagnostic step only.
    expect(attribution).toMatch(/\|\| \\\n/);
    expect(attribution).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
  });

  it("wires both step outcomes into the classifier (trap 3's precondition)", () => {
    const attribution = stepBlock("ZAP failure attribution");
    expect(attribution).toMatch(/ZAP_IMAGE_OUTCOME: \$\{\{ steps\.zap-image\.outcome \}\}/);
    expect(attribution).toMatch(/ZAP_SCAN_OUTCOME: \$\{\{ steps\.zap\.outcome \}\}/);
    const script = readFileSync(
      resolve(process.cwd(), "scripts/zap-failure-attribution.mjs"),
      "utf8",
    );
    expect(script).toMatch(/process\.env\.ZAP_IMAGE_OUTCOME/);
    expect(script).toMatch(/process\.env\.ZAP_SCAN_OUTCOME/);
  });

  it("ships the container logs as a pinned artifact, on failure only", () => {
    const upload = stepBlock("Upload ZAP failure diagnostics");
    expect(upload).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v\d/);
    expect(upload).toMatch(/^\s*if: failure\(\)/m);
    expect(upload).toMatch(/path: zap-failure\//);
    expect(upload).toMatch(/retention-days: 14/);
  });

  it("captures the container logs the abort path would otherwise lose", () => {
    // The action's `docker run` carries no `--rm`, which is what makes the
    // exited container readable from a later step.
    const script = readFileSync(
      resolve(process.cwd(), "scripts/zap-failure-attribution.mjs"),
      "utf8",
    );
    expect(script).toMatch(/docker", \["logs", chosen\.id\]/);
    expect(script).toMatch(/docker", \["cp",/);
    expect(script).toMatch(/state\.ExitCode|\{\{\.State\.ExitCode\}\}/);
  });
});

// Docker is unavailable here and on CI, so the buffer behaviour is pinned on the
// capture helper itself and end-to-end: the CLI runs against a throwaway
// `docker` earlier on PATH, and the artifact directory is what gets asserted.
describe("the capture keeps the evidence it takes (B2, #397)", () => {
  it("captures output larger than node's 1 MiB default instead of returning null", () => {
    const captured = runCapture(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(3*1024*1024))",
    ]);
    expect(captured.error).toBeNull();
    expect(captured.ok).toBe(true);
    expect(captured.stdout).toHaveLength(3 * 1024 * 1024);
    expect(MAX_CAPTURE_BYTES).toBeGreaterThan(captured.stdout.length);
  });

  it("keeps 'no output' and 'capture failed' distinguishable", () => {
    expect(runCapture(process.execPath, ["-e", "process.exit(0)"])).toEqual({
      ok: true,
      stdout: "",
      error: null,
    });
    expect(runCapture(process.execPath, ["-e", "process.exit(7)"])).toEqual({
      ok: false,
      stdout: null,
      error: "exit 7",
    });
  });
});

describe("the CLI writes the evidence it gathered into the artifact (A1/B1/B2, #397)", () => {
  const SCRIPT = resolve(process.cwd(), "scripts/zap-failure-attribution.mjs");
  const IMAGE = `ghcr.io/zaproxy/zaproxy@sha256:${"a".repeat(64)}`;
  const SCAN = "d9f0a1b2c3d4";
  const STALE = "aaaaaaaaaaaa";

  /**
   * Run the CLI against a stub `docker` on PATH and hand the artifact directory
   * to `check`; `before`/`after` are the id lists around the pre-pull snapshot.
   */
  function withFakeDocker(fixture, check) {
    const root = mkdtempSync(join(tmpdir(), "zap-attribution-"));
    try {
      const bin = join(root, "bin");
      const artifact = join(root, "zap-failure");
      const workspace = join(root, "workspace");
      mkdirSync(bin, { recursive: true });
      mkdirSync(artifact, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(artifact, "containers-before.txt"), `${fixture.before.join("\n")}\n`);
      const dockerLog = join(root, "docker-logs");
      writeFileSync(dockerLog, "z".repeat(fixture.logBytes));
      const zapLog = join(root, "zap.log");
      writeFileSync(zapLog, "zap home log\n");

      // The stale arms make a resurrected "newest container" fallback find a
      // readable exit 1 on the leftover container and print SITE REGRESSED.
      const stub = `#!/bin/sh
case "$*" in
  "ps -aq --filter ancestor=${IMAGE}") printf '%s\\n' ${fixture.ancestor.join(" ")} ;;
  "ps -aq") printf '%s\\n' ${fixture.after.join(" ")} ;;
  "ps -aql") echo ${STALE} ;;
  "inspect -f {{.State.ExitCode}} ${SCAN}") echo ${fixture.exitCode} ;;
  "inspect -f {{.State.Status}} ${SCAN}") echo exited ;;
  "inspect ${SCAN}") echo '{}' ;;
  "logs ${SCAN}") cat "${dockerLog}" ;;
  "inspect -f {{.State.ExitCode}} ${STALE}") echo 1 ;;
  "inspect -f {{.State.Status}} ${STALE}") echo exited ;;
  "inspect ${STALE}") echo '{}' ;;
  "logs ${STALE}") echo "another run's container log" ;;
  "cp ${SCAN}:/home/zap/zap.log"*) cp "${zapLog}" "$3" ;;
  "cp "*) exit 1 ;;
esac
exit 0
`;
      writeFileSync(join(bin, "docker"), stub, { mode: 0o755 });

      const run = spawnSync(process.execPath, [SCRIPT], {
        encoding: "utf8",
        cwd: workspace,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ZAP_ARTIFACT_DIR: artifact,
          GITHUB_WORKSPACE: workspace,
          ZAP_IMAGE: IMAGE,
          ZAP_IMAGE_OUTCOME: "success",
          ZAP_SCAN_OUTCOME: "failure",
        },
      });
      return check({ artifact, run });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("never picks a container that predates the pre-pull snapshot (A1)", () => {
    // The runner holds the same image's container from an earlier run (readable,
    // exit 1) and nothing appeared during this one; both lookups must refuse it.
    withFakeDocker(
      {
        before: [STALE],
        after: [STALE],
        ancestor: [STALE],
        exitCode: 1,
        logBytes: 16,
      },
      ({ artifact, run }) => {
        expect(run.status).toBe(0);
        expect(run.stdout).toContain(`**${ZAP_CLASSES.noContainer}**`);
        expect(run.stdout).not.toMatch(/SITE REGRESSED/);
        expect(readFileSync(join(artifact, "notes.txt"), "utf8")).toMatch(/no container chosen/);
        expect(() => readFileSync(join(artifact, "zap-container.log"))).toThrow();
      },
    );
  });

  it("keeps a >1 MiB container log, and names it, instead of dropping it (B1/B2)", () => {
    withFakeDocker(
      { before: [], after: [SCAN], ancestor: [SCAN], exitCode: 3, logBytes: 3 * 1024 * 1024 },
      ({ artifact, run }) => {
        expect(run.status).toBe(0);
        expect(run.stdout).toContain(`**${ZAP_CLASSES.scanAborted}**`);
        expect(run.stdout).toMatch(/docker logs captured 3145728 bytes/);
        expect(run.stdout).toContain("- captured /home/zap/zap.log");
        expect(readFileSync(join(artifact, "zap-container.log"), "utf8")).toHaveLength(
          3 * 1024 * 1024,
        );
        const notes = readFileSync(join(artifact, "notes.txt"), "utf8");
        expect(notes).toMatch(/docker logs captured 3145728 bytes into zap-container\.log/);
        expect(notes).toMatch(/captured \/home\/zap\/zap\.log/);
        // The same notes ride the signals, so attribution.json carries them too.
        const { signals } = JSON.parse(readFileSync(join(artifact, "attribution.json"), "utf8"));
        expect(signals.captureNotes).toEqual(notes.trimEnd().split("\n"));
      },
    );
  });
});
