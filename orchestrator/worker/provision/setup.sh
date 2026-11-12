#!/usr/bin/env bash
# Sets up an agent's computer from inside it, as root:
# `setup.sh agent-02 'D:\vufh-vms\shared'` in a WSL distro, or
# `setup.sh agent-03 remote` on a rented Ubuntu machine (provision.ps1
# -RemoteHost). provision.ps1 runs it after copying the worker to
# /opt/vufh-worker; running it again updates in place.
#
#   - patched Ubuntu, an unprivileged `agent` user (no sudo), /workspace
#   - the computer: a second unprivileged `runner` user that runs the agents
#     shell commands in /computer, with python3, uv, git and a C compiler
#   - /computer: the Windows folder every computer shares, mounted by
#     vufh-computer.service (only that folder; no Windows drive)
#   - Node.js from nodejs.org, checked against its published SHA-256
#   - the worker's dependencies and Chromium for Playwright, owned by root
#   - /etc/wsl.conf (no Windows drives, no Windows programs) and the systemd unit
#
# On a remote machine there is no Windows folder and no wsl.conf: /computer is
# a folder on its own disk, and the backend reaches the worker through an SSH
# login that can do one thing, open the worker's socket (see "The backend's
# way in" below).

set -euo pipefail

NODE_VERSION="24.18.0"
UV_VERSION="0.9.5"
APP=/opt/vufh-worker
AGENT_ID="${1:-agent-01}"
COMPUTER_SHARE="${2:-D:\\vufh-vms\\shared}"

if [[ $EUID -ne 0 ]]; then
  echo "setup.sh must run as root" >&2
  exit 1
fi
# Same rule as the backend's AgentId.
if [[ ! "$AGENT_ID" =~ ^[a-z0-9-]{1,24}$ || "$AGENT_ID" == "claude" ]]; then
  echo "setup.sh: invalid agent id: $AGENT_ID" >&2
  exit 1
fi
# A Windows folder path, nothing a shell could read as more; or `remote`.
REMOTE=0
share_rule='^[A-Za-z]:[\][-A-Za-z0-9 ._\]+$'
if [[ "$COMPUTER_SHARE" == "remote" ]]; then
  REMOTE=1
elif [[ ! "$COMPUTER_SHARE" =~ $share_rule ]]; then
  echo "setup.sh: invalid shared folder: $COMPUTER_SHARE" >&2
  exit 1
fi

if [[ $REMOTE == 1 ]]; then
  # What the WSL distro is, and what this script was written against.
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
    echo "setup.sh: a remote computer must run Ubuntu 24.04 (this is ${PRETTY_NAME:-unknown})" >&2
    exit 1
  fi
fi

# A computer set up when the app had its former name: its units stop and go,
# and what it kept moves to the new names. Nothing here runs on a fresh one.
OLD=coucou
if [[ -e /etc/systemd/system/$OLD-worker.service || -d /etc/$OLD-worker || -d /opt/$OLD-worker ]]; then
  echo "==> Names from before the rename"
  if [[ -d /run/systemd/system ]]; then
    systemctl disable --now "$OLD-worker.service" "$OLD-runner.socket" "$OLD-runner.service" "$OLD-computer.service" 2>/dev/null || true
  fi
  rm -f /etc/systemd/system/$OLD-worker.service /etc/systemd/system/$OLD-runner.service \
    /etc/systemd/system/$OLD-runner.socket /etc/systemd/system/$OLD-computer.service \
    /etc/systemd/system/multi-user.target.wants/$OLD-worker.service \
    /etc/systemd/system/multi-user.target.wants/$OLD-computer.service \
    /etc/systemd/system/sockets.target.wants/$OLD-runner.socket
  rm -rf "/etc/systemd/system/$OLD-worker.service.d"
  # The worker's token and settings, its journal and its private git folder.
  if [[ -d /etc/$OLD-worker && ! -e /etc/vufh-worker ]]; then
    mv "/etc/$OLD-worker" /etc/vufh-worker
  fi
  if [[ -d /workspace/.$OLD && ! -e /workspace/.vufh ]]; then
    mv "/workspace/.$OLD" /workspace/.vufh
  fi
  # Chromium is a long download: it moves too.
  if [[ -d /opt/$OLD-worker/browsers && ! -e "$APP/browsers" ]]; then
    mv "/opt/$OLD-worker/browsers" "$APP/browsers"
  fi
  rm -rf "/opt/$OLD-worker" "/etc/$OLD-worker" "/workspace/.$OLD"
  if [[ -e /etc/apparmor.d/$OLD-chromium ]]; then
    apparmor_parser -R "/etc/apparmor.d/$OLD-chromium" 2>/dev/null || true
    rm -f "/etc/apparmor.d/$OLD-chromium"
  fi
  # A remote computer's SSH settings are written again below, under the new names.
  rm -f "/etc/ssh/$OLD-tunnel-keys" "/etc/ssh/sshd_config.d/60-$OLD-tunnel.conf"
