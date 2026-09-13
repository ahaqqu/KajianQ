import { useEffect, useState } from "react";
import { t, useLocale } from "./i18n";

/**
 * Service-worker update prompt (JSX, hence .tsx). Renders nothing until a new
 * SW is installed while an old one controls the page, then offers a reload.
 * Apply asks the waiting worker to activate — the generated sw.js answers the
 * SKIP_WAITING message with skipWaiting() — and reloads only once the new
 * worker controls the page: a bare reload would leave the old worker in
 * charge and the stale bundle in place. Copy is localized; rendered inside
 * the shell's locale provider.
 */
export function SwUpdatePrompt() {
  const locale = useLocale();
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
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

  const applyUpdate = () => {
    // Listen first: the new worker's activation can fire controllerchange at
    // any moment after skipWaiting() runs. A bare reload here would still be
    // served by the old worker, so reload only on the takeover itself.
    navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
      once: true,
    });
    void navigator.serviceWorker.ready.then((reg) => {
      reg.waiting?.postMessage({ type: "SKIP_WAITING" });
    });
  };

  if (!updateReady) return null;

  return (
    <div
      className="fixed right-3 bottom-3 z-50 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm shadow-lg"
      role="status"
    >
      <span className="mr-2">{t(locale, "updateAvailable")}</span>
      <button type="button" className="text-sky-400 underline" onClick={applyUpdate}>
        {t(locale, "reload")}
      </button>
    </div>
  );
}
