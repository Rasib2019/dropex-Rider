// Urdu | English switch. English text in the code is the key: tr("Accept order") returns the Urdu
// from urdu.ts when Urdu is selected, and the English text itself otherwise (or if no Urdu exists yet).
import { useSyncExternalStore } from "react";

import { UR } from "./urdu";

export type Lang = "ur" | "en";

/** Language used the first time a rider opens the app. */
const DEFAULT_LANG: Lang = "en";
const STORAGE_KEY = "dropex.rider.lang";

function readStored(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ur" || v === "en") return v;
  } catch {
    /* storage blocked */
  }
  return DEFAULT_LANG;
}

let lang: Lang = readStored();
const listeners = new Set<() => void>();

/** Sets <html lang> and <html dir> so the whole layout flips to right-to-left for Urdu. */
function applyToDocument(): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ur" ? "rtl" : "ltr";
}
applyToDocument();

export function getLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  applyToDocument();
  listeners.forEach((fn) => fn());
}

/** Call once in the top component so the whole tree re-renders when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lang,
  );
}

/** Translate. `vars` fills {name} placeholders. Unknown text is returned unchanged. */
export function tr(en: string, vars?: Record<string, string | number>): string {
  let s = lang === "ur" ? (UR[en] ?? en) : en;
  if (vars) for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}

/** Locale for dates/times. Latin digits are kept in Urdu (that is how riders read numbers in Pakistan). */
export function locale(): string {
  return lang === "ur" ? "ur-PK-u-nu-latn" : "en-PK";
}
