```tsx
import { useEffect, useRef } from "react";

type TurnstileWidget = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      size?: "normal" | "compact" | "flexible";
      callback?: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "auto" | "light" | "dark";
    }
  ) => string;
  reset: (widgetId?: string) => void;
  remove?: (widgetId?: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileWidget;
  }
}

const SCRIPT_ID = "cloudflare-turnstile-script";
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";

export function TurnstileCaptcha({
  onToken,
  resetKey,
}: {
  onToken: (token: string) => void;
  resetKey?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  const siteKey = import.meta.env
    .VITE_TURNSTILE_SITE_KEY as string | undefined;

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    let cancelled = false;

    const render = () => {
      if (
        cancelled ||
        !containerRef.current ||
        !window.turnstile
      ) {
        return;
      }

      if (widgetIdRef.current) {
        window.turnstile.reset(widgetIdRef.current);
        return;
      }

      widgetIdRef.current = window.turnstile.render(
        containerRef.current,
        {
          sitekey: siteKey,

          // Makes Turnstile responsive on mobile
          size: "flexible",

          theme: "auto",

          callback: onToken,

          "expired-callback": () => {
            onToken("");
          },

          "error-callback": () => {
            onToken("");
          },
        }
      );
    };

    const existing = document.getElementById(SCRIPT_ID);

    if (existing) {
      if (window.turnstile) {
        render();
      } else {
        existing.addEventListener("load", render, {
          once: true,
        });
      }
    } else {
      const script = document.createElement("script");

      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = render;

      document.head.appendChild(script);
    }

    return () => {
      cancelled = true;

      if (
        widgetIdRef.current &&
        window.turnstile?.remove
      ) {
        window.turnstile.remove(widgetIdRef.current);
      }

      widgetIdRef.current = null;
    };
  }, [siteKey, onToken, resetKey]);

  if (!siteKey) {
    return (
      <div className="error">
        Turnstile site key is missing. Add
        VITE_TURNSTILE_SITE_KEY to .env.
      </div>
    );
  }

  return (
    <div
      aria-label="Security verification"
      style={{
        width: "100%",
        maxWidth: "100%",
        boxSizing: "border-box",
        overflow: "hidden",

        // Space between email field and CAPTCHA
        marginTop: "16px",
        marginBottom: "8px",

        display: "flex",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "304px",
          minHeight: "65px",
          boxSizing: "border-box",

          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div
          ref={containerRef}
          style={{
            width: "100%",
            maxWidth: "304px",
            minHeight: "65px",
            boxSizing: "border-box",

            display: "flex",
            justifyContent: "center",
            alignItems: "center",
          }}
        />
      </div>
    </div>
  );
}
```
