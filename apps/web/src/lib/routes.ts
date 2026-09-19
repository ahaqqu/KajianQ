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
