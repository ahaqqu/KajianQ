import type { SyncStatus } from "@app/local-first/client";
import { t, type Locale } from "../lib/i18n";
import { SyncStatusBadge } from "./SyncStatusBadge";
import { Button } from "./ui";

export function NotesHeader({
  status,
  locale,
  onSignOut,
}: {
  status: SyncStatus;
  locale: Locale;
  onSignOut: () => Promise<void>;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-400">
      <SyncStatusBadge status={status} locale={locale} />
      <Button
        type="button"
        variant="muted"
        onClick={() => void onSignOut()}
      >
        {t(locale, "signOut")}
      </Button>
    </div>
  );
}
