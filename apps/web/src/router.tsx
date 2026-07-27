import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { createContext, useContext, useState } from "react";
import { HomePage } from "./components/HomePage";
import { NotesPage } from "./components/NotesPage";
import { t, type Locale } from "./lib/i18n";

const LocaleCtx = createContext<Locale>("en");
export function useLocale() {
  return useContext(LocaleCtx);
}

function Shell() {
  const [locale, setLocale] = useState<Locale>("en");
  return (
    <LocaleCtx.Provider value={locale}>
      <div className="mx-auto min-h-screen max-w-lg px-4 py-8">
        <nav className="mb-6 flex flex-wrap items-center gap-3 text-sm">
          <Link to="/" className="text-sky-400">
            {t(locale, "homeTitle")}
          </Link>
          <Link to="/notes" className="text-sky-400" data-testid="nav-notes-top">
            {t(locale, "notes")}
          </Link>
          <label className="ml-auto flex items-center gap-2 text-slate-300">
            <span>{t(locale, "localeLabel")}</span>
            <select
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
              value={locale}
              aria-label={t(locale, "localeLabel")}
              data-testid="locale-select"
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              <option value="en">English</option>
              <option value="id">Indonesia</option>
            </select>
          </label>
        </nav>
        <Outlet />
      </div>
    </LocaleCtx.Provider>
  );
}

function Home() {
  return <HomePage locale={useLocale()} />;
}

function Notes() {
  return <NotesPage locale={useLocale()} />;
}

const rootRoute = createRootRoute({
  component: Shell,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Home,
});

const notesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notes",
  component: Notes,
});

const routeTree = rootRoute.addChildren([indexRoute, notesRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
