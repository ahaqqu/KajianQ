import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { requestPersistentStorage } from "./lib/persist";
import { router } from "./router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

function App() {
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    void requestPersistentStorage();
    if (!("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.ready.then((reg) => {
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) {
            setUpdateReady(true);
          }
        });
      });
    });
  }, []);

  return (
    <>
      {updateReady && (
        <div
          className="fixed right-3 bottom-3 z-50 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm shadow-lg"
          role="status"
        >
          <button
            type="button"
            className="text-sky-400 underline"
            onClick={() => window.location.reload()}
          >
            Reload for update
          </button>
        </div>
      )}
      <RouterProvider router={router} />
    </>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root_missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
