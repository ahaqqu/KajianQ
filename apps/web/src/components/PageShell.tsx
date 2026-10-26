import type { ReactNode } from "react";
import { useLocale } from "../lib/i18n";
import { AppHeader } from "./AppHeader";
import { SiteFooter } from "./SiteFooter";

/**
 * The shared chrome for the static public pages (About, Collection, FAQ,
 * Privacy, Terms): the full-bleed header, the page body, and the footer. The
 * chat keeps its own full-height layout instead (ChatView owns the composer
 * band and the compact footnote). The page body owns its own width — a page
 * chooses a 1152px section or a narrower reading measure inside it.
 */
export function PageShell({ children }: { children: ReactNode }) {
  const locale = useLocale();
  return (
    <div className="flex min-h-dvh flex-col">
      <AppHeader />
      <main className="flex-1">{children}</main>
      <SiteFooter locale={locale} />
    </div>
  );
}
