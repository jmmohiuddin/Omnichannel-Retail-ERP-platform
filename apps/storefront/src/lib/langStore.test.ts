import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lang } from "./i18n.js";
import {
  applyDocumentLang,
  dirFor,
  isLang,
  LANG_STORAGE_KEY,
  LangStore,
  type LangStorage,
} from "./langStore.js";

function memoryStorage(initial: Record<string, string> = {}): LangStorage & {
  dump(): Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dirFor / isLang", () => {
  it("maps Arabic to rtl and English to ltr", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });

  it("accepts only supported language codes", () => {
    expect(isLang("en")).toBe(true);
    expect(isLang("ar")).toBe(true);
    expect(isLang("fr")).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

describe("LangStore", () => {
  it("defaults to English and persists a language change", () => {
    const storage = memoryStorage();
    const store = new LangStore(storage, () => {});
    expect(store.getLang()).toBe("en");

    store.setLang("ar");
    expect(store.getLang()).toBe("ar");
    expect(storage.dump()[LANG_STORAGE_KEY]).toBe("ar");
  });

  it("restores a stored language and ignores corrupt values", () => {
    expect(new LangStore(memoryStorage({ [LANG_STORAGE_KEY]: "ar" }), () => {}).getLang()).toBe(
      "ar",
    );
    expect(
      new LangStore(memoryStorage({ [LANG_STORAGE_KEY]: "zz" }), () => {}).getLang(),
    ).toBe("en");
  });

  it("notifies subscribers on change (not on same-value sets) and honours unsubscribe", () => {
    const store = new LangStore(memoryStorage(), () => {});
    const seen: Lang[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getLang()));

    store.setLang("en"); // no-op: already English
    store.setLang("ar");
    expect(seen).toEqual(["ar"]);

    unsubscribe();
    store.setLang("en");
    expect(seen).toEqual(["ar"]);
  });

  it("applies lang/dir to the document on construction and on change", () => {
    const documentElement = { lang: "", dir: "" };
    vi.stubGlobal("document", { documentElement });

    const store = new LangStore(memoryStorage({ [LANG_STORAGE_KEY]: "ar" }));
    expect(documentElement.lang).toBe("ar");
    expect(documentElement.dir).toBe("rtl");

    store.setLang("en");
    expect(documentElement.lang).toBe("en");
    expect(documentElement.dir).toBe("ltr");
  });

  it("applyDocumentLang is a safe no-op when no DOM exists", () => {
    expect(typeof document).toBe("undefined"); // node test environment
    expect(() => applyDocumentLang("ar")).not.toThrow();
  });
});
