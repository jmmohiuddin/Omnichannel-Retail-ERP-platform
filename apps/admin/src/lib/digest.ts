/**
 * Error mapping for the AI daily digest screen. Pure function, no I/O.
 */
import { ApiError } from "./api.js";
import { t, type Lang } from "./i18n.js";

/** Friendly copy for the digest endpoint's budget/role failures. */
export function digestErrorMessage(err: unknown, lang: Lang = "en"): string {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.code === "AI_BUDGET_EXCEEDED") {
      return t(lang, "digest.budgetExceeded");
    }
    if (err.status === 403) {
      return t(lang, "digest.forbidden");
    }
    return err.message;
  }
  return err instanceof Error ? err.message : t(lang, "digest.loadFailed");
}
