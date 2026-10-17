/**
 * snapshot-restore-plan.mjs — the restore plan `db-snapshot restore-plan`
 * prints, split out of the CLI so that file stays about behaviour and inside
 * the agentic-limits ceiling (the same reason `pg-conn.mjs`,
 * `snapshot-store.mjs` and `snapshot-privacy.mjs` are siblings).
 *
 * The plan is copied into a shell by hand, so it prints libpq flags and
 * placeholders — never a connection URL, which would put the password in the
 * process table and the shell history — and it names `--clean` as the reason
 * the target is chosen by hand rather than defaulted: the archive is a
 * whole-database dump, so an implicit target could be the live store.
 */
export function restorePlan(label, file) {
  const path = file ?? `<downloaded kajianq-${label}.dump>`;
  return [
    `Restore plan for snapshot "${label}" (ADR-0038):`,
    `  1. bun run db:snapshot download ${label}`,
    `  2. PGPASSWORD="$TARGET_PASSWORD" pg_restore --clean --if-exists --no-owner --no-privileges -h <host> -p <port> -U <user> -d <database> "${path}"`,
    `  3. PGPASSWORD="$TARGET_PASSWORD" psql -h <host> -p <port> -U <user> -d <database> -At -c "SELECT count(*) FROM doc_children"`,
    `  4. bun run db:snapshot verify ${label}   # compares live rows to the manifest`,
    `Restore is manual by design: --clean drops objects in the target, so it never`,
    `defaults to a live database. Restore into a NEW branch or project, verify, then`,
    `repoint DATABASE_URL. The password travels in libpq's environment, not argv.`,
  ].join("\n");
}
