import { useEffect, useState } from "react";
import { t, useLocale } from "./i18n";

/**
 * Service-worker update prompt (JSX, hence .tsx). Renders nothing until a new
 * SW is installed while an old one controls the page, then offers a reload.
 * Copy is localized; rendered inside the shell's locale provider.
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

  if (!updateReady) return null;

  return (
    <div
      className="fixed right-3 bottom-3 z-50 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm shadow-lg"
      role="status"
    >
      <span className="mr-2">{t(locale, "updateAvailable")}</span>
      <button
        type="button"
        className="text-sky-400 underline"
        onClick={() => window.location.reload()}
      >
        {t(locale, "reload")}
      </button>
    </div>
  );
}
