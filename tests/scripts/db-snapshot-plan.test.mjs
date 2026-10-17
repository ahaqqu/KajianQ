import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * The restore plan `db-snapshot` prints is an instruction an operator follows
 * verbatim, so it must not teach a command line that carries the target's
 * password: `ps` shows another local user every argument for the process's life
 * and the shell keeps it in history. The plan therefore gives the connection as
 * flags with the password in libpq's environment.
 */
describe("the printed restore plan keeps the credential off argv", () => {
  it("prints PGPASSWORD with -h/-p/-U/-d, never a connection-URL argument", () => {
    const script = resolve(process.cwd(), "packages/infra/scripts/db-snapshot.mjs");
    const res = spawnSync("bun", [script, "restore-plan", "probe-label"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('PGPASSWORD="$TARGET_PASSWORD"');
    expect(res.stdout).toMatch(/pg_restore[^\n]*-h <host> -p <port> -U <user> -d <database>/);
    expect(res.stdout).toMatch(/psql -h <host> -p <port> -U <user> -d <database>/);
    // The URL forms the plan used to teach: `-d "$TARGET_URL"` and `psql "$TARGET_URL"`.
    expect(res.stdout).not.toMatch(/postgres:\/\//);
    expect(res.stdout).not.toMatch(/\$TARGET_URL/);
  });
});
