# vufh HQ — guide for AI coding agents

vufh HQ runs a team of AI agents from a Windows desktop. `orchestrator/` is the backend (Node, SQLite) and the worker that runs in each agent's WSL2 computer; `windows/` is the app (Tauri 2): vufh HQ, the island at the top of the screen with Tofu and a pill per agent, and the vufh window (Flow dictation, the Notetaker, settings). Windows is the only platform.

## Where things are
- `orchestrator/server/` — API and SSE (`api.ts`), worker gateway, task loop (`runner.ts`), policy, model adapters. `orchestrator/protocol/` — the Zod contracts both sides share; `protocol/src/ops.ts` is the operations allowlist. `orchestrator/worker/` — the worker and `provision/` (provision.ps1, setup.sh, the systemd units).
- `windows/src/hq/` — vufh HQ. `windows/src/island/` — the island; `island/hooks.ts` turns the orchestrator's events (sent by `src-tauri/src/orchestrator.rs` on the "hook" channel) into pills and the approval card. `windows/src/core/pills.ts` — the catalog pills (chat providers and services). `windows/src/i18n/` — `strings.json` and `extra.json`, both edited by hand.
- `windows/src-tauri/src/orchestrator.rs` — vufh's side of the backend: status, starting it, every `orchestrator_*` command.

## Build and check
```
cd windows; npm install; npm run tauri dev
cd windows; npx tsc --noEmit; npm test; cargo test
cd orchestrator; npm install; npm run typecheck; npm test
```
Never run `npm ci` in the orchestrator folder the live backend runs from: it wipes its `node_modules`.

## Rules
- The characters are drawn in code (`Canvas` 2D; the chrome Tofu's body goes through one WebGL shader, `windows/src/tofu/metal.ts`), no images or animation libraries. The sounds are synthesised by `windows/scripts/gen-sounds.mjs`, no samples. No third-party dependencies unless truly unavoidable.
- Secrets live in the Windows Credential Manager (service `dev.vufh.hq`), never on disk or in git. Keep that service name: existing keys depend on it. Keys saved before the rename sit under `fr.louisraille.coucou` and are copied over on first read (`secrets.rs`, `orchestrator/server/src/keyring.ts`); keep that fallback too.
- No telemetry. Network calls only to services the user configured.
- Never approve an agent's request, create or retire an agent, or push to GitHub without an explicit click.
- Never create, delete or modify a user's VM: the user runs `provision.ps1`.
- The model never gets host access or credentials; every new operation goes through the policy and the worker's own check.
- Performance: 0 % CPU when the island is hidden and HQ is closed.
- Never restyle what already ships; change the look of an existing view only when asked. New views follow the existing style.
- Pill IDs and shortcut IDs are stable contract values (settings, keys): never rename one.
- Every user-facing string goes through `t()` / `N_()` and is translated in the nine other languages in `extra.json`; `npm test` fails on a missing or unused string.
- Every release adds its CHANGELOG.md section.
