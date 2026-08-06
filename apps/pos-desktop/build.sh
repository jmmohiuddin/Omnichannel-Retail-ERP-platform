#!/bin/sh
# Native build wrapper: compiles the Tauri shell when a Rust toolchain is
# available (rustup installs to ~/.cargo) and no-ops gracefully otherwise —
# CI without Rust still gets a green `pnpm -r build`.
export PATH="$HOME/.cargo/bin:$PATH"
if ! command -v cargo >/dev/null 2>&1; then
  echo "pos-desktop: skipping native build (Rust toolchain not installed — see README)"
  exit 0
fi
exec npx -y pnpm exec tauri build --no-bundle
