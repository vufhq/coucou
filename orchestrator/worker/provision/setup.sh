#!/usr/bin/env bash
# Sets up an agent's distro from inside it, as root:
# `setup.sh agent-02 'D:\coucou-vms\shared'`.
# provision.ps1 runs it after copying the worker to /opt/coucou-worker;
# running it again updates in place.
#
#   - patched Ubuntu, an unprivileged `agent` user (no sudo), /workspace
#   - the computer: a second unprivileged `runner` user that runs the agents
#     shell commands in /computer, with python3, uv, git and a C compiler
#   - /computer: the Windows folder every computer shares, mounted by
#     coucou-computer.service (only that folder; no Windows drive)
#   - Node.js from nodejs.org, checked against its published SHA-256
#   - the worker's dependencies and Chromium for Playwright, owned by root
#   - /etc/wsl.conf (no Windows drives, no Windows programs) and the systemd unit

set -euo pipefail

NODE_VERSION="24.18.0"
UV_VERSION="0.9.5"
UV_SHA256="2cf10babba653310606f8b49876cfb679928669e7ddaa1fb41fb00ce73e64f66"
APP=/opt/coucou-worker
AGENT_ID="${1:-agent-01}"
COMPUTER_SHARE="${2:-D:\\coucou-vms\\shared}"

if [[ $EUID -ne 0 ]]; then
  echo "setup.sh must run as root" >&2
  exit 1
fi
# Same rule as the backend's AgentId.
if [[ ! "$AGENT_ID" =~ ^[a-z0-9-]{1,24}$ || "$AGENT_ID" == "claude" ]]; then
  echo "setup.sh: invalid agent id: $AGENT_ID" >&2
  exit 1
fi
# A Windows folder path, nothing a shell could read as more.
share_rule='^[A-Za-z]:[\][-A-Za-z0-9 ._\]+$'
if [[ ! "$COMPUTER_SHARE" =~ $share_rule ]]; then
  echo "setup.sh: invalid shared folder: $COMPUTER_SHARE" >&2
  exit 1
fi

echo "==> Updating Ubuntu"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends ca-certificates curl xz-utils   git python3 python3-venv python3-pip build-essential unzip

echo "==> Node.js ${NODE_VERSION}"
if [[ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]]; then
  tmp=$(mktemp -d)
  tarball="node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl -fsSLo "$tmp/$tarball" "https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  curl -fsSLo "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (cd "$tmp" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi
node --version

echo "==> uv ${UV_VERSION}"
if [[ "$(/usr/local/bin/uv --version 2>/dev/null || true)" != "uv ${UV_VERSION}"* ]]; then
  tmp=$(mktemp -d)
  tarball="uv-x86_64-unknown-linux-gnu.tar.gz"
  curl -fsSLo "$tmp/$tarball" "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${tarball}"
  echo "${UV_SHA256}  $tmp/$tarball" | sha256sum -c -
  tar -xzf "$tmp/$tarball" -C "$tmp" --no-same-owner
  install -m 0755 "$tmp/uv-x86_64-unknown-linux-gnu/uv" "$tmp/uv-x86_64-unknown-linux-gnu/uvx" /usr/local/bin/
  rm -rf "$tmp"
fi

echo "==> The agent user and its workspace"
if ! id agent >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash agent
fi
# Never an administrator.
for group in sudo admin wheel; do
  gpasswd -d agent "$group" >/dev/null 2>&1 || true
done
install -d -o agent -g agent -m 0750 /workspace /workspace/.coucou /workspace/.coucou/home

echo "==> The computer: the runner user and /computer"
# The runner runs what the agents write. It shares the group `computer` with
# the worker (for the task folders) and nothing else: not `agent`, so the
# worker's /workspace stays closed to it.
getent group computer >/dev/null || groupadd --system computer
if ! id runner >/dev/null 2>&1; then
  useradd --system --gid computer --home-dir /computer --no-create-home --shell /bin/bash runner
fi
for group in sudo admin wheel agent; do
  gpasswd -d runner "$group" >/dev/null 2>&1 || true
done
usermod -aG computer agent

echo "==> /computer: the folder every computer shares"
install -d -m 0700 /etc/coucou-worker
printf 'COMPUTER_SHARE=%q\n' "$COMPUTER_SHARE" > /etc/coucou-worker/computer.env
chmod 0600 /etc/coucou-worker/computer.env
if ! mountpoint -q /computer; then
  # This computer's own /computer, from before the shared folder: its files
  # move onto the share (nothing already there is overwritten). Parked in
  # /computer.local first, which a run stopped halfway leaves for the next.
  if [[ -d /computer && -n "$(ls -A /computer)" ]]; then
    mkdir -p /computer.local
    cp -r --update=none /computer/. /computer.local/
    rm -rf /computer
  fi
  bash "$APP/worker/provision/mount-computer.sh"
  if [[ -d /computer.local ]]; then
    cp -r --update=none /computer.local/. /computer/
    rm -rf /computer.local
  fi
fi
# Task folders from before the computer had a shell.
if [[ -d /workspace/tasks ]]; then
  cp -r --update=none /workspace/tasks/. /computer/tasks/
  rm -rf /workspace/tasks
fi

echo "==> Worker dependencies and Chromium"
cd "$APP"
chown -R root:root "$APP"
npm ci --omit=dev --workspace=@coucou-orchestrator/worker --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH="$APP/browsers" npx --no-install playwright install --with-deps chromium
# Readable by everyone, writable by root only (the copy from Windows arrives world-writable).
chmod -R u=rwX,go=rX "$APP"
rm -f "$APP/.env"

echo "==> wsl.conf and the service"
install -m 0644 "$APP/worker/provision/wsl.conf" /etc/wsl.conf
install -m 0644 "$APP/worker/provision/coucou-worker.service" /etc/systemd/system/coucou-worker.service
install -m 0644 "$APP/worker/provision/coucou-runner.service" /etc/systemd/system/coucou-runner.service
install -m 0644 "$APP/worker/provision/coucou-runner.socket" /etc/systemd/system/coucou-runner.socket
install -m 0644 "$APP/worker/provision/coucou-computer.service" /etc/systemd/system/coucou-computer.service
install -d -m 0700 /etc/coucou-worker
printf 'ORCH_AGENT_ID=%s\n' "$AGENT_ID" > /etc/coucou-worker/agent.env
chmod 0600 /etc/coucou-worker/agent.env
# Enabled by hand: on the very first run systemd may not be PID 1 yet.
install -d /etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/coucou-computer.service /etc/systemd/system/multi-user.target.wants/coucou-computer.service
ln -sf /etc/systemd/system/coucou-worker.service /etc/systemd/system/multi-user.target.wants/coucou-worker.service
install -d /etc/systemd/system/sockets.target.wants
ln -sf /etc/systemd/system/coucou-runner.socket /etc/systemd/system/sockets.target.wants/coucou-runner.socket
if [[ -d /run/systemd/system ]]; then
  systemctl daemon-reload
fi

echo "==> Done. Restart the distro (wsl --terminate $AGENT_ID) to apply wsl.conf."
