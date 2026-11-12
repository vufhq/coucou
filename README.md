<div align="center">

<img src="windows/src-tauri/icons/128x128.png" width="96" alt="vufh icon">

# vufh HQ

**Run a team of AI agents from your Windows desktop.**

Mochi, your head of staff, hires coworkers, hands them work and reports back.
Each agent works on its own Linux computer (a WSL2 VM) with a browser, a shell
and your files, on the Claude Code or Cursor subscription you already pay for.
You follow them in vufh HQ, and at a glance in the island at the top of your
screen; nothing risky happens without your click.

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows&logoColor=white)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Node 24](https://img.shields.io/badge/Node-24-339933?logo=node.js&logoColor=white)
![Code: MIT](https://img.shields.io/badge/code-MIT-green)

</div>

---

## What it does

- **A team, not a chatbot.** Start with Mochi, the chief. Ask for a developer
  team or a research assistant: Mochi proposes coworkers (name, role, colour,
  outfit), and each one joins only after you approve it. Mochi delegates, and
  coworkers can ask each other for help.
- **vufh HQ**, a window to run them: a sidebar of your agents and teams with
  what needs you, one conversation per agent, the exchanges between agents,
  Activity across all of them, a side panel with each computer's status and
  queue, goals, memory and files, and `Ctrl+K` to jump anywhere. Drop files or
  paste GitHub links into a message and the agent finds them on its computer.
  Dictate a message with the mic, offline.
- **The island**, at the top of your screen: a pill per agent, with its mini
  Mochi working, asking or done; approve or deny right there; chat with any
  agent; open HQ on its thread.
- **Real computers.** Agents run bash, Python, Node and git on their own WSL2
  VM, as a separate user that can't reach your PC or your network. Several
  computers share the work as a pool.
- **Goals and schedules.** Give an agent a standing goal, run daily, on
  weekdays or every few hours, with check-ins, questions, pause and daily
  limits.
- **Your rules.** Each agent has a rule level, from "ask before everything" to
  "ask before risky steps". GitHub access goes through your own GitHub App,
  with a push budget, and only when you allow it.

vufh also keeps the things it did before: Flow dictation and the Notetaker
(Parakeet, offline), « OK Tofu », the chat with your own keys (Anthropic,
Google AI, OpenAI, OpenRouter, Ollama, LM Studio), and service pills (GitHub,
Vercel, Stripe, n8n, Resend, Notion, Cal.com, Spotify).

## How it works

```
vufh HQ + island (Tauri, windows/)  ──REST + SSE, 127.0.0.1:47620──►  orchestrator backend (Node, orchestrator/)
                                                                          tasks · approvals · goals · memory (SQLite)
                                                                          policy · model router (Claude Code / Cursor CLIs)
                                                                              ▲ workers pull jobs
                                                         computers agent-01, agent-02… (one WSL2 distro each)
                                                         worker · Chromium · the agents' shell, as another user
                                                         /computer = one shared Windows folder
```

The model proposes one operation at a time; the backend's policy runs it, asks
you, or refuses; the worker in the VM checks it again before running it. The
model never gets host access or your credentials. Details:
[orchestrator/README.md](orchestrator/README.md#safety-model).

## Setup

You need Windows 10/11 with WSL2, Node 24+, and Claude Code (`claude`) and/or
the Cursor CLI (`cursor-agent`) signed in.

1. Start the backend once, so it creates its tokens:
   `cd orchestrator && npm install && npm start`.
2. Create the first computer:
   `powershell -ExecutionPolicy Bypass -File orchestrator\worker\provision\provision.ps1`.
3. Build and run vufh (below), open **Settings → Tasks** and switch on
   **Orchestrator backend**. From then on vufh starts the backend for you,
   and vufh HQ opens after Mochi's greeting.

Everything about computers, models, goals, rules and configuration is in
[orchestrator/README.md](orchestrator/README.md); the app itself is described
in [windows/README.md](windows/README.md).

## Build from source

You need [Rust](https://rustup.rs), Node 24+ and the MSVC build tools.

```powershell
cd windows
npm install
npm run tauri dev      # development build
npm run pack           # installer in windows\release\
```

Checks:

```powershell
cd windows; npx tsc --noEmit; npm test; cargo test
cd orchestrator; npm run typecheck; npm test
```

## Layout

| Folder | What |
|---|---|
| `orchestrator/` | The backend: API and events, task loop, policy, model adapters, and the worker and provisioning scripts for the computers |
| `windows/` | The app: vufh HQ (`src/hq`), the island, the vufh window (Flow, Notetaker, settings), in Tauri 2 (Rust in `src-tauri/`) |
| `design/` | The original prototype and captures, references for Mochi and new views |

## Origins

vufh HQ grew out of [Coucou](https://github.com/Louis-CFM/coucou), the notch
companion for AI coding agents by Louis Raillé, and was called Coucou HQ until
it took its own name, icon and face (Tofu, in chrome). This fork keeps Coucou's
Windows app and its window, and builds the agent orchestrator and HQ on top. The Mac,
iPhone, Android and Linux apps and the session monitoring of your own coding
agents were removed; they are in the history, at the tag `pre-hq-focus`.

## Credits

Coucou by [Louis Raillé](https://louisraille.fr), with Claude Code, and its
[contributors](https://github.com/Louis-CFM/coucou/graphs/contributors).
The orchestrator and vufh HQ follow the structure of
[rakazo](https://github.com/elie222/rakazo) (Apache-2.0; structure only, no code
copied).

## License

- **Code:** [MIT](LICENSE).
- **The Mochi character, the sounds and the media in `design/`:** © Louis
  Raillé, all rights reserved; see [LICENSE-ASSETS.md](LICENSE-ASSETS.md).
- **The chrome shader** (`windows/src/mochi/metal.ts`): adapted from
  [@paper-design/shaders](https://github.com/paper-design/shaders), Apache-2.0.
  Tofu's outline comes from
  [grok-bot-avatar-engine](https://github.com/RongleCat/grok-bot-avatar-engine), MIT.
