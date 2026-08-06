import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthApiError,
  getSession,
  login,
  registerTenant,
  resetAuthForTests,
  setSession,
  signOut,
  subscribe,
  accessToken,
} from "./auth.js";

const STORAGE_KEY = "omniretail.admin.session";

/** Minimal localStorage stand-in for the node test environment. */
function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

const TOKENS = {
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  userId: "user-1",
  tenantId: "tenant-1",
};

let store: ReturnType<typeof makeStorage>;

beforeEach(() => {
  resetAuthForTests();
  store = makeStorage();
  vi.stubGlobal("localStorage", store);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthForTests();
});

function mockFetchOk(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("login round-trip", () => {
  it("posts credentials, stores the session in memory and localStorage", async () => {
    const fetchMock = mockFetchOk(TOKENS);

    const session = await login("deira-mobiles", "owner@example.ae", "s3cret-pass!");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3001/v1/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      slug: "deira-mobiles",
      email: "owner@example.ae",
      password: "s3cret-pass!",
    });

    expect(session.tenantId).toBe("tenant-1");
    expect(getSession()).toEqual({
      ...TOKENS,
      slug: "deira-mobiles",
      email: "owner@example.ae",
    });
    expect(accessToken()).toBe("access-token-1");

    const persisted = JSON.parse(store.getItem(STORAGE_KEY) ?? "null");
    expect(persisted).toEqual(getSession());
  });

  it("rehydrates the session from localStorage after a reload", () => {
    const session = { ...TOKENS, slug: "deira-mobiles", email: "owner@example.ae" };
    store.setItem(STORAGE_KEY, JSON.stringify(session));
    resetAuthForTests(); // simulate a fresh module load (page reload)

    expect(getSession()).toEqual(session);
  });

  it("ignores corrupt persisted sessions", () => {
    store.setItem(STORAGE_KEY, "{not json");
    resetAuthForTests();
    expect(getSession()).toBeNull();

    store.setItem(STORAGE_KEY, JSON.stringify({ accessToken: "x" }));
    resetAuthForTests();
    expect(getSession()).toBeNull();
  });

  it("signOut clears memory and localStorage and notifies subscribers", async () => {
    mockFetchOk(TOKENS);
    await login("deira-mobiles", "owner@example.ae", "s3cret-pass!");

    const seen: (string | null)[] = [];
    subscribe(() => seen.push(accessToken()));

    signOut();

    expect(getSession()).toBeNull();
    expect(store.getItem(STORAGE_KEY)).toBeNull();
    expect(seen).toEqual([null]);
  });

  it("throws AuthApiError with the API error code on failure", async () => {
    mockFetchOk({ error: "INVALID_CREDENTIALS" }, 401);

    await expect(login("deira-mobiles", "owner@example.ae", "wrong")).rejects.toMatchObject({
      name: "AuthApiError",
      status: 401,
      code: "INVALID_CREDENTIALS",
    });
    expect(getSession()).toBeNull();
  });
});

describe("registerTenant", () => {
  it("stores a session from the onboarding response", async () => {
    const fetchMock = mockFetchOk(TOKENS, 201);

    await registerTenant({
      tenantName: "Deira Mobiles",
      slug: "deira-mobiles",
      fullName: "A. Owner",
      email: "owner@example.ae",
      password: "s3cret-pass!",
    });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://localhost:3001/v1/auth/register");
    expect(getSession()?.slug).toBe("deira-mobiles");
    expect(getSession()?.accessToken).toBe("access-token-1");
  });
});

describe("setSession", () => {
  it("AuthApiError carries a readable message", () => {
    const err = new AuthApiError(409, "SLUG_TAKEN");
    expect(err.message).toContain("SLUG_TAKEN");
    expect(err.message).toContain("409");
  });

  it("works without localStorage (memory only)", () => {
    vi.unstubAllGlobals();
    resetAuthForTests();
    const session = { ...TOKENS, slug: "s", email: "e@example.ae" };
    setSession(session);
    expect(getSession()).toEqual(session);
    signOut();
    expect(getSession()).toBeNull();
  });
});
