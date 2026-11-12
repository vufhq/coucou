<div align="center">

<img src="src-tauri/icons/128x128.png" width="96" alt="vufh icon">

# vufh for Windows

**vufh HQ, the island at the top of your screen, and the vufh window.**

![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Rust](https://img.shields.io/badge/Rust-backend-000?logo=rust)
![Code: MIT](https://img.shields.io/badge/code-MIT-green)

</div>

---

The app has three parts:

- **vufh HQ**, the window where you run your agents (see the
  [top-level README](../README.md) and [orchestrator/README.md](../orchestrator/README.md)).
  It opens after Tofu's greeting, from the tray, and when you launch vufh
  again. **Flow → Settings → App → Open vufh HQ when you open vufh** turns
  that off; it never opens when vufh starts with the computer.
- **The island**, at the top of the screen: Tofu, a pill per agent and the
  chat and service pills you add.
- **The vufh window** (tray → Settings…): Flow dictation, the Notetaker, the
  Tasks page and every setting.

## Install

Build it yourself (below). `npm run pack` makes an installer in
`windows\release\`; `target\release\vufh.exe` also runs on its own.

The installer isn't code-signed, so SmartScreen shows **"Windows protected your
PC"** the first time: click **More info**, then **Run anyway**.

## The island

| What you do | What happens |
|---|---|
| Move the mouse to the very top-centre of the screen | Tofu peeks out |
| Click the small island | It opens. With **Settings → General → Open on hover**, resting the pointer on it is enough |
| An agent works | Its pill's mini Tofu works too, and the overview shows its steps; its summary stays when it is done |
| An agent asks for approval | The island opens on **Deny / Allow** with exactly what it wants to do. The card stays until you answer: fold it with the **⌃** in its corner (or `Esc`), and opening the island brings it back. Answered in HQ, it goes |
| Pick an agent's pill at rest | Its card: how it is, how its last task ended, **Chat with …** |
| ↗ on an agent, or **Open in HQ** | vufh HQ on that agent's thread |
| Click Tofu | He gets annoyed. Three times in a row and he goes dizzy |
| Right-click Tofu | The wardrobe: rest the pointer on an outfit to try it on, click to keep it |
| Drag Tofu out of the island | He lives on your desktop, watching your cursor, and flies back for an approval. Drop him on the island to bring him home |
| Drag a file onto the island | Tofu turns into a box, swallows it, then offers to answer questions about it |
| Put a file named like one of Tofu's sounds (`finish.wav`…) in `%APPDATA%\vufh\sounds` | It replaces that sound after **Settings → General → Reload sounds** |
| Tray icon | vufh HQ, Wardrobe…, Settings…, Pause, Quit |

More than four pills go in pages, with a dot for each page; a page whose pill
needs you lights its dot.

### Keyboard shortcuts

| Keys | What they do |
|---|---|
| `Ctrl+Alt+Space` | Opens the chat, from any app |
| `Ctrl+Alt+A` | Jumps to the waiting approval, or to the agent asking a question |
| `Ctrl+Alt+T` | Opens vufh HQ on the focused agent |
| `Ctrl+Alt+→` / `Ctrl+Alt+←` | Next / previous pill |
| `Ctrl+Alt+S` | Mutes or unmutes Tofu |
| `Ctrl+Alt+G` | Opens the wardrobe |
| `Ctrl+Alt+D` | Sends Tofu to the desktop, or brings him home |
| `Ctrl+Alt+N` | Opens and closes the island (off until you turn it on) |
| In the open island: `Ctrl+→` `Ctrl+←`, `Ctrl+1`–`Ctrl+9` | Switch pills |
| In the open island: `Ctrl+↓` `Ctrl+↑`, `Ctrl+O` | Walk the open GitHub list, open the highlighted row |
| In the open island: `Ctrl+Enter`, `Ctrl+K`, `Ctrl+,`, `Ctrl+P`, `Esc` | Send, new chat, settings, keep the island open, close |

Every global shortcut can be changed or turned off in **Settings → Shortcuts**.
A combination another app already holds is flagged *In use*. The defaults avoid
`Ctrl+Alt` letters that type a character on common keyboard layouts (on
Windows `Ctrl+Alt` is `AltGr`), and vufh leaves unregistered any combination
that types a character on a layout you have installed.

## Flow, the Notetaker and « OK Tofu »

All three run on [Parakeet](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), on your CPU and
offline; nothing is downloaded until you click **Download** (about 700 MB,
once, checked against its SHA-256).

| What you do | What happens |
|---|---|
| Hold **right Ctrl** anywhere, speak, let go | Your words are pasted where you type. Pick another key in Flow → Settings |
| Tap the key twice | Hands-free until the next tap. `Esc` cancels |
| Click **Record a call** | Your microphone and what the computer plays, transcribed live, then written person by person with a summary and to-dos by Claude (your key). The audio is deleted once the transcript is written |
| Say **« OK Tofu »**, then ask | Claude (your key) answers in the pill and out loud: your agents, your pills, Spotify, your services' numbers, web search. Turn it on in Notch → OK Tofu |

Your voice never leaves the computer. With Claude's clean-up, a call's summary
or « OK Tofu », the text — never the audio — goes to Anthropic with your key.

## Your pills

Your agents always have their pills, first, in the backend's order with Tofu
leading. **Settings → Active pills** adds up to four chat providers (Anthropic,
Google AI, OpenAI, Ollama, LM Studio) and services (in **Integrations**:
GitHub, Vercel, Stripe, n8n, Resend, Notion, Cal.com, Spotify).

## Chat and keys

**Settings → Chat** takes your Anthropic API key, and Google AI, OpenAI and
OpenRouter keys; **Local models** connects Ollama, LM Studio or any
OpenAI-compatible server. Keys live in the **Windows Credential Manager**,
never on disk and never in the interface. Click the model name above the chat
box to switch provider, model, or one of your agents. Answers show as Markdown,
built from text nodes, never parsed as HTML.

`VUFH_ANTHROPIC_BASE_URL` sends the Claude chat through an
Anthropic-compatible gateway (`https://`, or `http://` to this PC only).

No telemetry. The only network requests vufh makes are to the services you
configure yourself.

## Languages

English, 简体中文, हिन्दी, Español, العربية, Français, বাংলা, Português (Brasil),
Русский and Bahasa Indonesia, in **Settings → General → Language**; **System**
follows your system's language. The tables are `src/i18n/strings.json` and
`src/i18n/extra.json`, keyed by the English text; the tests fail on a string
that is missing a language or that no code uses.

## GitHub

With a token in **Settings → Integrations → GitHub** (classic with the `repo`
scope, or fine-grained with read access to Pull requests, Commit statuses and
Actions), the GitHub pill shows your PRs and their CI, the PRs waiting for your
review, the CI of your default branches and your contributions, with a badge
and a sound when something turns red or green. This is your own token, for the
pill; agents use GitHub only through the GitHub App you connect in HQ.

## Build it yourself

You need [Rust](https://rustup.rs), Node 24+, and the **MSVC build tools**
(Visual Studio Build Tools with "Desktop development with C++"). WebView2 ships
with Windows 10/11.

```powershell
cd windows
npm install
npm run tauri dev      # live-reloading development build
npm run pack           # the installer, in windows\release\
npm run sounds         # writes sounds/ again from scripts/gen-sounds.mjs
```

`npm run dev` alone serves the front end in an ordinary browser, enough to work
on the island's looks.

### Layout

```
windows/
  src/
    hq/                vufh HQ
    island/            the island: state machine, agent events, integrations
    views/             every island view
    hub/, settings/    the vufh window: Flow, the Notetaker, the Tasks page, settings
    tofu/             Tofu and the greeting, in Canvas 2D
    desktop/           Tofu's own window, when he lives on the desktop
    i18n/              the translation tables
  src-tauri/           Rust: windows, the orchestrator client, chat, pollers, Flow
  sounds/              Tofu's sounds
```

### Log

`%LOCALAPPDATA%\vufh\vufh.log`, and the backend vufh starts writes to
`orchestrator-backend.log` beside it. Both stay on your machine.
