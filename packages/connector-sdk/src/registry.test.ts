import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "./registry.js";
import type { Connector, ConnectorCapabilities } from "./types.js";

function stubConnector(
  key: string,
  capabilities: Partial<ConnectorCapabilities> = {},
): Connector {
  return {
    key,
    capabilities: {
      inventorySync: false,
      orderImport: false,
      priceSync: false,
      listingPublish: false,
      statusSync: false,
      ...capabilities,
    },
    verifyCredentials: async () => ({ ok: true, status: "healthy" }),
    pushInventory: async () => [],
    pullOrders: async () => [],
  };
}

describe("ConnectorRegistry", () => {
  it("registers and retrieves connectors by key", () => {
    const registry = new ConnectorRegistry();
    const noon = stubConnector("noon");
    registry.register(noon);
    expect(registry.get("noon")).toBe(noon);
    expect(registry.get("amazon-ae")).toBeUndefined();
  });

  it("rejects duplicate keys", () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector("noon"));
    expect(() => registry.register(stubConnector("noon"))).toThrow(
      /already registered/,
    );
  });

  it("lists all connectors when no filter is given", () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector("a"));
    registry.register(stubConnector("b"));
    expect(registry.list().map((c) => c.key)).toEqual(["a", "b"]);
  });

  it("filters by a single capability", () => {
    const registry = new ConnectorRegistry();
    registry.register(stubConnector("inv", { inventorySync: true }));
    registry.register(stubConnector("orders", { orderImport: true }));
    expect(
      registry.list({ inventorySync: true }).map((c) => c.key),
    ).toEqual(["inv"]);
  });

  it("requires ALL requested capabilities and ignores false entries in the filter", () => {
    const registry = new ConnectorRegistry();
    registry.register(
      stubConnector("full", { inventorySync: true, orderImport: true }),
    );
    registry.register(stubConnector("inv-only", { inventorySync: true }));
    expect(
      registry
        .list({ inventorySync: true, orderImport: true })
        .map((c) => c.key),
    ).toEqual(["full"]);
    // orderImport: false must not exclude connectors that DO import orders
    expect(
      registry
        .list({ inventorySync: true, orderImport: false })
        .map((c) => c.key),
    ).toEqual(["full", "inv-only"]);
  });
});
