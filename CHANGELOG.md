# Changelog

## Unreleased — vufh HQ

vufh HQ: a team of AI agents on their own computers, run from Windows.

- **A name, an icon, a face and sounds of its own** — the app is vufh, its
  window vufh HQ, and Tofu is who you see: a pebble in liquid chrome, or in
  one flat colour (Settings → General → Character). He is in the island, the
  launch hello, the file drop, the wardrobe and on the desktop, and your head
  of staff is called Tofu. The 29 sounds are new, synthesised by
  `windows/scripts/gen-sounds.mjs`. The wake phrase is « OK Tofu ». Your keys,
  settings, models and tasks follow from an earlier install: the folders in
  `%APPDATA%` and `%LOCALAPPDATA%` move on first launch, and the keys are read
  from where they were. Run `provision.ps1 -Update` once per computer: the
  worker's services and folders there take the new name too. The gateway
  variable is now `VUFH_ANTHROPIC_BASE_URL`
- **vufh HQ is the front door** — it opens after Tofu's greeting, from the
  tray and when you launch vufh again (Flow → Settings → App → Open vufh HQ
  when you open vufh). `Ctrl+Alt+T` and a finished task's **Open in HQ** open
  it on the agent's thread
- **The island follows your agents** — their pills come first; up to four chat
  or service pills follow. The approval card, the steps and the summaries are
  the agents'
- **Removed** — watching your own Claude Code, Codex, Gemini CLI… sessions
  (the hook relay and its installers, live diffs, Claude Code's questions,
  "Open terminal", the main pill); the Claude and Codex plan gauges; the weekly
  recap; the phone link
- **Fixed** — vufh HQ opened while the backend was still starting said "The
  backend stopped answering." and stayed that way until it was reopened. It
  now asks again every few seconds until the backend answers
- **Fixed** — a command, page or file whose text ran past 20,000 characters
  failed its task as "the computer stopped responding" and left the worker
  stuck on it; results are now cut in the middle, by the worker and, for a
  computer not updated yet, by the backend
- **Computers that are not on your PC** — `provision.ps1 -Name agent-03
  -RemoteHost <address>` installs the worker on a rented Ubuntu 24.04 machine
  (x86 or ARM) over SSH; list it as `agent-03@<address>` in `ORCH_AGENTS`. The
  backend opens one SSH connection out to it, so nothing on your PC is opened
  to the internet. It has its own disk, and runs the tasks of the agents you
  place on it
- **Safer computers** (update each with `provision.ps1 -Name <agent> -Update`) —
  `terminal.run` is retired: it ran programs as the worker's own user, outside
  the shell's sandbox. A page or a program can no longer close the fence around
  its text in the model's prompt. Chromium runs in its own sandbox when the
  computer allows one, WebSockets follow the same rule as requests, an answer
  from a private address closes the browser session, and the worker's service
  is kept off the local network
- The translations are now vufh's own (`windows/src/i18n`), without the 600
  strings nothing used any more
