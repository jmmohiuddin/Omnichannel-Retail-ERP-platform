import { useSyncExternalStore } from "react";
import type { Lang } from "./i18n.js";
import { getLangStore } from "./langStore.js";

export interface LangView {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

/** Subscribe to the shopper's language; re-renders on toggle. */
export function useLang(): LangView {
  const store = getLangStore();
  const lang = useSyncExternalStore(store.subscribe, store.getLang, store.getLang);
  return { lang, setLang: store.setLang };
}
