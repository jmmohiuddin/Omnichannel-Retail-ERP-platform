/**
 * App-wide singletons wiring the logic layer together. Screens import these;
 * tests construct their own instances with injected fakes instead.
 */
import { createApiClient } from "./api";
import { createSessionStore } from "./session";

export const sessionStore = createSessionStore();

export const apiClient = createApiClient({
  getToken: () => sessionStore.getToken(),
  onUnauthorized: () => sessionStore.signOut(),
});
