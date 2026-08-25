import type { SyncStatus } from "@app/local-first/client";
import { t, type Locale, type MessageKey } from "../lib/i18n";

/** One label per status — the error state is distinct (it used to render as
 *  "Synced"). `idle` shows as synced: no pending changes before the first
 *  sync run. */
const LABELS: Record<SyncStatus, MessageKey> = {
  idle: "synced",
  syncing: "syncing",
  synced: "synced",
  offline: "offline",
  error: "syncError",
};

export function SyncStatusBadge({
  status,
  locale,
}: {
  status: SyncStatus;
  locale: Locale;
}) {
  return (
    <span
      data-testid="sync-status"
      className={status === "error" ? "text-amber-300" : undefined}
    >
      {t(locale, LABELS[status])}
    </span>
  );
}
