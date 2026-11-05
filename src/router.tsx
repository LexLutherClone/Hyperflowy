import { createRouter } from "@tanstack/react-router";

import { ErrorScreen } from "./components/error-screen";
import { spaceRewrite } from "./data/outline-scope";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createRouter({
    routeTree,
    // In a shared space every route lives under /s/<id> (ADR 0079). A rewrite,
    // not `basepath`: TanStack Start resets basepath to its build-time value
    // when it hydrates, but leaves `rewrite` alone.
    rewrite: spaceRewrite(),
    scrollRestoration: true,
    defaultPreload: "intent",
    // A render error shows a humane screen and reports to Sentry (#227),
    // instead of a white page.
    defaultErrorComponent: ErrorScreen,
  });

  return router;
}
