# Mac parity plan: bring the Mac app up to the Windows version

Status: 2026-11-01 — phases 0 and 1 done (not yet committed); decisions 1 (Lima) and 2 (token passed by the app) taken. Baseline: the Mac app at `5e2b8af` (Oct 20). The
Windows/Linux app at `b4a7449` (phase 11).

## What the Mac is missing

Since Oct 20, about 15.7k lines landed in `windows/` only (`git diff --stat 5e2b8af HEAD -- windows`):

| Feature | Windows source | Size |
|---|---|---|
| Orchestrator client: backend connection, SSE, auto-start, token | `src-tauri/src/orchestrator.rs`, `src/core/orchestrator.ts`, `src/core/state.ts` | ~1.9k |
| Island: agent dots, agent chat, agent cards, approvals and questions from agents | `src/island/agent-chat.ts`, `orchestrator-agents.ts`, `views/agent-card.ts`, `views/chat.ts` | ~0.7k |
| Flow hub **Tasks** page: agents, team, goals, check-ins, pause, delegation | `src/hub/pages/tasks.ts` | ~1k |
| **Coucou HQ** window: sidebar, threads, composer, palette, activity, panel, files/GitHub links | `src/hq/*` | ~7k (incl. CSS) |
| **Tofu**: a second character (flat pebble), 12 outfits, colour, picked in Settings → General | `src/mochi/tofu*.ts`, `character.ts`, `layer.ts` | ~1k |
| Strings | `src/i18n/extra.json` | ~2.1k |

The **backend** (`orchestrator/`) only runs on Windows today. These are the only parts tied to Windows:

| Windows-only piece | File | Mac replacement |
|---|---|---|
| Computers are WSL2 distros, `vmId = wsl:<id>` | `server/src/config.ts:67` | `lima:<id>` |
| Keep-alive (`wsl.exe … sleep infinity`) and the running probe | `server/src/vm.ts`, `main.ts:85` | `limactl list --json` probe, `limactl start` when stopped |
| The worker reaches the backend on WSL's vEthernet address | `config.ts:34 wslHostAddress()` | `127.0.0.1` on the host, `host.lima.internal` in the guest |
| Provisioning | `worker/provision/provision.ps1` | `provision.sh` + a Lima template |
| Shared `/computer` = `D:\coucou-vms\shared` via drvfs | `mount-computer.sh` | virtiofs mount of `~/Library/Application Support/Coucou/computers/shared` |
| DNS hard-coded to WSL's tunnel `10.255.255.254` | `mount-computer.sh` | Lima's `192.168.5.3`, taken from `computer.env` |
| Tokens in Credential Manager | `server/src/tokens.ts` (`@napi-rs/keyring`) | macOS Keychain (same library works) |

Everything else (store, scheduler, policy, model router, Claude Code / Cursor / Codex CLIs, the
worker inside the VM, coucou-runner and the systemd units) is platform-neutral.

## Decisions (recommended; confirm before phase 0)

1. **VMs: Lima with `vmType: vz`** (Apple Virtualization.framework, Ubuntu 24.04 arm64, systemd).
   It's an external tool, like WSL is on Windows, so the Mac app takes on no third-party dependency.
   The alternative, a VM manager written in Swift on Virtualization.framework, costs weeks of work and gains little.
2. **Token handoff.** `@napi-rs/keyring` writes Keychain service `fr.louisraille.coucou`, while the Mac
   app uses `fr.louisraille.NotchBuddy`. Reading another process's item triggers a Keychain prompt.
   → Recommended: when the Mac app starts the backend, it creates or reads the token under its own
   service and passes it as `ORCH_API_TOKEN`. A manually started backend keeps the keyring path,
   and the app reads `fr.louisraille.coucou` (one prompt, "Always allow").
3. **Tofu lives in CoucouKit**, next to BotEngine, so the iPhone app can draw it too (it stays Mochi
   unless the user picks Tofu).
4. Adding a **Character** row to Settings → General and a **Tasks** entry to the hub is new UI in
   existing screens. It follows the existing style, and no shipped view changes.

