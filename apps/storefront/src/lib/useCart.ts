import { useMemo, useSyncExternalStore } from "react";
import { cartTotalMinor, getCartStore, itemCount, type CartLine, type CartStore } from "./cart.js";

export interface CartView {
  lines: CartLine[];
  count: number;
  totalMinor: number;
  store: CartStore;
}

/** Subscribe to the tenant's cart; re-renders on any cart change. */
export function useCart(slug: string): CartView {
  const store = getCartStore(slug);
  const lines = useSyncExternalStore(store.subscribe, store.getLines, store.getLines);
  return useMemo(
    () => ({ lines, count: itemCount(lines), totalMinor: cartTotalMinor(lines), store }),
    [lines, store],
  );
}