fi

# Rented machines are often ARM (Oracle's free ones, for a start).
case "$(uname -m)" in
  x86_64)
    NODE_ARCH=x64
    UV_ARCH=x86_64
    UV_SHA256="2cf10babba653310606f8b49876cfb679928669e7ddaa1fb41fb00ce73e64f66"
    ;;
  aarch64)
    NODE_ARCH=arm64
    UV_ARCH=aarch64
    UV_SHA256="9db0c2f6683099f86bfeea47f4134e915f382512278de95b2a0e625957594ff3"
    ;;
  *)
    echo "setup.sh: unsupported processor: $(uname -m)" >&2
    exit 1
    ;;
esac

echo "==> Updating Ubuntu"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends ca-certificates curl xz-utils   git python3 python3-venv python3-pip build-essential unzip

echo "==> Node.js ${NODE_VERSION}"
if [[ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]]; then
  tmp=$(mktemp -d)
  tarball="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
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
  tarball="uv-${UV_ARCH}-unknown-linux-gnu.tar.gz"
  curl -fsSLo "$tmp/$tarball" "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${tarball}"
  echo "${UV_SHA256}  $tmp/$tarball" | sha256sum -c -
  tar -xzf "$tmp/$tarball" -C "$tmp" --no-same-owner
  install -m 0755 "$tmp/uv-${UV_ARCH}-unknown-linux-gnu/uv" "$tmp/uv-${UV_ARCH}-unknown-linux-gnu/uvx" /usr/local/bin/
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
install -d -o agent -g agent -m 0750 /workspace /workspace/.vufh /workspace/.vufh/home

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
install -d -m 0700 /etc/vufh-worker
printf 'COMPUTER_SHARE=%q\n' "$COMPUTER_SHARE" > /etc/vufh-worker/computer.env
chmod 0600 /etc/vufh-worker/computer.env
if [[ $REMOTE == 1 ]]; then
  # Its own disk: mount-computer.sh only makes the folders.
  bash "$APP/worker/provision/mount-computer.sh"
elif ! mountpoint -q /computer; then
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
npm ci --omit=dev --workspace=@vufh-orchestrator/worker --no-audit --no-fund
PLAYWRIGHT_BROWSERS_PATH="$APP/browsers" npx --no-install playwright install --with-deps chromium
# Readable by everyone, writable by root only (the copy from Windows arrives world-writable).
chmod -R u=rwX,go=rX "$APP"
rm -f "$APP/.env"

echo "==> The browser's sandbox"
# Where AppArmor rules the machine (Ubuntu 24.04 outside WSL), Chromium may
# create its sandbox's namespace only with a profile that says so.
if [[ -d /etc/apparmor.d ]] && command -v apparmor_parser >/dev/null 2>&1; then
  install -m 0644 "$APP/worker/provision/vufh-chromium.apparmor" /etc/apparmor.d/vufh-chromium
  if [[ -d /sys/kernel/security/apparmor ]]; then
    apparmor_parser -r /etc/apparmor.d/vufh-chromium
  fi
fi

echo "==> wsl.conf and the service"
if [[ $REMOTE == 0 ]]; then
  install -m 0644 "$APP/worker/provision/wsl.conf" /etc/wsl.conf
