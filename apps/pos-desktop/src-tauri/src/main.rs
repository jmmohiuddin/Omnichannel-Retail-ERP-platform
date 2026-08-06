// OmniRetail POS desktop shell (ADR-007).
//
// The webview hosts the exact same @omniretail/pos app that runs in a
// browser; the offline command log and domain invariants live in shared
// TypeScript. This Rust side is where hardware integrations attach next:
// ESC/POS receipt printers, cash-drawer kick, serial customer displays,
// and a SQLite-backed CommandStore/CursorStore for @omniretail/pos-core.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running OmniRetail POS");
}
