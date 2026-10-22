# Coucou orchestrator

The backend that turns Coucou into the control surface for Mochi and a team of
AI coworkers. Provisioned Linux VMs are **computers** (`agent-01`,
`agent-02`…), while the characters the user names, colours and chats with are
**agents**. Every agent shares one computer, `agent-01`, which runs one task
at a time; the others' tasks queue. Activity remains reconnectable and durable.

```
Coucou (Tasks page, island)  ──REST + SSE, 127.0.0.1:47620──►  backend (this folder, Node on Windows)
                                                                 tasks · steps · jobs · approvals · events (SQLite)
                                                                 policy · model router (Claude Code / Cursor CLIs)
                                                                     ▲ worker pulls jobs (WSL interface :47621)
                                                       computers agent-01, agent-02… (one WSL2 distro each, Ubuntu 24.04)
                                                       coucou-worker · browser (Playwright/Chromium) · files
                                                       coucou-runner · the agents' bash shell, as another user, in /computer
```

## Mochi and the team

On first start the only agent is Mochi, the chief. Its stable id is the first
computer id and it cannot be retired. Every agent Mochi or the user creates goes
on the first configured computer: Mochi's team proposals don't pick a computer
(a `computerId` in one is ignored).

Mochi can propose a team, organize it, delegate work, answer a coworker's
question and wait for reports. Creating or retiring a coworker always pauses
for an explicit user approval. Coworker reports, personas, names and team data
are fenced as untrusted data in model prompts. Coworkers cannot use Mochi's
management operations or delegate to each other.

Delegated tasks run on the shared computer and appear in that coworker's chat. While Mochi waits, its task uses neither a parallel slot nor
its timeout budget. A computer still runs only one task at a time, even when
several coworkers share it.

There may be at most 12 live agents, including Mochi. In one chief task,
Mochi may delegate at most 10 assignments, answer 20 coworker questions and
wait 20 times.

The model proposes one operation at a time. The backend's policy decides:
run it, ask you, or refuse. The worker in the VM checks it again and runs it.
The model never gets host access, credentials or control over the VM.

## The computer

Agents run code on their computer, as rakazo's bots do (structure only, no code
taken): `terminal.shell` is a real `bash -lc` command line, with pipes,
scripts, installs and servers, and it needs no click. The computer is the
boundary, not each command.

- Commands run as `runner`, a second user with no sudo, in the
  `coucou-runner` service. The worker hands it each command over a socket only
  the worker's group can open. `runner` can't see the worker's processes, its
  token, its journal or `/workspace`.
- `/computer` is the computer's disk, kept across tasks and updates:
  `tasks/<id>` is each task's folder (what you see and download, where a
  command starts), `agents/<agent>` is each agent's own folder and `~` in its
  shell, and `shared/` is shared by the team. As in rakazo, these folders keep
  work tidy but are not walls between agents: they all share one computer.
- Installed: python3, uv, node, npm, git, curl, a C compiler. No apt. Python
  packages go in a venv (`uv venv`, `uv pip install`), tools in
  `~/.local/bin` (`uv tool install`).
- The internet is open. Your PC (the WSL gateway, where the backend listens)
  and the local network are closed (`IPAddressDeny`), except WSL's DNS tunnel.
- A command stops after `timeoutSec` (120 s by default, 600 at most), with
  everything it started. A server started with `&` doesn't hold the command
  and keeps running. The runner may use at most 75 % of the VM's memory and
  512 processes.
- Output streams live to Coucou; the model gets the exit code and the last
  64 KB.

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

1. **Install and start the backend once.** This creates its access tokens
   in the Windows Credential Manager (`orchestrator-token` for Coucou, and one
   worker token per agent: `orchestrator-worker-token` for agent-01,
   `orchestrator-worker-token-agent-02` and so on; service `fr.louisraille.coucou`):

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
   `/workspace` and `/computer` are kept. (After a backend update that changes
   the worker, as 0.2 did for downloads and health reports and 0.3 for the
   shell, run `-Update` once.)

   **One shared computer.** Every agent shares `agent-01`, so `ORCH_AGENTS`
   should name only it:

   ```
   ORCH_AGENTS=agent-01
   ```

   If you set up `agent-02` before, drop it from `ORCH_AGENTS` in
   `orchestrator\.env` and restart the backend. At startup, every agent
   (retired ones too) on a computer that is no longer listed moves to the first
   listed one, and only listed computers are shown. Old tasks keep pointing at
   `agent-02` in the history. Removing its VM is your own choice and frees
   about 3.5 GB; it deletes that distro and its disk for good:

   ```powershell
   wsl --unregister agent-02
   ```

   **More computers (optional).** The backend can still drive several, each its
   own distro with its own worker token, but new agents always go on the first:

   ```powershell
   powershell -ExecutionPolicy Bypass -File worker\provision\provision.ps1 -Name agent-02
   ```

   It goes in `D:\coucou-vms\agent-02` (about 3.5 GB). Then list every computer in
   `orchestrator\.env` and restart the backend:

   ```
   ORCH_AGENTS=agent-01,agent-02
   ```

