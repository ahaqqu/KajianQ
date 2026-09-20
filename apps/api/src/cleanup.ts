#!/usr/bin/env bun
/**
 * cleanup.ts — the anonymous-session reclamation cron entry (#181, ADR-0044).
 *
 *   bun run apps/api/src/cleanup.ts
 *
 * ADR-0017's nightly reclamation (`cleanupExpiredSessions`) ran as a Cloudflare
 * Worker cron trigger; on the VPS it is a systemd timer invoking this entry
 * (`provision/vps/systemd/kajianq-cron.{service,timer}`). A dedicated process
 * rather than an in-process interval keeps the schedule independently
 * observable (`systemctl status kajianq-cron`) and reclaims even when the
 * serving process is unhealthy — the two jobs have different failure modes and
 * should not share one.
 *
 * Exit 0 on a completed run (including one that reclaimed nothing) and non-zero
 * only when the reclamation itself failed, so the timer's status is meaningful.
 * The cleanup already logs rather than throws on a transient store fault; this
 * entry turns its result into an exit code.
 */
import { cleanupExpiredSessions } from "./lib/scheduled";

const result = await cleanupExpiredSessions(process.env as Record<string, string | undefined>);
process.exit(result.ok ? 0 : 1);
