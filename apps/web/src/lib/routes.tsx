import { Link } from "@tanstack/react-router";
import { t, type Locale } from "./i18n";

/**
 * The public route paths, in the order the header nav lists them. Lives in a
 * leaf `lib/` module so both the router (`router.tsx`, which must declare each
 * path as a literal for the type registry) and the header nav (`NavLinks`)
 * read one source — the nav list cannot drift from the route tree. The literal
 * paths themselves stay in `router.tsx` so the router's type registry keeps
 * `Link`'s `to` type-safe.
 */
export const NAV_ROUTES = [
  { to: "/", key: "navChat" },
  { to: "/collection", key: "navCollection" },
  { to: "/about", key: "navAbout" },
  { to: "/faq", key: "navFaq" },
] as const;

/**
 * The nav links themselves, in two treatments: the header's inline row (lg+)
 * and the drawer's large serif list (below lg). Both derive from the one list
 * above, so a link cannot appear in one and not the other.
 */
export function NavLinks({
  locale,
  variant = "inline",
}: {
  locale: Locale;
  variant?: "inline" | "drawer";
}) {
  if (variant === "drawer") {
    return (
      <ul className="divide-y divide-rule">
        {NAV_ROUTES.map(({ to, key }) => (
          <li key={to}>
            <Link
              to={to}
              activeOptions={{ exact: to === "/" }}
              activeProps={{ "aria-current": "page" }}
              className="block py-3 font-serif text-[28px] leading-tight font-semibold text-foreground hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(locale, key)}
            </Link>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="flex items-center gap-1">
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
            className="block rounded-lg px-4 py-2 text-sm font-medium hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t(locale, key)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
