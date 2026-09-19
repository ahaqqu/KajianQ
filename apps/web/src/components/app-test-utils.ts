import {
  RouterContextProvider,
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { createRouteTree } from "../router";

/**
 * Mounts the REAL route tree (router.tsx) on a memory history, so a component
 * test exercises the routes production serves — the header's nav links and
 * active state, the About/Collection pages, and the chat at "/". A fresh tree
 * per call is required (TanStack route objects cannot be mounted by two routers
 * at once), and `router.load()` is awaited first so the matched route is
 * rendered before the caller's (synchronous) queries run.
 */
export async function renderApp(path: string) {
  const router = createRouter({
    routeTree: createRouteTree(),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const view = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(RouterProvider, { router }),
    ),
  );
  return { router, queryClient, ...view };
}

/**
 * Renders a view that is ordinarily reached through the router but is mounted
 * on its own here (e.g. ChatView, whose header now reads the router's location
 * and renders `Link`s). Only the router *context* is provided — no route
 * matching — so the view under test keeps owning its own props.
 */
export function wrapInRouter(element: ReactElement) {
  const router = createRouter({
    routeTree: createRouteTree(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return createElement(RouterContextProvider, { router, children: element });
}
