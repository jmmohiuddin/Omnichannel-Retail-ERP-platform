/** Base URL of the OmniRetail API. Override with VITE_API_URL. */
export const API_BASE: string =
  (import.meta.env?.VITE_API_URL as string | undefined) ?? "http://localhost:3001";
