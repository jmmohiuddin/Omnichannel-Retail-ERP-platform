/**
 * Pure state for the customer panel: search, attach/detach, loyalty balance
 * and whether loyalty is armed as a tender. Kept as a reducer (mirroring
 * cartReducer) so the flow is unit-testable without React.
 */
import type { CustomerSummary, LoyaltyBalance } from "./api.js";

export interface CustomerPanelState {
  query: string;
  results: CustomerSummary[];
  searching: boolean;
  attached: CustomerSummary | null;
  /** null until fetched (and again right after attach/refresh starts). */
  loyalty: LoyaltyBalance | null;
  /** Cashier pressed LOYALTY — points are applied on the next tender. */
  loyaltyApplied: boolean;
}

export const initialCustomerPanelState: CustomerPanelState = {
  query: "",
  results: [],
  searching: false,
  attached: null,
  loyalty: null,
  loyaltyApplied: false,
};

export type CustomerPanelAction =
  | { type: "query"; query: string }
  | { type: "results"; items: CustomerSummary[] }
  | { type: "search-failed" }
  | { type: "attach"; customer: CustomerSummary }
  | { type: "detach" }
  | { type: "loyalty-loaded"; balance: LoyaltyBalance }
  | { type: "toggle-loyalty" }
  | { type: "reset" };

export function customerPanelReducer(
  state: CustomerPanelState,
  action: CustomerPanelAction,
): CustomerPanelState {
  switch (action.type) {
    case "query": {
      const query = action.query;
      const active = query.trim().length > 0;
      return { ...state, query, searching: active, results: active ? state.results : [] };
    }
    case "results":
      return { ...state, results: action.items, searching: false };
    case "search-failed":
      return { ...state, results: [], searching: false };
    case "attach":
      return {
        ...state,
        attached: action.customer,
        query: "",
        results: [],
        searching: false,
        loyalty: null,
        loyaltyApplied: false,
      };
    case "detach":
      return { ...state, attached: null, loyalty: null, loyaltyApplied: false };
    case "loyalty-loaded":
      return {
        ...state,
        loyalty: action.balance,
        // A refreshed balance of zero can no longer back an armed tender.
        loyaltyApplied: state.loyaltyApplied && action.balance.valueMinor > 0,
      };
    case "toggle-loyalty":
      if (!state.attached || state.loyalty === null || state.loyalty.valueMinor <= 0) return state;
      return { ...state, loyaltyApplied: !state.loyaltyApplied };
    case "reset":
      return initialCustomerPanelState;
  }
}