## Phases

Each phase gets its own branch and PR, builds green (`xcodegen && xcodebuild`) and is tested on a real Mac.

### Phase 0 — the backend runs on a Mac (`orchestrator/`)
- `vm.ts`: a `VmDriver` interface (`probe`, `keepAlive`) with `wsl` and `lima` implementations, picked by `vmId` prefix.
- `config.ts`: `lima:<id>` on darwin; `workerHost` defaults to `127.0.0.1` on darwin.
- `worker/provision/lima/agent.yaml` (vz, virtiofs mount of the shared folder, no other host mounts,
  usernet) and `provision.sh <name> [--shared-dir]`, mirroring `provision.ps1` step by step.
- `mount-computer.sh` / `setup.sh`: mount type and DNS come from `computer.env` (drvfs/WSL vs virtiofs/Lima).
- **Risk to verify first:** virtiofs keeps the host's uid and doesn't honour `uid=/gid=/umask=` like drvfs does.
  Check that `runner` and the worker can both write and nobody else can; if not, use `bindfs` inside the guest.
- Tests: extend the `vm.ts` and `config.ts` tests for the Lima driver; run one task end to end on agent-01 and two computers in parallel.
- README: a "Mac" section in `orchestrator/README.md`.

### Phase 1 — Tofu (independent; can run in parallel with phase 0)
- `CoucouKit/Character.swift` (`mochi | tofu`, `tofuColor`), `TofuShape.swift` (pebble + palette), `TofuRenderer.swift`
  (body, eyes on the ellipsoid, hands, the 12 flat outfits with drop/slide/pop/fade).
- BotEngine hands its drawing to the Tofu renderer when the character is Tofu; badge and particles stay the engine's.
- Every place that draws Mochi follows the choice: island, desktop Mochi, greeting, upload box, wardrobe, mini-bots.
- Settings → General: Character + Tofu colour. Port `tests/character.test.mjs` to Swift Testing.

### Phase 2 — orchestrator client core + Tasks page
- `App/Orchestrator/OrchestratorClient.swift`: REST plus SSE over `URLSession.bytes`, a loopback-only URL check,
  the 45 s stream watchdog, reconnecting, and the token from the Keychain (never handed to views).
- `OrchestratorModels.swift`: Codable mirrors of `core/orchestrator.ts`, tolerant of fields an older backend leaves out.
- `BackendLauncher.swift`: starts `node` from the chosen orchestrator folder when nothing answers.
- `HubPage.tasks` + `FlowHubTasks.swift`: agents, team, goals, check-ins, pause, delegation, as in `hub/pages/tasks.ts`.
- 0 % CPU while hidden: no stream when the orchestrator is off; events are pushed, never polled.
- Port `tests/orchestrator.test.mjs` (event → island mapping, model decoding).

### Phase 3 — island integration
- Agent dots next to the pills, agent chat in the island, agent cards.
- Agent approvals and questions join `ApprovalQueue`: the same "stays until answered" rules, and approval only on an explicit click.
- Recap counts agent questions and approvals as on Windows.

### Phase 4 — Coucou HQ window
- New `NSWindow` + SwiftUI: sidebar, thread view, composer (attachments, GitHub repos), palette, activity, side panel,
  exchanges opened as their own chat, peer-help messages, file and GitHub links.
- Port `hq/model.ts` and `hq/store.ts` logic first (pure, testable against `tests/hq.test.mjs`), views after.
- Opened from the menu bar ("Coucou HQ"), as from the tray on Windows.

### Phase 5 — strings and release
- Move every new string from `extra.json` into the Mac string catalog (all shipped languages).
- `docs/SPEC.md` / `docs/INTEGRATIONS.md` updates (French).
- Mac 0.6.0: CHANGELOG section, README Versions row, regenerated Info.plist committed.

## Order and rough size
Phases 0 and 1 run in parallel → 2 → 3 → 4 → 5. Phase 4 is the largest. Every phase ships something usable on its own,
except 2 and 3, which together make the first usable orchestrator on Mac.