fi
install -m 0644 "$APP/worker/provision/vufh-worker.service" /etc/systemd/system/vufh-worker.service
install -m 0644 "$APP/worker/provision/vufh-runner.service" /etc/systemd/system/vufh-runner.service
install -m 0644 "$APP/worker/provision/vufh-runner.socket" /etc/systemd/system/vufh-runner.socket
install -m 0644 "$APP/worker/provision/vufh-computer.service" /etc/systemd/system/vufh-computer.service
install -d -m 0700 /etc/vufh-worker
printf 'ORCH_AGENT_ID=%s\n' "$AGENT_ID" > /etc/vufh-worker/agent.env
chmod 0600 /etc/vufh-worker/agent.env
# Enabled by hand: on the very first run systemd may not be PID 1 yet.
install -d /etc/systemd/system/multi-user.target.wants
ln -sf /etc/systemd/system/vufh-computer.service /etc/systemd/system/multi-user.target.wants/vufh-computer.service
ln -sf /etc/systemd/system/vufh-worker.service /etc/systemd/system/multi-user.target.wants/vufh-worker.service
install -d /etc/systemd/system/sockets.target.wants
ln -sf /etc/systemd/system/vufh-runner.socket /etc/systemd/system/sockets.target.wants/vufh-runner.socket

if [[ $REMOTE == 1 ]]; then
  echo "==> The backend's way in"
  # The worker talks to the backend through a socket the backend's SSH
  # connection opens in /workspace/.vufh: the worker's own folder, which the
  # runner (what the agents run) cannot enter. Nothing listens on a port, so
  # no command an agent runs can reach the backend. The WSL gateway's range is
  # closed too: here it is somebody else's network.
  install -d /etc/systemd/system/vufh-worker.service.d
  cat > /etc/systemd/system/vufh-worker.service.d/remote.conf <<'EOF'
[Service]
Environment=ORCH_BACKEND_SOCKET=/workspace/.vufh/backend.sock
IPAddressDeny=172.16.0.0/12
EOF

  # That connection logs in as `agent` with the keys of whoever ran this
  # script, kept in a file only root can change, and may do nothing but open
  # that socket: no shell, no command, no terminal, nothing forwarded out of
  # this machine. AllowTcpForwarding stays at `remote`: at `no`, OpenSSH 9.6
  # refuses the socket too (one permission list serves both), and with
  # GatewayPorts off the most that login could add is a port on this
  # machine's own loopback.
  admin="${SUDO_USER:-root}"
  admin_keys="$(getent passwd "$admin" | cut -d: -f6)/.ssh/authorized_keys"
  if [[ ! -s "$admin_keys" ]]; then
    echo "setup.sh: $admin has no SSH keys in $admin_keys; the backend would have no way in" >&2
    exit 1
  fi
  install -m 0644 -o root -g root "$admin_keys" /etc/ssh/vufh-tunnel-keys
  if ! grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
    echo "setup.sh: /etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d/*.conf" >&2
    exit 1
  fi
  tunnel_conf=/etc/ssh/sshd_config.d/60-vufh-tunnel.conf
  cat > "$tunnel_conf" <<'EOF'
# Written by vufh's setup.sh: the backend's connection to the worker.
Match User agent
    AuthorizedKeysFile /etc/ssh/vufh-tunnel-keys
    ForceCommand /usr/sbin/nologin
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    AllowTcpForwarding remote
    GatewayPorts no
    PermitTunnel no
    AllowStreamLocalForwarding remote
    StreamLocalBindUnlink yes
Match all
EOF
  # Never leave an SSH server that would not start again: this machine has no other door.
  if ! sshd -t; then
    rm -f "$tunnel_conf"
    echo "setup.sh: the SSH server refused vufh's settings; they were removed and nothing else changed" >&2
    exit 1
  fi
  systemctl reload ssh 2>/dev/null || systemctl reload sshd
else
  rm -rf /etc/systemd/system/vufh-worker.service.d/remote.conf
fi

if [[ -d /run/systemd/system ]]; then
  systemctl daemon-reload
fi

if [[ $REMOTE == 1 ]]; then
  echo "==> Done."
else
  echo "==> Done. Restart the distro (wsl --terminate $AGENT_ID) to apply wsl.conf."
fi
