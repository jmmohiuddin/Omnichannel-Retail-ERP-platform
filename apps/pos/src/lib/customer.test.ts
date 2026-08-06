import { describe, expect, it } from "vitest";
import type { CustomerSummary, LoyaltyBalance } from "./api.js";
import {
  customerPanelReducer,
  initialCustomerPanelState,
  type CustomerPanelState,
} from "./customer.js";

const amina: CustomerSummary = {
  id: "c-1",
  fullName: "Amina Khan",
  phone: "+971501234567",
  email: null,
  loyaltyPoints: 420,
};

const balance: LoyaltyBalance = { points: 420, valueMinor: 4_200, history: [] };

function reduce(
  state: CustomerPanelState,
  ...actions: Parameters<typeof customerPanelReducer>[1][]
): CustomerPanelState {
  return actions.reduce(customerPanelReducer, state);
}

describe("customerPanelReducer — search/attach state", () => {
  it("typing a query marks searching; results land and stop it", () => {
    let s = reduce(initialCustomerPanelState, { type: "query", query: "amina" });
    expect(s).toMatchObject({ query: "amina", searching: true });
    s = reduce(s, { type: "results", items: [amina] });
    expect(s.searching).toBe(false);
    expect(s.results).toEqual([amina]);
  });

  it("clearing the query drops stale results", () => {
    let s = reduce(
      initialCustomerPanelState,
      { type: "query", query: "amina" },
      { type: "results", items: [amina] },
      { type: "query", query: "" },
    );
    expect(s.results).toEqual([]);
    expect(s.searching).toBe(false);
  });

  it("attach stores the customer and clears the search UI", () => {
    const s = reduce(
      initialCustomerPanelState,
      { type: "query", query: "amina" },
      { type: "results", items: [amina] },
      { type: "attach", customer: amina },
    );
    expect(s.attached).toEqual(amina);
    expect(s.query).toBe("");
    expect(s.results).toEqual([]);
    expect(s.loyalty).toBeNull(); // fetched fresh after attach
    expect(s.loyaltyApplied).toBe(false);
  });

  it("detach clears the customer, the balance and any armed loyalty tender", () => {
    const s = reduce(
      initialCustomerPanelState,
      { type: "attach", customer: amina },
      { type: "loyalty-loaded", balance },
      { type: "toggle-loyalty" },
      { type: "detach" },
    );
    expect(s.attached).toBeNull();
    expect(s.loyalty).toBeNull();
    expect(s.loyaltyApplied).toBe(false);
  });

  it("loyalty can only be armed once a positive balance is loaded", () => {
    let s = reduce(initialCustomerPanelState, { type: "attach", customer: amina });
    expect(reduce(s, { type: "toggle-loyalty" }).loyaltyApplied).toBe(false); // not loaded yet
    s = reduce(s, { type: "loyalty-loaded", balance: { points: 0, valueMinor: 0, history: [] } });
    expect(reduce(s, { type: "toggle-loyalty" }).loyaltyApplied).toBe(false); // zero value
    s = reduce(s, { type: "loyalty-loaded", balance });
    s = reduce(s, { type: "toggle-loyalty" });
    expect(s.loyaltyApplied).toBe(true);
    expect(reduce(s, { type: "toggle-loyalty" }).loyaltyApplied).toBe(false); // toggles off
  });

  it("a refreshed zero balance (INSUFFICIENT_POINTS) disarms the loyalty tender", () => {
    const s = reduce(
      initialCustomerPanelState,
      { type: "attach", customer: amina },
      { type: "loyalty-loaded", balance },
      { type: "toggle-loyalty" },
      { type: "loyalty-loaded", balance: { points: 0, valueMinor: 0, history: [] } },
    );
    expect(s.loyaltyApplied).toBe(false);
    expect(s.loyalty?.valueMinor).toBe(0);
  });

  it("reset returns to the initial state after a completed sale", () => {
    const s = reduce(
      initialCustomerPanelState,
      { type: "attach", customer: amina },
      { type: "loyalty-loaded", balance },
      { type: "reset" },
    );
    expect(s).toEqual(initialCustomerPanelState);
  });
});
