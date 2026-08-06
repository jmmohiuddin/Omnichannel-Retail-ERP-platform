import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyLangToDocument, dirFor, isLang, loadLang, saveLang } from "./langStore.js";

/** Minimal localStorage double for the node test environment. */
function memoryLocalStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("langStore — persistence", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryLocalStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to English when nothing is stored", () => {
    expect(loadLang()).toBe("en");
  });

  it("round-trips the saved language", () => {
    saveLang("ar");
    expect(loadLang()).toBe("ar");
    saveLang("en");
    expect(loadLang()).toBe("en");
  });

  it("falls back to English for corrupt stored values", () => {
    localStorage.setItem("omniretail.pos.lang", "fr");
    expect(loadLang()).toBe("en");
  });

  it("isLang accepts only en/ar", () => {
    expect(isLang("en")).toBe(true);
    expect(isLang("ar")).toBe(true);
    expect(isLang("fr")).toBe(false);
    expect(isLang(null)).toBe(false);
  });
});

describe("langStore — node environment guards", () => {
  // The vitest environment is node: neither localStorage nor document exist.
  it("loadLang/saveLang do not throw without localStorage", () => {
    expect(typeof localStorage).toBe("undefined");
    expect(loadLang()).toBe("en");
    expect(() => saveLang("ar")).not.toThrow();
  });

  it("applyLangToDocument is a no-op without a document", () => {
    expect(typeof document).toBe("undefined");
    expect(() => applyLangToDocument("ar")).not.toThrow();
  });
});

describe("langStore — direction logic", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Arabic is RTL, English is LTR", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
  });

  it("applyLangToDocument stamps <html lang dir> for Arabic and back", () => {
    const documentElement = { lang: "en", dir: "ltr" };
    vi.stubGlobal("document", { documentElement });

    applyLangToDocument("ar");
    expect(documentElement.lang).toBe("ar");
    expect(documentElement.dir).toBe("rtl");

    applyLangToDocument("en");
    expect(documentElement.lang).toBe("en");
    expect(documentElement.dir).toBe("ltr");
  });
});
