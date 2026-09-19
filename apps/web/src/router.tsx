import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AboutPage, ChatPage, CollectionPage, HomePage, Shell } from "./components/pages";
import { useLocale } from "./lib/i18n";

/**
 * The product's home is the chat (#11); the template's health card lives on
 * /health. The two public static pages — /about and /collection — are
 * reachable from the header nav and precached by the PWA, so they open offline.
 * `createAppRouteTree` is exported for tests, which mount the same tree on a
 * memory history.
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

const rootRoute = createRootRoute({
  component: Shell,
});

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

export const createAppRouteTree = () =>
  rootRoute.addChildren([indexRoute, healthRoute, aboutRoute, collectionRoute]);

const routeTree = createAppRouteTree();

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
