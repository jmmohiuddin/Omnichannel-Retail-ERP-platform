import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { t as translate, type Lang, type MessageKey, type MessageParams } from "../lib/i18n.js";
import { applyLangToDocument, loadLang, saveLang } from "../lib/langStore.js";

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Translate in the current language: `t("cart.each", { price })`. */
  t: (key: MessageKey, params?: MessageParams) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

/**
 * App-wide language state. Persists via lib/langStore.ts and mirrors the
 * language onto <html lang dir> (rtl for Arabic) on every change, including
 * the initial mount (index.html ships lang="en" dir="ltr").
 */
export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => loadLang());

  useEffect(() => {
    applyLangToDocument(lang);
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    saveLang(next);
    setLangState(next);
  }, []);

  const value = useMemo<LangContextValue>(
    () => ({
      lang,
      setLang,
      t: (key, params) => translate(lang, key, params),
    }),
    [lang, setLang],
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (ctx === null) throw new Error("useLang must be used inside <LangProvider>");
  return ctx;
}

/**
 * Compact EN/عربي toggle. A plain button, so it sits in the normal tab order
 * (keyboard-reachable); the label shows the language it switches TO, in that
 * language's own script, with a translated aria-label.
 */
export function LangToggle() {
  const { lang, setLang, t } = useLang();
  const next: Lang = lang === "en" ? "ar" : "en";
  return (
    <button
      type="button"
      className="btn btn-ghost btn-small lang-toggle"
      lang={next}
      aria-label={t(next === "ar" ? "lang.switchToArabic" : "lang.switchToEnglish")}
      onClick={() => setLang(next)}
    >
      {next === "ar" ? "عربي" : "EN"}
    </button>
  );
}
