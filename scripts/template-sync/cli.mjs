#!/usr/bin/env bun
import { createSyncLogger, createGit } from "./git.mjs";
import { loadManifest } from "./manifest.mjs";
import { readState } from "./state.mjs";
import { createCommands } from "./commands.mjs";

const ROOT = process.env.TEMPLATE_SYNC_CWD || process.cwd();
const MANIFEST_PATH = `${ROOT}/template-sync.json`;
const STATE_PATH = `${ROOT}/.template-sync.state`;

const usage = (log) => {
  log.info("template-sync usage", {
    usage: "bun run template-sync <command> [--ref=X] [--branch=Y]",
    commands: {
      init: "add and fetch the upstream remote (run once per project)",
      check: "gate: fail if template-owned files drifted from the last synced ref",
      gate: "alias for check",
      seed: "record sync state against an upstream ref without merging (--ref=X to pin)",
      update: "merge the latest template release (--ref=X to pin)",
      finish: "complete an update after resolving merge conflicts",
    },
  });
};

function parseArgs(argv) {
  const flags = { ref: null, branch: null };
  let command = "";
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      return { command: "help", flags };
    }
    if (a.startsWith("--ref=")) {
      flags.ref = a.slice("--ref=".length);
    } else if (a.startsWith("--branch=")) {
      flags.branch = a.slice("--branch=".length);
    } else if (!a.startsWith("-")) {
      if (command) throw new Error(`Unexpected positional argument: ${a}`);
      command = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return { command, flags };
}

function main() {
  const log = createSyncLogger();
  try {
    const { command, flags } = parseArgs(process.argv.slice(2));

    if (command === "help" || command === "") {
      usage(log);
      process.exit(0);
    }

    const manifest = loadManifest(MANIFEST_PATH);
    const env = process.env;
    const remote = env.TEMPLATE_SYNC_REMOTE || "upstream";
    const { git, gitOk, gitOut } = createGit({ cwd: ROOT, log, remote });
    const state = readState(STATE_PATH);
    const ctx = {
      cwd: ROOT,
      log,
      git,
      gitOk,
      gitOut,
      remote,
      manifest,
      env,
      state,
    };

    const commands = createCommands(ctx);
    const run = {
      init: commands.cmdInit,
      check: commands.cmdCheck,
      gate: commands.cmdCheck,
      seed: () => commands.cmdSeed(flags),
      update: () => commands.cmdUpdate(flags),
      finish: commands.cmdFinish,
    };

    if (!run[command]) {
      log.error("unknown command", { command });
      usage(log);
      process.exit(1);
    }

    process.exit(run[command]());
  } catch (err) {
    log.error("template-sync failed", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

main();
