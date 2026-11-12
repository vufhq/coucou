# Contributing to vufh HQ

Thanks for wanting to help Tofu and his team.

## Getting started

```powershell
cd orchestrator; npm install; npm start          # the backend (see orchestrator/README.md for the computers)
cd windows; npm install; npm run tauri dev       # the app
```

Before opening a pull request:

```powershell
cd windows; npx tsc --noEmit; npm test; cargo test
cd orchestrator; npm run typecheck; npm test
```

## Good first contributions

- A new operation for the agents: add it to `orchestrator/protocol/src/ops.ts`, decide its rule in the policy, run it in the worker, and test it in `orchestrator/tests/`.
- A new service pill: a poller in `windows/src-tauri/src/integrations.rs`, an entry in `windows/src/core/pills.ts` and a card in `windows/src/views/integrations.ts`.
- A new emote or sound for Tofu.
- Bug fixes — please describe how to reproduce.

## Rules of the house

- No third-party dependencies unless there's really no other way.
- Secrets go in the Windows Credential Manager, never on disk or in git.
- No telemetry, no network calls except to services the user configured.
- Nothing risky without the user's click: approvals, new agents, pushes.
- Every string on screen is translated (`windows/src/i18n/extra.json`).
