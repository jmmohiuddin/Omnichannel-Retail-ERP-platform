/**
 * React bindings for the i18n dictionary + language store. Follows the app's
 * existing store pattern (useSyncExternalStore over a subscribe API) — no
 * context provider needed because the store is module-global, exactly like
 * the auth session store.
 */
import { useMemo, useSyncExternalStore } from "react";
import { enumLabel, t, type Lang, type MessageKey, type MessageParams } from "./i18n.js";
import { getLang, subscribe } from "./langStore.js";

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

export interface Translator {
  lang: Lang;
  /** Translate a dictionary key with optional `{name}` interpolation params. */
  t: (key: MessageKey, params?: MessageParams) => string;
  /** Label a server enum value, e.g. tEnum("status", order.status). */
  tEnum: (prefix: string, value: string) => string;
}

/** Subscribe to the current language and get bound translation helpers. */
export function useT(): Translator {
  const lang = useLang();
  return useMemo<Translator>(
    () => ({
      lang,
      t: (key, params) => t(lang, key, params),
      tEnum: (prefix, value) => enumLabel(lang, prefix, value),
    }),
    [lang],
  );
}
