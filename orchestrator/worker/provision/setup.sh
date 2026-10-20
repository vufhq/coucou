#!/usr/bin/env bash
# Sets up an agent's distro from inside it, as root: `setup.sh agent-02`.
# provision.ps1 runs it after copying the worker to /opt/coucou-worker;
# running it again updates in place.
#
#   - patched Ubuntu, an unprivileged `agent` user (no sudo), /workspace
#   - Node.js from nodejs.org, checked against its published SHA-256
#   - the worker's dependencies and Chromium for Playwright, owned by root
#   - /etc/wsl.conf (no Windows drives, no Windows programs) and the systemd unit

set -euo pipefail

NODE_VERSION="24.18.0"
APP=/opt/coucou-worker
AGENT_ID="${1:-agent-01}"

if [[ $EUID -ne 0 ]]; then
  echo "setup.sh must run as root" >&2
  exit 1
fi
# Same rule as the backend's AgentId.
if [[ ! "$AGENT_ID" =~ ^[a-z0-9-]{1,24}$ || "$AGENT_ID" == "claude" ]]; then
  echo "setup.sh: invalid agent id: $AGENT_ID" >&2
  exit 1
fi

echo "==> Updating Ubuntu"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends ca-certificates curl xz-utils

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

echo "==> The agent user and its workspace"
if ! id agent >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash agent
fi
# Never an administrator.
for group in sudo admin wheel; do
  gpasswd -d agent "$group" >/dev/null 2>&1 || true
done
install -d -o agent -g agent -m 0750 /workspace /workspace/tasks /workspace/.coucou /workspace/.coucou/home

echo "==> Worker dependencies and Chromium"
cd "$APP"
chown -R root:root "$APP"
npm ci --omit=dev --workspace=@coucou-orchestrator/worker --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH="$APP/browsers" npx --no-install playwright install --with-deps chromium
chmod -R a+rX "$APP"

echo "==> wsl.conf and the service"
install -m 0644 "$APP/worker/provision/wsl.conf" /etc/wsl.conf
install -m 0644 "$APP/worker/provision/coucou-worker.service" /etc/systemd/system/coucou-worker.service
install -d -m 0700 /etc/coucou-worker
printf 'ORCH_AGENT_ID=%s\n' "$AGENT_ID" > /etc/coucou-worker/agent.env
chmod 0600 /etc/coucou-worker/agent.env
# Enabled by hand: on the very first run systemd may not be PID 1 yet.
install -d /etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/coucou-worker.service /etc/systemd/system/multi-user.target.wants/coucou-worker.service
if [[ -d /run/systemd/system ]]; then
  systemctl daemon-reload
fi

echo "==> Done. Restart the distro (wsl --terminate $AGENT_ID) to apply wsl.conf."
