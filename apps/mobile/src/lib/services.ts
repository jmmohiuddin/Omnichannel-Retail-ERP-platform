/**
 * App-wide singletons wiring the logic layer together. Screens import these;
 * tests construct their own instances with injected fakes instead.
 */
import { createApiClient } from "./api";
import { createLangStore } from "./langStore";
import { createSessionStore } from "./session";

export const sessionStore = createSessionStore();

// In-memory for now, like sessionStore — pass an AsyncStorage-backed
// LangPersistence and call restore() on boot once that adapter exists.
export const langStore = createLangStore();

export const apiClient = createApiClient({
  getToken: () => sessionStore.getToken(),
  onUnauthorized: () => sessionStore.signOut(),
});
