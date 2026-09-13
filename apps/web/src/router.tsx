import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { ChatPage } from "./components/ChatPage";
import { HomePage } from "./components/HomePage";
import { Shell } from "./components/Shell";
import { useLocale } from "./lib/i18n";

/** The product's home is the chat (#11); the template's health card lives on /health. */
function Chat() {
  const locale = useLocale();
  return <ChatPage locale={locale} />;
}

function Health() {
  return <HomePage locale={useLocale()} />;
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

const routeTree = rootRoute.addChildren([indexRoute, healthRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
