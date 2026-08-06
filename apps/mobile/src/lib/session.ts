/**
 * In-memory session store with a subscribe API (usable from React via
 * useSyncExternalStore) and an injectable persistence interface.
 *
 * TODO(persistence): add an AsyncStorage adapter implementing
 * SessionPersistence with @react-native-async-storage/async-storage once that
 * dependency is added — deliberately not included yet so the logic layer stays
 * free of native modules. Wire it as
 * `createSessionStore(asyncStorageAdapter)` in App.tsx and call `restore()`
 * on boot.
 */

export interface SessionData {
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
  slug: string;
  email: string;
}

/** Pluggable storage backend. All methods are async to fit AsyncStorage. */
export interface SessionPersistence {
  load(): Promise<SessionData | null>;
  save(session: SessionData): Promise<void>;
  clear(): Promise<void>;
}

export type SessionListener = (session: SessionData | null) => void;

export interface SessionStore {
  get(): SessionData | null;
  /** Access token for the Authorization header, or null when signed out. */
  getToken(): string | null;
  signIn(session: SessionData): void;
  signOut(): void;
  /** Load a persisted session (no-op without a persistence backend). */
  restore(): Promise<SessionData | null>;
  /** Returns an unsubscribe function. Listener fires on every state change. */
  subscribe(listener: SessionListener): () => void;
}

export function createSessionStore(persistence?: SessionPersistence): SessionStore {
  let current: SessionData | null = null;
  const listeners = new Set<SessionListener>();

  function notify(): void {
    for (const listener of listeners) listener(current);
  }

  return {
    get: () => current,
    getToken: () => current?.accessToken ?? null,

    signIn(session: SessionData): void {
      current = session;
      notify();
      // Fire-and-forget: persistence failures must never block sign-in.
      void persistence?.save(session).catch(() => {});
    },

    signOut(): void {
      current = null;
      notify();
      void persistence?.clear().catch(() => {});
    },

    async restore(): Promise<SessionData | null> {
      if (!persistence) return null;
      try {
        const stored = await persistence.load();
        if (stored && typeof stored.accessToken === "string") {
          current = stored;
          notify();
          return stored;
        }
      } catch {
        /* corrupt or unreadable persisted session — stay signed out */
      }
      return null;
    },

    subscribe(listener: SessionListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
