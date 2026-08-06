import { describe, expect, it } from "vitest";
import {
  createSessionStore,
  type SessionData,
  type SessionPersistence,
} from "./session";

const SESSION: SessionData = {
  accessToken: "at",
  refreshToken: "rt",
  userId: "user-1",
  tenantId: "tenant-1",
  slug: "acme",
  email: "owner@acme.ae",
};

function memoryPersistence(initial: SessionData | null = null) {
  let stored = initial;
  const ops: string[] = [];
  const persistence: SessionPersistence = {
    async load() {
      ops.push("load");
      return stored;
    },
    async save(s) {
      ops.push("save");
      stored = s;
    },
    async clear() {
      ops.push("clear");
      stored = null;
    },
  };
  return { persistence, ops, stored: () => stored };
}

describe("session store", () => {
  it("round-trips signIn → get/getToken → signOut", () => {
    const store = createSessionStore();
    expect(store.get()).toBeNull();
    expect(store.getToken()).toBeNull();

    store.signIn(SESSION);
    expect(store.get()).toEqual(SESSION);
    expect(store.getToken()).toBe("at");

    store.signOut();
    expect(store.get()).toBeNull();
    expect(store.getToken()).toBeNull();
  });

  it("notifies subscribers on every change and honours unsubscribe", () => {
    const store = createSessionStore();
    const seen: Array<string | null> = [];
    const unsubscribe = store.subscribe((s) => seen.push(s?.userId ?? null));

    store.signIn(SESSION);
    store.signOut();
    expect(seen).toEqual(["user-1", null]);

    unsubscribe();
    store.signIn(SESSION);
    expect(seen).toEqual(["user-1", null]); // no further notifications
  });

  it("restore() loads a persisted session and notifies", async () => {
    const { persistence } = memoryPersistence(SESSION);
    const store = createSessionStore(persistence);
    const seen: Array<string | null> = [];
    store.subscribe((s) => seen.push(s?.userId ?? null));

    const restored = await store.restore();
    expect(restored).toEqual(SESSION);
    expect(store.getToken()).toBe("at");
    expect(seen).toEqual(["user-1"]);
  });

  it("signIn/signOut write through to the persistence backend", async () => {
    const { persistence, ops, stored } = memoryPersistence();
    const store = createSessionStore(persistence);

    store.signIn(SESSION);
    await Promise.resolve(); // let the fire-and-forget save settle
    expect(stored()).toEqual(SESSION);

    store.signOut();
    await Promise.resolve();
    expect(stored()).toBeNull();
    expect(ops).toEqual(["save", "clear"]);
  });

  it("restore() without a persistence backend resolves null", async () => {
    const store = createSessionStore();
    expect(await store.restore()).toBeNull();
  });
});