3. **In Coucou**, open **Tasks** in the sidebar and switch on
   **Orchestrator backend**. Then give agent-01 a task, for example:
   *"Open the documentation for httpx, find the current installation
   instructions, and save a summary to report.md."*

   Each agent then has a pill in the island that stays, after Claude Code and
   Cursor, like a ChatGPT dot: its mini Mochi works, asks and finishes with
   its tasks, and dims when its computer is off. Pick it to see how it is and
   how its last task ended; **Chat with …** opens the island's chat talking to
   that agent (agents are also in the chat's model picker). Each message is a
   task for it: the chat shows what it is doing as it goes and its answer when
   it is done, and the conversation so far goes with each task as background,
   so a follow-up makes sense. ↗ opens its Activity on the Tasks page. More than four
   pills go in pages, with a dot under the grid for each, and a page whose pill
   needs you lights its dot. Rename an agent or change its colour on the Tasks
   page.

Keep `npm start` running. Closing Coucou does not stop a task. Stopping the
backend pauses tasks, and they carry on when it starts again.

## Goals and schedules

Each agent can have durable goals. A goal has a title, background instructions,
an optional model profile, and one of four schedules: manual, every 1–168 hours,
daily at a local `HH:MM`, or weekdays at a local `HH:MM`. Scheduled times use
the backend PC's local time. After downtime the backend starts one catch-up run,
not every missed run, and a goal never runs twice at once.

Goal runs are ordinary tasks, visible in the same activity stream and marked
with `source: "goal"`. Their prompt includes the previous check-in and the
agent's memory as fenced background. Each completed run updates the goal's
check-in; the model can mark the goal achieved, which stops its schedule.
Goals can also be paused, resumed, run manually, edited, or archived without
removing their past tasks.

## Questions, pause and limits

An agent can ask up to three questions during a task. The task waits without
using a parallel slot or its timeout budget, then continues from the answer.
An unanswered question fails after 24 hours.

A task can be paused while queued or waiting. If it is working, pause takes
effect after the current step: the backend never kills a step just to pause it.
Pausing an agent applies the same boundary to its running tasks and leaves its
queue waiting until the agent is resumed. Time paused does not use the task's
timeout budget.

Agents default to 30 task starts and 300 steps per local day. Coucou can change
both limits per agent. Once either limit is reached, queued work remains visible
with `waitingReason: "daily_limit"` and starts after local midnight; a running
step is allowed to finish first.

## Memory

Agents can keep up to 50 short notes, and the user can add or remove notes in
Coucou. A task may remember up to three facts when it finishes. Notes are
redacted before storage, and every prompt receives them inside a `<memory>`
block explicitly labelled as background, never instructions. When the limit is
reached, the oldest agent-written notes are removed first.

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
| `ORCH_RETENTION_DAYS` | `30` | Finished tasks, their history and their folders in the VM are removed after this many days. `0` keeps everything |
| `ORCH_KEEP_ALIVE` | on | `0` stops the backend keeping the WSL distros running |
| `ORCH_AGENTS` | `agent-01` | Provisioned computers, comma-separated. Each is a distro of the same name, made by `provision.ps1 -Name`. Every agent shares the first; agents on a computer dropped from the list move to it at startup |
| `ORCH_MAX_PARALLEL` | `2` | How many computers may work at the same time. The others' tasks wait their turn |

## Safety model

- **Operations** are an allowlist (`protocol/src/ops.ts`): navigate, extract
  text and take a screenshot in the browser; write, list and read files in the
  task's folder; run bash command lines on the computer (`terminal.shell`, see
  The computer). The older `terminal.run` (one command, no shell, as the
  worker's user) keeps its rules, so an outdated worker never runs free code.
- **Runs without a click:** shell commands and writing or overwriting files.
- **Needs your click:** the first visit to a site (approving it remembers the
  site), and creating or retiring an agent. Coucou never approves on its own.
- **Always refused:** the host machine, the LAN, cloud metadata, URLs with
  credentials, and paths or command arguments that leave the task folder.
  Symlinks are not followed.
- **The VM:** no Windows drives, no Windows programs (`wsl.conf`). The worker
  runs as `agent`, a user with no sudo, under systemd with `NoNewPrivileges`
  and `ProtectSystem=strict`. It may write to `/workspace` and `/computer`
  only. What the agents run is the `runner` user's (see The computer).
- **Secrets:** tokens live in the Credential Manager and in a root-only file
  in the VM. Every event and job result is redacted before it is stored,
  streamed, or shown to the model. Both model CLIs run so that they can only
  answer (see Models): no shell, no files, no web, no MCP on this computer.
- **Between computers:** each computer has its own distro, disk, browser and
  worker token. The backend knows which computer is calling from its token
  alone, so one computer's worker can never claim, report on or cancel another
  computer's jobs. Jobs and health stay keyed by computer; user-facing events
  always carry the character agent's id.
- **Folders WSL shares:** every distro sees `/mnt/wsl` and `/mnt/wslg`, where
  Podman, Docker and WSLg leave their sockets, under user ids that can equal the
  agent's. The worker and everything it runs cannot reach them
  (`InaccessiblePaths` in the systemd unit).
- **Isolation limit:** all WSL2 distros on this PC, including Docker's and
  Podman's, share one utility VM and kernel. agent-01 is isolated from Windows,
  but it shares a kernel with those distros.

## Reliability

- Submitting is idempotent: the client sends an `idempotencyKey`, and a
  retry returns the same task.
- A task can name its agent, or leave it to the backend, which picks an online
  agent before an offline one, then the one with the least work.
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
- A model that times out or can't be reached is asked again after 5 s, then
  after 20 s, before the task fails. A rate limit isn't retried: plan limits
  last hours, and the other models have already been tried.
- A task that runs out of time while the agent's computer is offline fails as
  `worker_lost`, not `timeout`.
- **Health:** the worker reports its free disk space and whether Chromium is
  installed, once a minute. Coucou's Tasks page shows the agent's state and
  what is wrong: its computer is stopped (checked with
  `wsl --list --running`), its worker does not answer, its disk has under
  1 GB free, or Chromium is missing.
- **Retention:** every 6 hours the backend removes finished tasks older than
  `ORCH_RETENTION_DAYS`, and the worker removes task folders in the VM nothing
  has touched for a day longer than that. Tasks still running are never touched.
- **Downloads:** files come down byte for byte, up to 8 MB, screenshots
  included. The bytes go straight from the worker to Coucou: they are never
  stored in the database or the event log. Text files (`.md`, `.txt`, `.json`,
  `.csv`, `.html`…) are redacted like everything else that leaves the VM as text.
  Downloading is the backend's own operation (`fs.fetch`): a model can't ask for it.

## Tests

```powershell
npm test          # unit + integration (real backend and worker, fake browser, scripted models)
npm run typecheck
```

## Known limits

- Each computer does one task at a time; at most `ORCH_MAX_PARALLEL` computers work at once.
- At most 12 live character agents share the computer, so their tasks queue.
- All agents share WSL's memory (half the PC's by default) and your plan's limits.
- Shell commands need worker 0.3 and its runner: run `provision.ps1 -Update`
  once. An older worker answers that it doesn't know the operation.
- Packages installed outside `/computer` don't exist (no apt); ask for them in
  `setup.sh`.
- Downloads stop at 8 MB. A worker older than 0.2 only downloads text; update it
  with `provision.ps1 -Update`.
- After you approve a site, redirects to another site are followed without asking.
  The host and the LAN stay blocked.
- Models: Claude Code, Cursor, and an optional OpenAI-compatible server on this
  machine. ChatGPT through the Codex CLI (`server/src/model/codex-cli.ts`) is not
  enabled: Codex's read-only sandbox still lets the model run commands that read
  files, credentials included, so it waits until it is locked down and passes the
  canary probe Cursor passed.
- Cursor's account plugins load in its private home: their tools are denied,
  but their skill text reaches the model's context.
