import * as v from "valibot";

const NonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * Configuration contract for the role-gh-identity workspace hook
 * (`scripts/role-gh-identity/`), loaded from its `config.json`
 * (overridable via `ZCODE_ROLE_IDENTITY_CONFIG` for tests, mirroring the
 * iteration-guardrail's `ZCODE_GUARDRAIL_CONFIG`).
 *
 * Semantics:
 * - `enabled: false` (the shipped default) makes the hook a complete no-op:
 *   role-separated GitHub identities are opt-in per owner; the deny must
 *   never fire while the owner has not minted per-role tokens.
 * - Each entry in `roles` maps a role subagent name (the `agent_type` of
 *   the PreToolUse envelope, e.g. `implementer`, `reviewer`) to the path
 *   of a token file outside the repo. The path is read by the `gh-as`
 *   wrapper at call time — the hook itself never reads token contents,
 *   only names the wrapper in its deny message.
 * - `identitiesFile` is the human-readable per-role account mapping the
 *   wrapper prints on `gh-as <role> auth status`; also outside the repo.
 */
export const RoleIdentityConfigSchema = v.object({
  enabled: v.boolean(),
  roles: v.record(
    v.string(),
    v.object({
      tokenFile: v.pipe(
        v.string(),
        v.minLength(1),
      ),
    }),
  ),
  identitiesFile: v.optional(v.string()),
});

export type RoleIdentityConfig = v.InferOutput<typeof RoleIdentityConfigSchema>;

/** Never throws; `ok: false` means "not a valid role-identity config". */
export function parseRoleIdentityConfig(raw: unknown):
  | { ok: true; config: RoleIdentityConfig }
  | { ok: false; reason: string } {
  const result = v.safeParse(RoleIdentityConfigSchema, raw);
  if (result.success) return { ok: true, config: result.output };
  return {
    ok: false,
    reason: result.issues
      .map((issue) => `${issue.path?.map((p) => p.key).join(".") ?? "<root>"}: ${issue.message}`)
      .join("; "),
  };
}