import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKTREE_DIR = ".pi-worktrees";
const SESSION_DIR = ".pi/subagent-sessions";
const SUBAGENT_SKILL_PATH = [".agents", "skills", "subagent"];

interface ModelConfig {
	[preset: string]: string;
}

const DEFAULT_MODELS: ModelConfig = {
	low: "ollama-cloud/deepseek-v4-flash:cloud",
	medium: "ollama-cloud/kimi-k2.7-code:cloud",
	high: "ollama-cloud/glm-5.2:cloud",
};

function slugify(text: string): string {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.slice(0, 50)
		.replace(/-$/, "");
}

function getRepoRoot(pi: ExtensionAPI): Promise<string | null> {
	return pi.exec("git", ["rev-parse", "--show-toplevel"]).then((res) => {
		if (res.code !== 0 || !res.stdout.trim()) return null;
		return res.stdout.trim();
	});
}

function loadModelConfig(repoRoot: string | null): ModelConfig {
	const candidates = [
		repoRoot ? join(repoRoot, ".pi", "subagent-models.json") : null,
		join(process.env.HOME || "~", ".pi/agent", "subagent-models.json"),
	];
	for (const path of candidates) {
		if (path && existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, "utf-8"));
				if (parsed && typeof parsed === "object") return parsed as ModelConfig;
			} catch {}
		}
	}
	return DEFAULT_MODELS;
}

function resolveModel(input: string | undefined, config: ModelConfig): string | undefined {
	if (!input) return undefined;
	if (config[input]) return config[input];
	return input; // treat as literal model pattern
}

function parseSubagentArgs(raw: string): { slug: string; task: string; model?: string } {
	const tokens = raw.trim().split(/\s+/);
	let model: string | undefined;
	let modelIndex = tokens.findIndex((t) => t === "--model" || t === "-m");
	if (modelIndex >= 0 && tokens[modelIndex + 1]) {
		model = tokens[modelIndex + 1];
		tokens.splice(modelIndex, 2);
	}

	if (!model && tokens.length >= 3) {
		// Orchestrator shorthand: "preset slug task..."
		const maybePreset = tokens[0].toLowerCase();
		const known = Object.keys(loadModelConfig(null));
		if (known.includes(maybePreset)) {
			model = maybePreset;
			tokens.shift();
		}
	}

	if (tokens.length < 1) return { slug: "", task: "" };
	const slug = tokens.shift()!;
	const task = tokens.join(" ").trim();
	return { slug, task, model };
}

function ensureGitignore(repoRoot: string, ...lines: string[]) {
	const gitignore = join(repoRoot, ".gitignore");
	const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf-8") : "";
	const needed = lines.filter((line) => !existing.includes(line));
	if (needed.length) {
		const prefix = existing.endsWith("\n") || existing === "" ? "" : "\n";
		writeFileSync(gitignore, `${existing}${prefix}${needed.join("\n")}\n`, "utf-8");
	}
}

