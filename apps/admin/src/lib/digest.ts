/**
 * Error mapping for the AI daily digest screen. Pure function, no I/O.
 */
import { ApiError } from "./api.js";

/** Friendly copy for the digest endpoint's budget/role failures. */
export function digestErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429 && err.code === "AI_BUDGET_EXCEEDED") {
      return "Today's AI budget has been used up, so the digest can't be generated right now. It will be back tomorrow — the underlying numbers are still on the Dashboard and Finance pages.";
    }
    if (err.status === 403) {
      return "The daily digest is available to manager and owner roles only. Ask an owner to upgrade your role if you need access.";
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Failed to load the daily digest.";
}
