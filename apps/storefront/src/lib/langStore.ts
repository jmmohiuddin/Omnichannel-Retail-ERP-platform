/**
 * Storefront language store: persists the shopper's language choice to
 * localStorage, notifies React subscribers (via useSyncExternalStore in
 * useLang.ts), and keeps `<html lang dir>` in sync — `dir="rtl"` for Arabic
 * so the logical-property stylesheet flips the whole layout with no CSS work.
 */
import type { Lang } from "./i18n.js";

export const LANG_STORAGE_KEY = "omniretail.storefront.lang";

/** Minimal Storage surface so tests can stub persistence. */
export interface LangStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "ar";
}

/** Writing direction for a language — Arabic is right-to-left. */
export function dirFor(lang: Lang): "ltr" | "rtl" {
  return lang === "ar" ? "rtl" : "ltr";
}

/**
 * Reflect the language onto the document root. Guarded so the module is safe
 * to import (and unit-test) where no DOM exists.
 */
export function applyDocumentLang(lang: Lang): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang;
  document.documentElement.dir = dirFor(lang);
}

export class LangStore {
  private lang: Lang;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: LangStorage,
    private readonly onChange: (lang: Lang) => void = applyDocumentLang,
  ) {
    let stored: string | null = null;
    try {
      stored = storage.getItem(LANG_STORAGE_KEY);
    } catch {
      /* storage unavailable — default language */
    }
    this.lang = isLang(stored) ? stored : "en";
    this.onChange(this.lang);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getLang = (): Lang => this.lang;

  setLang = (lang: Lang): void => {
    if (lang === this.lang) return;
    this.lang = lang;
    try {
      this.storage.setItem(LANG_STORAGE_KEY, lang);
    } catch {
      /* storage full / private mode — choice lasts for the session */
    }
    this.onChange(lang);
    for (const listener of this.listeners) listener();
  };
}

function browserStorage(): LangStorage {
  try {
    const s = window.localStorage;
    const probe = LANG_STORAGE_KEY + ".__probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
    };
  }
}

let singleton: LangStore | null = null;

/** Shared app-wide language store (created lazily, applies lang/dir on boot). */
export function getLangStore(): LangStore {
  if (!singleton) singleton = new LangStore(browserStorage());
  return singleton;
}
