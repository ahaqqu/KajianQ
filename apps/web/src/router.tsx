import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AboutPage, ChatPage, CollectionPage, HomePage, Shell } from "./components/pages";
import { useLocale } from "./lib/i18n";

/**
 * The product's home is the chat (#11); the template's health card lives on
 * /health. The two public static pages — /about and /collection — are reachable
 * from the header nav and precached by the PWA, so they open offline.
 *
 * `createRouteTree` builds a fresh tree per call: TanStack route objects carry
 * their own matcher state and cannot be mounted by two routers at once, so a
 * test that mounts the real tree on a memory history needs its own. Every route
 * is declared with a literal path (never a helper over a `string`) so the
 * declared paths stay visible to the router's type registry below — a computed
 * path would widen `to` back to `string` and lose the `Link` type safety.
 */
function Chat() {
  const locale = useLocale();
  return <ChatPage locale={locale} />;
}

function Health() {
  return <HomePage locale={useLocale()} />;
}

function About() {
  return <AboutPage locale={useLocale()} />;
}

function Collection() {
  return <CollectionPage locale={useLocale()} />;
}

/** The route paths, in the order the header nav lists them. */
export const ROUTES = {
  chat: "/",
  health: "/health",
  about: "/about",
  collection: "/collection",
} as const;

/** A fresh route tree — one router per call (tests mount it on memory history). */
export function createRouteTree() {
  const rootRoute = createRootRoute({ component: Shell });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: Chat,
  });
  const healthRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/health",
    component: Health,
  });
  const aboutRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/about",
    component: About,
  });
  const collectionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/collection",
    component: Collection,
  });
  return rootRoute.addChildren([indexRoute, healthRoute, aboutRoute, collectionRoute]);
}

export const router = createRouter({ routeTree: createRouteTree() });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
