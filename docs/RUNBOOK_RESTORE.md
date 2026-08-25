# Restore runbook (D1 + R2)

## Daily backups

Cron `0 3 * * *` writes a JSON snapshot marker to R2:

`backups/<ISO-timestamp>.json`

## Restore D1 (point-in-time)

1. Identify the time window of data loss.
2. Cloudflare Dashboard → D1 → database → **Time Travel** (or wrangler):

```bash
wrangler d1 time-travel info <database-name>
wrangler d1 time-travel restore <database-name> --bookmark=<bookmark>
```

3. Redeploy the Worker if schema migrations are ahead of restored data:

```bash
bun run deploy
wrangler d1 migrations apply <database-name> --remote
```

## Restore object snapshots from R2

```bash
wrangler r2 object get <bucket-name> backups/<file>.json --file=./restore.json
```

## Drill checklist (before launch)

- [ ] Create a staging note, run backup cron manually, confirm R2 object exists
- [ ] Time Travel restore on staging D1
- [ ] Smoke: `/v1/health` and the project's primary read endpoint.
- [ ] Document elapsed time and any gaps
