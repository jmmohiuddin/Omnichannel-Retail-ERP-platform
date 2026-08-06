/**
 * Thin React binding over the app-wide langStore singleton (screens layer —
 * src/lib stays framework-free and node-testable).
 */
import { useSyncExternalStore } from "react";
import type { Lang } from "../lib/i18n";
import { langStore } from "../lib/services";

const subscribe = (onStoreChange: () => void) => langStore.subscribe(() => onStoreChange());
const getSnapshot = () => langStore.get();

/** Current UI language; re-renders the screen on toggle. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Flip between English and Arabic. */
export function toggleLang(): void {
  langStore.set(langStore.get() === "en" ? "ar" : "en");
}
