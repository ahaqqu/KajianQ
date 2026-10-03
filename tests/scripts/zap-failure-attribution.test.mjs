import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ZAP_CLASSES,
  ZAP_EXIT_CONTRACT,
  chooseContainer,
  classifyZapFailure,
  parseZapReport,
  renderAttribution,
  withReportSummary,
} from "../../scripts/zap-failure-attribution.mjs";

/**
 * ZAP baseline failure attribution (#382).
 *
 * The invariant: a red `ZAP baseline` step is DECIDABLE — from evidence that
 * outlives the failed step — as either "the scanner broke" (infrastructure) or
 * "the scan ran and found alerts" (the site regressed). Run 37118454475 was the
 * first class (docker exit 3, no report: `Failed to access summary file
 * /home/zap/zap_out.json`), run 37118702128 the second one's absence
 * (`FAIL-NEW: 0 WARN-NEW: 0 PASS: 62`), and the job's colour alone cannot tell
 * them apart.
 *
 * Traps these cases exist to catch:
 *   1. exit 3 (abort) and exit 1 (FAIL-level alerts) collapsed into one class;
 *   2. a stale container mislabelling a pre-pull failure as "the site
 *      regressed" — the scan never ran;
 *   3. missing env wiring reading as "no ZAP step failed", the opposite of the
 *      truth;
 *   4. an unreadable report counted as a report;
 *   5. a lookup inventing a container id instead of admitting it found none;
 *   6. any edit that weakens the gate (`continue-on-error`, `|| true` on the
 *      scan, a conditional scan step, `fail_action: false`).
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
    // The abort path must not be described in terms of findings at all.
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
    // scan verdict — claiming one would send a reader hunting a site regression
    // that cannot exist.
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
            const { class: klass } = classifyZapFailure({
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
          }
        }
      }
    }
    expect(checked).toBe(outcomes.length * outcomes.length * exits.length * reports.length);
  });
});

describe("the container lookup cannot invent a container", () => {
  it("prefers the ancestor filter, then the pre-pull diff, then the newest container", () => {
    expect(
      chooseContainer({ ancestor: ["a"], before: ["b"], after: ["a", "b"], latest: "c" }),
    ).toEqual({ id: "a", method: "docker ps --filter ancestor" });
    expect(
      chooseContainer({ ancestor: [], before: ["b"], after: ["b", "a"], latest: "c" }),
    ).toEqual({
      id: "a",
      method: "new container since the pre-pull snapshot",
    });
    expect(chooseContainer({ ancestor: [], before: [], after: [], latest: "c" })).toEqual({
      id: "c",
      method: "most recently created container",
    });
  });

  it("says it found nothing rather than returning a wrong id", () => {
    const chosen = chooseContainer({ ancestor: [], before: ["b"], after: ["b"], latest: null });
    expect(chosen.id).toBeNull();
    expect(chosen.method).toMatch(/none/);
  });

  it("trap 5: a container that predates the pre-pull snapshot is not the scan's container", () => {
    // The diff direction matters: `before` ⊆ `after` means nothing new started,
    // so the fallback must not pick a leftover container as this run's scan.
    expect(
      chooseContainer({ ancestor: [], before: ["x", "y"], after: ["x", "y"], latest: null }),
    ).toEqual({ id: null, method: "none — no container found" });
  });

  it("ignores empty lines from docker's output", () => {
    expect(chooseContainer({ ancestor: [""], before: [], after: [], latest: null }).id).toBeNull();
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
});

// ---------------------------------------------------------------------------
// The workflow itself. `.github/workflows/staging.yml` is CI metadata, so the
// pin and the "gate not weakened" property are asserted here rather than in a
// staging run: a floating tag or a swallowed failure is exactly the class of
// regression no runtime test would ever report.
// ---------------------------------------------------------------------------
const WORKFLOW = resolve(process.cwd(), ".github/workflows/staging.yml");
const workflow = readFileSync(WORKFLOW, "utf8");

/** Drop whole-line comments: the file explains WHY a floating tag is not used. */
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
  // A six-space comment line always opens the NEXT step's preamble in this
  // file; comments inside a step (between `with:` keys or in a `run:` block)
  // are indented deeper. Stopping there keeps one step's prose out of another
  // step's assertions — a slicer that ran past it read the attribution step's
  // explanatory comment as the scan step's content.
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
    // `:stable` may still appear inside the comment that documents the bump
    // command — that is the trigger, not an input.
    expect(directives(workflow)).not.toMatch(/zaproxy:stable/);
    expect(directives(workflow)).not.toMatch(/zaproxy\/zaproxy:(?!.*@sha256)/);
  });

  it("feeds the pin to the action through `docker_name`", () => {
    const zap = stepBlock("ZAP baseline");
    expect(zap).toMatch(/docker_name: \$\{\{ env\.ZAP_IMAGE \}\}/);
    // The env var the input reads must be the pinned ref, not a tag.
    expect(workflow).toMatch(/^\s*ZAP_IMAGE: ghcr\.io\/zaproxy\/zaproxy@sha256:[0-9a-f]{64}$/m);
  });

  it("holds the file's own convention: every non-local `uses:` is SHA-pinned", () => {
    // Two regex traps this pattern keeps out, both of which made the assertion
    // near-vacuous before they were caught here: `\s*` with the multiline flag
    // matches newlines and swallows every earlier match, and step-level `uses:`
    // lines are YAML list items (`- uses:`), so a bare `uses:` anchor misses
    // all of them and leaves only the job-level local workflow.
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
    // Both steps must exist and sit in this order in the job.
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
    // The fallback exists so the summary is never silently empty; it is on the
    // diagnostic step, downstream of the gate's own red.
    expect(attribution).toMatch(/\|\| \\\n/);
    expect(attribution).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
  });

  it("wires both step outcomes into the classifier (trap 3's precondition)", () => {
    const attribution = stepBlock("ZAP failure attribution");
    expect(attribution).toMatch(/ZAP_IMAGE_OUTCOME: \$\{\{ steps\.zap-image\.outcome \}\}/);
    expect(attribution).toMatch(/ZAP_SCAN_OUTCOME: \$\{\{ steps\.zap\.outcome \}\}/);
    // …and the classifier reads exactly those names.
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
    // The action's `docker run` carries no --rm (verified from run
    // 37118454475's log: `docker run -v … --network=host … -t …` with no --rm),
    // which is what makes the exited container readable from a later step.
    const script = readFileSync(
      resolve(process.cwd(), "scripts/zap-failure-attribution.mjs"),
      "utf8",
    );
    expect(script).toMatch(/docker", \["logs", chosen\.id\]/);
    expect(script).toMatch(/docker", \["cp",/);
    expect(script).toMatch(/state\.ExitCode|\{\{\.State\.ExitCode\}\}/);
  });
});
