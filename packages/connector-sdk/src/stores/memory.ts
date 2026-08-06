/**
 * Test doubles: an in-memory ConnectorStateStore and a programmable FakeHttp
 * transport. Both are pure in-process objects — no real I/O — so connector
 * unit tests stay fast and deterministic.
 */
import type {
  ConnectorHttp,
  ConnectorStateStore,
  HttpResponse,
} from "../types.js";

export class MemoryStateStore implements ConnectorStateStore {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  /** Synchronous peek for test assertions. */
  peek(key: string): string | null {
    return this.data.get(key) ?? null;
  }
}

export type HttpMethod = "GET" | "POST" | "PUT";

/** A request the FakeHttp recorded. */
export interface RecordedRequest {
  method: HttpMethod;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler =
  | HttpResponse
  | ((req: RecordedRequest) => HttpResponse | Promise<HttpResponse>);

interface Route {
  method: HttpMethod;
  match: string | RegExp;
  handler: RouteHandler;
}

/**
 * Programmable ConnectorHttp double. Register routes with `on()`; every
 * request is recorded in `requests` for assertions. A string match is a
 * prefix match on the URL; a RegExp is tested against the full URL. The most
 * recently registered matching route wins. Unmatched requests return 404.
 */
export class FakeHttp implements ConnectorHttp {
  readonly requests: RecordedRequest[] = [];
  private readonly routes: Route[] = [];

  on(method: HttpMethod, match: string | RegExp, handler: RouteHandler): this {
    this.routes.push({ method, match, handler });
    return this;
  }

  /** Requests recorded for one method (convenience for assertions). */
  requestsTo(method: HttpMethod, match: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (r) => r.method === method && this.matches(match, r.url),
    );
  }

  async get(
    url: string,
    headers?: Record<string, string>,
  ): Promise<HttpResponse> {
    return this.dispatch({ method: "GET", url, headers });
  }

  async post(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse> {
    return this.dispatch({ method: "POST", url, body, headers });
  }

  async put(
    url: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpResponse> {
    return this.dispatch({ method: "PUT", url, body, headers });
  }

  private async dispatch(req: RecordedRequest): Promise<HttpResponse> {
    this.requests.push(req);
    for (let i = this.routes.length - 1; i >= 0; i--) {
      const route = this.routes[i]!;
      if (route.method === req.method && this.matches(route.match, req.url)) {
        return typeof route.handler === "function"
          ? route.handler(req)
          : route.handler;
      }
    }
    return { status: 404, body: { error: `no fake route for ${req.method} ${req.url}` } };
  }

  private matches(match: string | RegExp, url: string): boolean {
    return typeof match === "string" ? url.startsWith(match) : match.test(url);
  }
}
