# Coucou orchestrator

The backend that turns Coucou into the control surface for agents running in
their own Linux computers. Phase 1: **one agent (`agent-01`), one persistent
WSL2 VM, one task at a time**, with a reconnectable activity stream into Coucou.

```
Coucou (Tasks page, island)  ──REST + SSE, 127.0.0.1:47620──►  backend (this folder, Node on Windows)
                                                                 tasks · steps · jobs · approvals · events (SQLite)
                                                                 policy · model router (Claude Code CLI)
                                                                     ▲ worker pulls jobs (WSL interface :47621)
                                                       agent-01 (WSL2, Ubuntu 24.04) — coucou-worker
                                                       browser (Playwright/Chromium) · files · terminal
```

The model proposes one operation at a time. The backend's policy decides:
run it, ask you, or refuse. The worker in the VM checks it again and runs it.
The model never gets host access, credentials or control over the VM.

## Layout

| Folder | What |
|---|---|
| `protocol/` | Zod contracts shared by both sides: tasks, operations, events, worker protocol, model decisions |
| `server/` | The backend: Fastify API and SSE (`api.ts`), worker gateway (`gateway.ts`), task loop (`runner.ts`), policy, redaction, SQLite store, model adapters |
| `worker/` | The worker that runs inside the VM, and `provision/` to create the VM |
| `tests/` | Vitest: unit tests, and integration tests that run the real backend and worker with a fake browser and a scripted model |

## Setup

You need Node 24+ on Windows, WSL2, and Claude Code signed in with your subscription (`claude` on PATH).

1. **Install and start the backend once.** This creates its two access tokens
   in the Windows Credential Manager (`orchestrator-token`,
   `orchestrator-worker-token`, service `fr.louisraille.coucou`):

   ```powershell
   cd orchestrator
   npm install
   npm start
   ```

   Windows Firewall asks about `node.exe` the first time. Allow it on
   **private and public** networks: the VM reaches the backend through WSL's
   virtual network adapter. If you only want to open the one port on that adapter,
   run this in an administrator PowerShell instead:

   ```powershell
   New-NetFirewallRule -DisplayName "Coucou orchestrator worker port" -Direction Inbound `
     -Protocol TCP -LocalPort 47621 -InterfaceAlias "vEthernet (WSL*)" -Action Allow
   ```

2. **Create agent-01** (stop the backend with Ctrl+C first, or use a second terminal):

   ```powershell
   powershell -ExecutionPolicy Bypass -File worker\provision\provision.ps1
   ```

   This creates a WSL2 distro named `agent-01` with its disk in
   `D:\coucou-vms\agent-01`. Pass `-Location` to put it somewhere else. It then
   installs Node, Chromium and the worker, and restarts the distro. To update
   the worker later, run the same command with `-Update`. The disk and
   `/workspace` are kept.

3. **In Coucou**, open **Tasks** in the sidebar and switch on
   **Orchestrator backend**. Then give agent-01 a task, for example:
   *"Open the documentation for httpx, find the current installation
   instructions, and save a summary to report.md."*

Keep `npm start` running. Closing Coucou does not stop a task. Stopping the
backend pauses tasks, and they carry on when it starts again.

## Configuration

| Variable | Default | |
|---|---|---|
| `ORCH_API_PORT` | `47620` | Coucou's API, always on 127.0.0.1 |
| `ORCH_WORKER_PORT` | `47621` | The worker's listener |
| `ORCH_WORKER_HOST` | WSL adapter address | Where the worker listener binds |
| `ORCH_CLAUDE_MODEL` | Claude Code's default | e.g. `sonnet`, `opus` |
| `ORCH_DATA_DIR` | `%LOCALAPPDATA%\CoucouOrchestrator` | The SQLite database |
| `ORCH_KEEP_ALIVE` | on | `0` stops the backend keeping the WSL distro running |

## Safety model

- **Operations** are an allowlist (`protocol/src/ops.ts`): navigate, extract
  text and take a screenshot in the browser; write, list and read files in the
  task's folder; run one command with no shell.
- **Needs your click:** the first visit to a site (approving it remembers the
  site), commands that aren't read-only, installing software, and overwriting a
  file. Coucou never approves on its own.
- **Always refused:** the host machine, the LAN, cloud metadata, URLs with
  credentials, and paths or command arguments that leave the task folder.
  Symlinks are not followed.
- **The VM:** no Windows drives, no Windows programs (`wsl.conf`). The worker
  runs as `agent`, a user with no sudo, under systemd with `NoNewPrivileges`
  and `ProtectSystem=strict`. It may write to `/workspace` only.
- **Secrets:** tokens live in the Credential Manager and in a root-only file
  in the VM. Every event and job result is redacted before it is stored,
  streamed, or shown to the model. The Claude CLI runs with every tool off,
  restricted, and in an empty folder, so it can only answer.
- **Isolation limit:** all WSL2 distros on this PC, including Docker's and
  Podman's, share one utility VM and kernel. agent-01 is isolated from Windows,
  but it shares a kernel with those distros.

## Reliability

- Submitting is idempotent: the client sends an `idempotencyKey`, and a
  retry returns the same task.
- Every step is written down before it runs. A restarted backend resumes each
  task where it was and never asks the model or runs a job twice.
- Jobs have leases kept alive by heartbeats. If a worker goes quiet, a
  read-only job is handed out again once, and anything else fails the task
  with reason `worker_lost`. A worker that restarts reports its journal, so
  finished work is never re-run.
- Events carry a global `seq`. Clients resume with `Last-Event-ID` and get
  every event once, in order.
- Every way a task can end has its own outcome: `cancelled` when you cancel
  it, `timeout` for both the task budget (10 min of work, not counting time
  waiting for you) and each operation (60 s), `max_steps` after 20 steps,
  `rate_limited` when you reach your plan's limit, and `model_error`.

## Tests

```powershell
npm test          # 72 tests: unit + integration (real backend and worker, fake browser, scripted model)
npm run typecheck
```

## Known limits (Phase 1)

- One agent, one task at a time. Further tasks queue.
- File download through the API is text only. Screenshots are listed but not downloadable yet.
- After you approve a site, redirects to another site are followed without asking.
  The host and the LAN stay blocked.
- Only Claude (through the Claude Code CLI) is wired up as a model. The
  OpenAI-compatible adapter and Codex/Cursor CLIs come in Phase 3.
