import { describe, expect, it } from "vitest";
import type { Lang } from "./i18n";
import { createLangStore, isLangValue, type LangPersistence } from "./langStore";

function memoryPersistence(initial: Lang | null = null) {
  let stored = initial;
  const ops: string[] = [];
  const persistence: LangPersistence = {
    async load() {
      ops.push("load");
      return stored;
    },
    async save(lang) {
      ops.push("save");
      stored = lang;
    },
  };
  return { persistence, ops, stored: () => stored };
}

describe("langStore", () => {
  it("defaults to English and toggles to Arabic", () => {
    const store = createLangStore();
    expect(store.get()).toBe("en");
    store.set("ar");
    expect(store.get()).toBe("ar");
  });

  it("notifies subscribers on change (not on same-value sets) and honours unsubscribe", () => {
    const store = createLangStore();
    const seen: Lang[] = [];
    const unsubscribe = store.subscribe((lang) => seen.push(lang));

    store.set("en"); // no-op: already English
    store.set("ar");
    expect(seen).toEqual(["ar"]);

    unsubscribe();
    store.set("en");
    expect(seen).toEqual(["ar"]);
  });

  it("set() writes through to the persistence backend", async () => {
    const { persistence, ops, stored } = memoryPersistence();
    const store = createLangStore(persistence);

    store.set("ar");
    await Promise.resolve(); // let the fire-and-forget save settle
    expect(stored()).toBe("ar");
    expect(ops).toEqual(["save"]);
  });

  it("restore() loads a persisted language and notifies", async () => {
    const { persistence } = memoryPersistence("ar");
    const store = createLangStore(persistence);
    const seen: Lang[] = [];
    store.subscribe((lang) => seen.push(lang));

    expect(await store.restore()).toBe("ar");
    expect(store.get()).toBe("ar");
    expect(seen).toEqual(["ar"]);
  });

  it("restore() ignores corrupt values and works without a backend", async () => {
    const store = createLangStore({
      async load() {
        return "zz" as unknown as Lang; // corrupt persisted value
      },
      async save() {},
    });
    expect(await store.restore()).toBe("en");
    expect(await createLangStore().restore()).toBe("en");
  });

  it("isLangValue accepts only supported codes", () => {
    expect(isLangValue("en")).toBe(true);
    expect(isLangValue("ar")).toBe(true);
    expect(isLangValue("fr")).toBe(false);
    expect(isLangValue(null)).toBe(false);
  });
});
