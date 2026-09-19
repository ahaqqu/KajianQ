import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader";

/**
 * The shared chrome for the static public pages (About, Collection): the same
 * dashed-rule header the health page uses, over a single centered max-w-3xl
 * column — the app's one reading measure. The chat keeps its own full-height
 * layout instead (ChatView owns the composer band).
 */
export function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-dashed border-rule">
        <AppHeader />
      </header>
      <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">{children}</main>
    </div>
  );
}
