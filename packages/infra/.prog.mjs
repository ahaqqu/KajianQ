import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.NEON_DATABASE_URL);
const c =
  await sql`SELECT metadata->>'sourceType' AS st, count(*)::int AS n FROM doc_children GROUP BY 1 ORDER BY 2 DESC`;
const p = await sql`SELECT count(*)::int AS n FROM doc_parents WHERE source_key NOT LIKE 'ct-%'`;
const r = await sql`SELECT label FROM eval_runs ORDER BY created_at DESC LIMIT 3`;
console.log(
  new Date().toISOString().slice(11, 19),
  "| chunks:",
  c.map((x) => `${x.st ?? "(fixture)"}=${x.n}`).join(" "),
  "| real parents:",
  p[0].n,
  "| reports:",
  r.map((x) => x.label).join(","),
);
