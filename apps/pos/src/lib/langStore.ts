/**
 * Register-local language persistence, mirroring lib/session.ts: localStorage
 * for v1, swapped for the Tauri shell's storage later. Pure module (no React)
 * so it is unit-testable in node — both `localStorage` and `document` access
 * are guarded for non-browser environments.
 */
import type { Lang } from "./i18n.js";

const LANG_KEY = "omniretail.pos.lang";
const DEFAULT_LANG: Lang = "en";

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "ar";
}

export function loadLang(): Lang {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_LANG;
    const raw = localStorage.getItem(LANG_KEY);
    return isLang(raw) ? raw : DEFAULT_LANG;
  } catch {
    return DEFAULT_LANG;
  }
}

export function saveLang(lang: Lang): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* storage full/unavailable — the in-memory language still applies */
  }
}

/** Writing direction for a language — Arabic is the only RTL script here. */
export function dirFor(lang: Lang): "ltr" | "rtl" {
  return lang === "ar" ? "rtl" : "ltr";
}

/**
 * Reflect the language onto <html lang dir> so the whole app (and the
 * logical-property CSS) flips direction. No-op outside the browser.
 */
export function applyLangToDocument(lang: Lang): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = dirFor(lang);
}
