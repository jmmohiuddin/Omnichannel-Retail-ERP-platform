/**
 * Current-language store, mirroring the auth store pattern: in-memory fast
 * path + localStorage persistence, framework-free subscribe API
 * (useSyncExternalStore-compatible). Switching languages also stamps
 * `document.documentElement.lang`/`dir` — the stylesheet uses logical CSS
 * properties throughout, so `dir="rtl"` alone mirrors the layout.
 */
import type { Lang } from "./i18n.js";

const STORAGE_KEY = "omniretail.admin.lang";
const DEFAULT_LANG: Lang = "en";

let current: Lang = DEFAULT_LANG;
let hydrated = false;
const listeners = new Set<() => void>();

function storage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** Pure mapping from language to document attributes — unit-testable without a DOM. */
export function docAttrsFor(lang: Lang): { lang: Lang; dir: "ltr" | "rtl" } {
  return { lang, dir: lang === "ar" ? "rtl" : "ltr" };
}

/** Apply lang/dir to <html>. Guarded so node/vitest (no DOM) never throws. */
export function applyDocumentLang(lang: Lang): void {
  if (typeof document === "undefined") return;
  const attrs = docAttrsFor(lang);
  document.documentElement.lang = attrs.lang;
  document.documentElement.dir = attrs.dir;
}

/** Current language — hydrates from localStorage on first call. */
export function getLang(): Lang {
  if (!hydrated) {
    hydrated = true;
    const raw = storage()?.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "ar") current = raw;
  }
  return current;
}

export function setLang(lang: Lang): void {
  hydrated = true;
  current = lang;
  storage()?.setItem(STORAGE_KEY, lang);
  applyDocumentLang(lang);
  for (const fn of listeners) fn();
}

export function toggleLang(): void {
  setLang(getLang() === "en" ? "ar" : "en");
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test hook: reset module state between test cases. */
export function resetLangForTests(): void {
  current = DEFAULT_LANG;
  hydrated = false;
  listeners.clear();
}
