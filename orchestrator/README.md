# Coucou orchestrator

The backend that turns Coucou into the control surface for agents running in
their own Linux computers. Phase 1: **one agent (`agent-01`), one persistent
WSL2 VM, one task at a time**, with a reconnectable activity stream into Coucou.

```
Coucou (Tasks page, island)  ──REST + SSE, 127.0.0.1:47620──►  backend (this folder, Node on Windows)
                                                                 tasks · steps · jobs · approvals · events (SQLite)
                                                                 policy · model router (Claude Code / Cursor CLIs)
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

You need Node 24+ on Windows, WSL2, and at least one subscription CLI signed in:
Claude Code (`claude` on PATH) and/or the Cursor CLI (`cursor-agent login`).

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

## Models

Each task runs on one model profile, picked on the Tasks page (or `modelProfileId` in `POST /api/tasks`).
`GET /api/models` lists what this machine has.

| Profile | Runs | Locked down by |
|---|---|---|
| `claude-cli` | Claude Code CLI, your Claude subscription | `--tools ""` (every tool off), `--restricted`, no MCP, no saved session, an empty folder, answer forced into the decision schema |
| `cursor-cli` | Cursor CLI (`%LOCALAPPDATA%\cursor-agent`), your Cursor subscription | a private home (none of your Cursor or Claude hooks, MCP servers or settings), a `cli-config.json` there denying `Shell`, `Read`, `Write`, `WebFetch` and `Mcp`, read-only ask mode, no `--force`, an empty folder |
| `local` | An OpenAI-compatible `/v1` server on this machine (`ORCH_LOCAL_URL`, loopback only) | no tools; only the JSON decision is sent to the server |

Cursor's CLI has no switch that turns its tools off, and its sandbox is macOS/Linux only, so its locks were
checked on Windows against a canary file: reading it (outside and inside the folder), running `whoami`,
fetching a page and calling a Gmail MCP tool were all refused, and the canary never appeared.

When a model is rate-limited or unavailable, the task carries on with the other one (`ORCH_MODEL_FALLBACK=0`
turns that off). A bad answer, a timeout or a cancellation never switches models.

Cursor syncs the plugins installed on your Cursor account into its private home: about 4 GB on this machine,
downloaded once. Point `ORCH_CURSOR_STATE_DIR` at a drive with room.

## Configuration

Settings go in the environment or in a `.env` file next to `package.json` (git-ignored; `npm start` reads it).

| Variable | Default | |
|---|---|---|
| `ORCH_API_PORT` | `47620` | Coucou's API, always on 127.0.0.1 |
| `ORCH_WORKER_PORT` | `47621` | The worker's listener |
| `ORCH_WORKER_HOST` | WSL adapter address | Where the worker listener binds |
| `ORCH_MODEL_PROFILE` | `claude-cli` | The model tasks use unless they name one |
| `ORCH_MODEL_FALLBACK` | on | `0`: never switch models after a rate limit |
| `ORCH_CLAUDE_MODEL` | Claude Code's default | e.g. `sonnet`, `opus` |
| `ORCH_CURSOR_MODEL` | Cursor's default | e.g. `gpt-5.3-codex`, `sonnet-4.5` |
| `ORCH_CURSOR_DIR` | `%LOCALAPPDATA%\cursor-agent` | Where the Cursor CLI is installed |
| `ORCH_CURSOR_STATE_DIR` | `<data dir>\cursor` | Cursor's private home and empty folder (several GB) |
| `ORCH_LOCAL_URL` | unset | Base URL of an OpenAI-compatible server on this machine (loopback only), e.g. `http://127.0.0.1:11434/v1` |
| `ORCH_LOCAL_MODEL` | `local` | Model sent to the local server |
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
  streamed, or shown to the model. Both model CLIs run so that they can only
  answer (see Models): no shell, no files, no web, no MCP on this computer.
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
npm test          # unit + integration (real backend and worker, fake browser, scripted models)
npm run typecheck
```

## Known limits (Phase 1)

- One agent, one task at a time. Further tasks queue.
- File download through the API is text only. Screenshots are listed but not downloadable yet.
- After you approve a site, redirects to another site are followed without asking.
  The host and the LAN stay blocked.
- Models: Claude Code, Cursor, and an optional OpenAI-compatible server on this
  machine. ChatGPT through the Codex CLI (`server/src/model/codex-cli.ts`) is not
  enabled: Codex's read-only sandbox still lets the model run commands that read
  files, credentials included, so it waits until it is locked down and passes the
  canary probe Cursor passed.
- Cursor's account plugins load in its private home: their tools are denied,
  but their skill text reaches the model's context.