async function createWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	slug: string,
	branch: string,
	wtPath: string,
) {
	const wtRoot = join(repoRoot, WORKTREE_DIR);
	if (!existsSync(wtRoot)) mkdirSync(wtRoot, { recursive: true });

	const { stdout: listOut } = await pi.exec("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
	const exists = listOut.split("\n").some((line) => line === `worktree ${wtPath}`);
	if (exists) return;

	const { code: branchExists } = await pi.exec("git", ["-C", repoRoot, "show-ref", "--verify", `refs/heads/${branch}`]);
	const args =
		branchExists === 0
			? ["worktree", "add", wtPath, branch]
			: ["worktree", "add", "-b", branch, wtPath];

	const { code, stderr } = await pi.exec("git", ["-C", repoRoot, ...args]);
	if (code !== 0) {
		throw new Error(`git worktree add failed: ${stderr.trim()}`);
	}
}

function buildPrompt(slug: string, task: string): string {
	return [
		`# Subagent task: ${slug}`,
		"",
		task,
		"",
		"## Instructions",
		"1. You are a focused subagent working in your own git worktree on a dedicated branch. Do not switch branches or create additional worktrees.",
		"2. Explore the codebase, plan the minimal changes, then implement them.",
		"3. Run relevant tests, type checks, or lint commands. If they fail and you cannot fix them, record the failure.",
		"4. When the task is complete (or when asked to checkpoint), commit your changes with a descriptive message.",
		"5. Write `AGENT_REPORT.md` in this worktree root summarizing: what changed, files touched, verification results, blockers, and follow-ups.",
		"6. Also write `AGENT_STATUS.json` with keys: startedAt (ISO string), completedAt (ISO string), commit (short hash), reportPath (absolute path).",
		"7. If you get stuck, stop and document the blocker instead of guessing.",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("subagent", {
		description: "Spawn a focused subagent in its own git worktree",
		handler: async (args, ctx) => {
			const repoRoot = await getRepoRoot(pi);
			if (!repoRoot) {
				ctx.ui.notify("Not inside a git repository", "error");
				return;
			}

			const skillPath = join(repoRoot, ...SUBAGENT_SKILL_PATH);
			if (!existsSync(join(skillPath, "SKILL.md"))) {
				ctx.ui.notify(
					`Subagent skill not found at ${SUBAGENT_SKILL_PATH.join("/")}. Ensure the project includes the subagent skill.`,
					"error",
				);
				return;
			}

			const config = loadModelConfig(repoRoot);
			const parsed = parseSubagentArgs(args);
			let { slug, task, model } = parsed;

			if (!slug) {
				ctx.ui.notify("Usage: /subagent [preset|--model <model>] <slug> <task>", "error");
				return;
			}

			slug = slugify(slug);
			if (!task) {
				ctx.ui.notify("Task is required", "error");
				return;
			}

			const resolvedModel = resolveModel(model, config);
			if (model && !resolvedModel) {
				ctx.ui.notify(`Unknown model preset: ${model}`, "error");
				return;
			}

			const branch = `agent/${slug}`;
			const wtPath = join(repoRoot, WORKTREE_DIR, slug);

			try {
				await createWorktree(pi, repoRoot, slug, branch, wtPath);
			} catch (err: any) {
				ctx.ui.notify(`Worktree error: ${err.message}`, "error");
				return;
			}

			ensureGitignore(repoRoot, `${WORKTREE_DIR}/`, `${SESSION_DIR}/`);

			const sessionDir = join(repoRoot, SESSION_DIR);
			if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

			const taskFile = join(wtPath, "AGENT_TASK.md");
			writeFileSync(taskFile, buildPrompt(slug, task), "utf-8");

			const commonArgs = [
				"--name",
				slug,
				"--approve",
				"--session-dir",
				sessionDir,
				"--skill",
				skillPath,
			];
			if (resolvedModel) commonArgs.push("--model", resolvedModel);
			commonArgs.push("@AGENT_TASK.md");

			if (process.env.TMUX) {
				const child = spawn(
					"tmux",
					["new-window", "-n", slug, "-c", wtPath, "--", "pi", ...commonArgs],
					{ detached: true, stdio: "ignore" },
				);
				child.unref();
				ctx.ui.notify(
					`Subagent ${slug} opened in tmux window${resolvedModel ? ` (model: ${resolvedModel})` : ""}`,
					"info",
				);
			} else {
				const logFile = join(wtPath, ".agent.log");
				const out = openSync(logFile, "a");
				const child = spawn("pi", commonArgs, {
					cwd: wtPath,
					detached: true,
					stdio: ["ignore", out, out],
				});
				child.unref();
				ctx.ui.notify(
					`Subagent ${slug} running headless${resolvedModel ? ` (model: ${resolvedModel})` : ""}. Log: ${logFile}`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("subagents", {
		description: "List active subagent worktrees and their completion status",
		handler: async (_args, ctx) => {
			const repoRoot = await getRepoRoot(pi);
			if (!repoRoot) {
				ctx.ui.notify("Not inside a git repository", "error");
				return;
			}
			const wtRoot = join(repoRoot, WORKTREE_DIR);
			if (!existsSync(wtRoot)) {
				ctx.ui.notify("No subagent worktrees found", "info");
				return;
			}

			const { stdout } = await pi.exec("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);
			const entries: { path: string; branch?: string; report?: string; status?: string }[] = [];
			let current: { path?: string; branch?: string } = {};
			for (const line of stdout.split("\n")) {
				if (line.startsWith("worktree ")) current = { path: line.slice("worktree ".length) };
				else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length);
				else if (line === "" && current.path) {
					if (current.path.startsWith(wtRoot)) {
						const reportFile = join(current.path, "AGENT_REPORT.md");
						const statusFile = join(current.path, "AGENT_STATUS.json");
						let status = "running";
						if (existsSync(statusFile)) {
							try {
								const s = JSON.parse(readFileSync(statusFile, "utf-8"));
								status = s.completedAt ? `completed @ ${s.commit ?? "unknown"}` : "in-progress";
							} catch {
								status = "status-parse-error";
							}
						}
						const report = existsSync(reportFile) ? reportFile : undefined;
						entries.push({ path: current.path, branch: current.branch, report, status });
					}
					current = {};
				}
			}

			if (entries.length === 0) {
				ctx.ui.notify("No subagent worktrees found", "info");
				return;
			}

			const lines = entries.map((e) => {
				const name = e.path.split("/").pop() || e.path;
				const branch = e.branch ? ` (${e.branch})` : "";
				const report = e.report ? ` [report]` : "";
				return `${name}${branch} — ${e.status}${report}`;
			});
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("subagent-status", {
		description: "Show detailed status for one subagent worktree",
		handler: async (args, ctx) => {
			const repoRoot = await getRepoRoot(pi);
			if (!repoRoot) {
				ctx.ui.notify("Not inside a git repository", "error");
				return;
			}
			const slug = slugify(args.trim());
			if (!slug) {
				ctx.ui.notify("Usage: /subagent-status <slug>", "error");
				return;
			}
			const wtPath = join(repoRoot, WORKTREE_DIR, slug);
			if (!existsSync(wtPath)) {
				ctx.ui.notify(`No worktree for subagent ${slug}`, "error");
				return;
			}

			const reportFile = join(wtPath, "AGENT_REPORT.md");
			const statusFile = join(wtPath, "AGENT_STATUS.json");
			const logFile = join(wtPath, ".agent.log");
			let statusText = `Subagent: ${slug}\nWorktree: ${wtPath}`;

			if (existsSync(statusFile)) {
				try {
					const s = JSON.parse(readFileSync(statusFile, "utf-8"));
					statusText += `\nStatus: ${s.completedAt ? "completed" : "in-progress"}`;
					statusText += `\nStarted: ${s.startedAt || "unknown"}`;
					if (s.completedAt) statusText += `\nCompleted: ${s.completedAt}`;
					if (s.commit) statusText += `\nCommit: ${s.commit}`;
					if (s.reportPath) statusText += `\nReport: ${s.reportPath}`;
				} catch {
					statusText += "\nStatus file exists but is invalid JSON";
				}
			} else {
				statusText += "\nStatus: no AGENT_STATUS.json yet";
			}

			if (existsSync(reportFile)) {
				statusText += `\nReport exists: ${reportFile}`;
			}
			if (existsSync(logFile)) {
				statusText += `\nLog: ${logFile}`;
			}

			ctx.ui.notify(statusText, "info");
		},
	});
}
