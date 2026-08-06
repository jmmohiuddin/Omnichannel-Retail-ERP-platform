/**
 * Language store following the session-store pattern: in-memory state with a
 * subscribe API (usable from React via useSyncExternalStore) and an
 * injectable async persistence backend (AsyncStorage adapter later — same
 * deliberate omission as session.ts, so src/lib stays free of native modules).
 *
 * Direction: React Native has no `document` to stamp `dir` on. Screens read
 * `isRtl(lang)` (from i18n.ts) and flip inline flexDirection instead. Full
 * native RTL via `I18nManager.forceRTL(true)` needs an app reload and is the
 * documented native step, intentionally not performed here.
 */
import type { Lang } from "./i18n";

/** Guard for values coming back from a persistence backend. */
export function isLangValue(value: unknown): value is Lang {
  return value === "en" || value === "ar";
}

/** Pluggable storage backend. Async to fit AsyncStorage. */
export interface LangPersistence {
  load(): Promise<Lang | null>;
  save(lang: Lang): Promise<void>;
}

export type LangListener = (lang: Lang) => void;

export interface LangStore {
  get(): Lang;
  set(lang: Lang): void;
  /** Load a persisted choice (no-op without a persistence backend). */
  restore(): Promise<Lang>;
  /** Returns an unsubscribe function. Listener fires on every change. */
  subscribe(listener: LangListener): () => void;
}

export function createLangStore(persistence?: LangPersistence): LangStore {
  let current: Lang = "en";
  const listeners = new Set<LangListener>();

  function notify(): void {
    for (const listener of listeners) listener(current);
  }

  return {
    get: () => current,

    set(lang: Lang): void {
      if (lang === current) return;
      current = lang;
      notify();
      // Fire-and-forget: persistence failures must never block a toggle.
      void persistence?.save(lang).catch(() => {});
    },

    async restore(): Promise<Lang> {
      if (!persistence) return current;
      try {
        const stored = await persistence.load();
        if (isLangValue(stored) && stored !== current) {
          current = stored;
          notify();
        }
      } catch {
        /* corrupt or unreadable stored value — keep the default */
      }
      return current;
    },

    subscribe(listener: LangListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
