/**
 * In-process connector registry. The host registers every loaded connector
 * package here and the sync engine looks connectors up by key or by the
 * capabilities it is about to schedule work for.
 */
import type { Connector, ConnectorCapabilities } from "./types.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  /** Register a connector. Keys are stable and never reused — duplicates throw. */
  register(connector: Connector): void {
    if (this.connectors.has(connector.key)) {
      throw new Error(`connector already registered: ${connector.key}`);
    }
    this.connectors.set(connector.key, connector);
  }

  get(key: string): Connector | undefined {
    return this.connectors.get(key);
  }

  /**
   * List registered connectors. When `withCapabilities` is given, only
   * connectors declaring `true` for EVERY requested capability are returned
   * (capabilities set to `false`/omitted in the filter are not constrained).
   */
  list(withCapabilities?: Partial<ConnectorCapabilities>): Connector[] {
    const all = [...this.connectors.values()];
    if (!withCapabilities) return all;
    const required = (
      Object.keys(withCapabilities) as Array<keyof ConnectorCapabilities>
    ).filter((k) => withCapabilities[k] === true);
    return all.filter((c) => required.every((k) => c.capabilities[k]));
  }
}
