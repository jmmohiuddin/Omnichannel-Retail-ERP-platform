import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDocumentLang,
  docAttrsFor,
  getLang,
  resetLangForTests,
  setLang,
  subscribe,
  toggleLang,
} from "./langStore.js";

const STORAGE_KEY = "omniretail.admin.lang";

/** Minimal localStorage stand-in for the node test environment (no jsdom). */
function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

let store: ReturnType<typeof makeStorage>;

beforeEach(() => {
  resetLangForTests();
  store = makeStorage();
  vi.stubGlobal("localStorage", store);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetLangForTests();
});

describe("language round-trip", () => {
  it("defaults to English", () => {
    expect(getLang()).toBe("en");
  });

  it("setLang persists to localStorage and notifies subscribers", () => {
    const seen: string[] = [];
    subscribe(() => seen.push(getLang()));

    setLang("ar");

    expect(getLang()).toBe("ar");
    expect(store.getItem(STORAGE_KEY)).toBe("ar");
    expect(seen).toEqual(["ar"]);
  });

  it("rehydrates the persisted language after a reload", () => {
    store.setItem(STORAGE_KEY, "ar");
    resetLangForTests(); // simulate a fresh module load (page reload)
    expect(getLang()).toBe("ar");
  });

  it("ignores corrupt persisted values and falls back to English", () => {
    store.setItem(STORAGE_KEY, "fr");
    resetLangForTests();
    expect(getLang()).toBe("en");
  });

  it("toggleLang flips en → ar → en", () => {
    toggleLang();
    expect(getLang()).toBe("ar");
    toggleLang();
    expect(getLang()).toBe("en");
  });

  it("works without localStorage (memory only)", () => {
    vi.unstubAllGlobals();
    resetLangForTests();
    setLang("ar");
    expect(getLang()).toBe("ar");
  });
});

describe("document direction side-effect", () => {
  it("docAttrsFor maps ar → rtl and en → ltr (pure logic)", () => {
    expect(docAttrsFor("ar")).toEqual({ lang: "ar", dir: "rtl" });
    expect(docAttrsFor("en")).toEqual({ lang: "en", dir: "ltr" });
  });

  it("setLang stamps documentElement.lang/dir when a document exists", () => {
    const fakeDoc = { documentElement: { lang: "en", dir: "ltr" } };
    vi.stubGlobal("document", fakeDoc);

    setLang("ar");
    expect(fakeDoc.documentElement.lang).toBe("ar");
    expect(fakeDoc.documentElement.dir).toBe("rtl");

    setLang("en");
    expect(fakeDoc.documentElement.lang).toBe("en");
    expect(fakeDoc.documentElement.dir).toBe("ltr");
  });

  it("applyDocumentLang is a no-op without a DOM (guarded, never throws)", () => {
    expect(typeof document).toBe("undefined");
    expect(() => applyDocumentLang("ar")).not.toThrow();
    expect(() => setLang("ar")).not.toThrow(); // setLang calls it internally
  });
});
