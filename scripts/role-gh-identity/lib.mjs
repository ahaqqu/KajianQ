// Pure logic for the role-gh-identity workspace hook: role resolution and
// bare-`gh` command detection, plus the deny reason. All I/O lives in
// hook.mjs; everything here is synchronous and side-effect-free so the test
// suite can exercise the invariant directly.
//
// The invariant this hook protects: when role-separated GitHub identities are
// enabled, a role subagent with an assigned identity may invoke `gh` ONLY
// through the `gh-as <role>` wrapper — a bare `gh` call would post as the
// owner's personal account, silently defeating the separation. Deny is the
// enforcement mechanism (never a prompt rewrite): the compliant command is
// stated in the deny reason, and the token file contents never enter the
// agent's context.
//
// Fail-open doctrine (inherited from the iteration-guardrail): any internal
// error, unknown envelope shape, or unresolvable role means ALLOW — a broken
// identity hook must never trap an agent. The deny fires ONLY when:
// enforcement is enabled AND the calling session resolves to a role with a
// configured identity AND the command invokes bare `gh`. A missed evasion
// shape fails in the safe direction too: the call runs under the default
// identity, which is exactly the enforcement-off behavior.

/** The wrapper command every denied call is redirected to. */
export const GH_AS_WRAPPER = "gh-as";

// Detection works on command SEGMENTS, not one regex: split the command on
// shell operators (`;`, `&&`, `||`, `|`, `&`, subshell/command-substitution
// parens, newlines), strip leading shell keywords (`if`/`then`/`else`/`do`),
// pass-through runners (`exec`/`env`/`xargs`/`sudo`/`command`), and `VAR=…`
// assignments from each segment, then check whether what remains invokes
// `gh`. This keeps quoted prose (`git commit -m 'gh pr view is the fix'`,
// `echo 'then gh …'`) from matching — the segment starts with `git`/`echo`,
// not `gh` — while real invocation shapes (`if gh …; then`, `bash -c 'gh …'`,
// `… && gh …`, `GH_TOKEN=x gh …`) do. A `bash -c 'gh …'` body is caught by
// the `-c` quote rule. False negatives (novel evasion shapes) only mean a
// call runs under the default identity — the enforcement-off behavior,
// never a trap.

const SEGMENT_SPLIT = /[;&|()\n]/;
const LEADING_KEYWORD = /^(?:if|then|else|do|exec|env|xargs|sudo|command|nice|nohup)\s+/g;
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/g;
const DASH_C_QUOTED_GH = /(?:^|\s)-c\s*['"`]\s*gh(?:\s|$)/;

/**
 * Does this Bash command invoke `gh` outside the `gh-as` wrapper?
 */
export function invokesBareGh(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  for (const raw of command.split(SEGMENT_SPLIT)) {
    let seg = raw.trim().replace(/^['"`]/, "");
    while (LEADING_KEYWORD.test(seg)) seg = seg.replace(LEADING_KEYWORD, "");
    while (LEADING_ASSIGNMENT.test(seg)) seg = seg.replace(LEADING_ASSIGNMENT, "");
    if (seg === "gh" || seg.startsWith("gh ")) return true;
    if (DASH_C_QUOTED_GH.test(seg)) return true;
  }
  return false;
}

/**
 * Resolve the calling session's role.
 *
 * @param {{ agent_type?: string }} payload the parsed hook payload; ZCode's
 *   Claude-compatible envelope carries `agent_type` on subagent dispatches
 *   (probed: committed runtime-envelope fixture, `agent_type:
 *   "implementer"`).
 * @param {(sessionKey: string) => { role: string } | null} metadataLookup
 *   fallback for envelopes without `agent_type`: resolves via the agents-dir
 *   metadata scan (session id or agent id → role name). Hook-owned I/O.
 * @param {string} sessionId the payload `session_id`, for the fallback lookup.
 * @returns {string | null} the role name, or null when unresolvable
 *   (fail-open: the caller treats null as "no identity to enforce").
 */
export function resolveRole(payload, metadataLookup, sessionId) {
  const t = payload?.agent_type;
  if (typeof t === "string" && t.length > 0) return t;
  if (typeof metadataLookup !== "function" || typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }
  try {
    const found = metadataLookup(sessionId);
    return found && typeof found.role === "string" && found.role.length > 0 ? found.role : null;
  } catch {
    return null; // fail-open: a metadata scan error must never trap the call
  }
}

/**
 * Decide the hook's verdict for a PreToolUse Bash payload.
 *
 * @param {{ command?: string }} args the Bash command text.
 * @param {string | null} args.role the resolved role name.
 * @param {import("../../packages/contracts/src/role-identity").RoleIdentityConfig} args.config
 * @returns {{ deny: false } | { deny: true; reason: string }} — pure; the
 *   hook turns a deny verdict into the permissionDecision envelope.
 */
export function evaluateIdentityCall({ command, role, config }) {
  if (!config?.enabled) return { deny: false };
  if (typeof role !== "string" || role.length === 0) return { deny: false };
  const entry = config.roles?.[role];
  if (!entry || typeof entry.tokenFile !== "string" || entry.tokenFile.length === 0) return { deny: false };
  if (!invokesBareGh(command)) return { deny: false };
  return { deny: true, reason: buildDenyReason(role, entry) };
}

function buildDenyReason(role, entry) {
  return [
    `ROLE GH IDENTITY: this session runs as role "${role}", which has a dedicated GitHub identity. Bare \`gh\` calls would post as the owner's personal account.`,
    "",
    "Rerun the command through the role wrapper instead:",
    `  ${GH_AS_WRAPPER} ${role} <original gh arguments>`,
    "",
    `Example: \`gh pr view 123\` becomes \`${GH_AS_WRAPPER} ${role} pr view 123\`.`,
    "The wrapper is a pass-through for every gh subcommand and reads its token from the role's configured token file (outside this repo).",
    "Do not work around this deny by hiding the gh invocation (e.g. inside eval or a script); rerun through the wrapper.",
    `See your role's identity with \`${GH_AS_WRAPPER} ${role} auth status\`.`,
  ].join("\n");
}