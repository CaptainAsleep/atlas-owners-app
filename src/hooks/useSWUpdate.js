import { useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";

// How often to re-check for a newly deployed version while the app stays
// open in one session. This is the backstop, not the main mechanism — the
// far more common real-world trigger is someone backgrounding the app
// (switching apps, locking their phone) and coming back later, which the
// visibilitychange listener below catches directly.
const PERIODIC_CHECK_MS = 30 * 60 * 1000; // 30 minutes

// Surfaces "a new version is ready" as React state instead of either
// silently swallowing it (registerType: "autoUpdate", the previous
// config) or leaving it to the browser's own default check, which for an
// installed PWA only runs on a real navigation/reload — something that
// never happens in a long-lived open session. registerType is "prompt"
// in vite.config.js specifically so onNeedRefresh fires here instead of
// the service worker silently taking over and reloading the page out
// from under whatever the player is doing — with live Stripe checkouts
// in play, a surprise reload mid-flow is worse than a stale UI.
//
// Mounted once at the top of AppShell for the app's whole lifetime, so
// no cleanup is wired up for the interval/listeners below.
export function useSWUpdate() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const updateSWRef = useRef(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        setNeedRefresh(true);
      },
      onRegisteredSW(swUrl, registration) {
        if (!registration) return;

        const checkForUpdate = () => {
          registration.update().catch(() => {
            // Offline or a flaky network — just try again next tick.
          });
        };

        const interval = setInterval(checkForUpdate, PERIODIC_CHECK_MS);

        const onVisible = () => {
          if (document.visibilityState === "visible") checkForUpdate();
        };
        document.addEventListener("visibilitychange", onVisible);
        // Covers desktop tab-switching too — visibilitychange doesn't
        // fire consistently for that on every platform, window focus does.
        window.addEventListener("focus", checkForUpdate);

        return () => {
          clearInterval(interval);
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("focus", checkForUpdate);
        };
      },
    });

    updateSWRef.current = updateSW;
  }, []);

  // Calling the stored updateSW with `true` tells the waiting worker to
  // skip-waiting and take over, then reloads once it's in control — the
  // one moment this hook forces a reload, and only because the player
  // tapped the toast themselves.
  const refreshNow = () => {
    updateSWRef.current?.(true);
  };

  return { needRefresh, refreshNow };
}
