# @omniretail/mobile

Expo (React Native) owner/manager companion app for OmniRetail OS: today's
numbers, the AI daily digest, refund/stock-count approvals, stock lookup per
location, and the order list. Not a phone POS (deliberate — see
`docs/prd/03-information-architecture.md`, section 3).

## Run it (Expo Go)

```sh
# from the repo root
npx -y pnpm install
npx -y pnpm --filter @omniretail/mobile start   # runs `expo start`
```

Scan the QR code with the Expo Go app (iOS/Android). The phone talks to the
API over the network, so **the API base URL must point at your machine's LAN
IP**, not localhost — `http://localhost:3001` on the phone is the phone
itself. Start the API (`apps/api`) so it listens on `0.0.0.0`, find your LAN
IP (`ipconfig getifaddr en0` on macOS), and enter
`http://192.168.x.x:3001` in the "API server" field on the Login screen
(programmatically: `setApiBase()` in `src/lib/config.ts`).

## Architecture

All logic lives in plain-TS modules under `src/lib/` — API client
(`api.ts`), session store (`session.ts`, in-memory with a pluggable
persistence interface; AsyncStorage adapter is a TODO), money formatting
(`money.ts`), and pure per-screen view-models (`viewmodels.ts`). React Native
components under `src/screens/` and `App.tsx` stay thin: state + render only,
no business logic.

## Verification

CI verifies this package by **strict typecheck + unit tests only** — there is
no native build step and no device/simulator run:

```sh
npx -y pnpm --filter @omniretail/mobile typecheck
npx -y pnpm --filter @omniretail/mobile test
```

Tests run under vitest in a node environment and cover only `src/lib/**`
(never importing React Native), so they stay fast and toolchain-free.
