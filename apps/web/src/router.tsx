import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { HomePage } from "./components/HomePage";
import { NotesPage } from "./components/NotesPage";
import { Shell } from "./components/Shell";
import { useLocale } from "./lib/i18n";

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
