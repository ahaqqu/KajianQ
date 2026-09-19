import { Link } from "@tanstack/react-router";
import { t, type Locale } from "./i18n";

/**
 * The public route paths, in the order the header nav lists them. Lives in a
 * leaf `lib/` module so both the router (`router.tsx`, which must declare each
 * path as a literal for the type registry) and the header nav (`AppHeader`)
 * read one source — the nav list cannot drift from the route tree. The literal
 * paths themselves stay in `router.tsx` so the router's type registry keeps
 * `Link`'s `to` type-safe (thermo-review C3).
 */
export const NAV_ROUTES = [
  { to: "/", key: "navChat" },
  { to: "/collection", key: "navCollection" },
  { to: "/about", key: "navAbout" },
] as const;

/**
 * The nav links themselves (inline, sm+, or stacked inside the burger
 * disclosure) — rendered here, beside the list they derive from, so
 * `AppHeader` stays under the agentic-limits import cap.
 */
export function NavLinks({ locale, stacked = false }: { locale: Locale; stacked?: boolean }) {
  return (
    <ul className={stacked ? "flex flex-col" : "flex items-center gap-1"}>
      {NAV_ROUTES.map(({ to, key }) => (
        <li key={to}>
          <Link
            to={to}
            // "/" prefixes every route: without exact matching the Chat link
            // would read active on /about and /collection.
            activeOptions={{ exact: to === "/" }}
            activeProps={{
              "aria-current": "page",
              className: "text-foreground",
            }}
            inactiveProps={{ className: "text-muted-foreground" }}
            className="block rounded-lg px-3 py-1.5 text-sm font-medium hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(locale, key)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
