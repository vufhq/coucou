#!/usr/bin/env bash
# Creates an agent's persistent Linux computer on a Mac, as a Lima VM named
# `coucou-<agent id>`, and installs the worker in it. The Mac's provision.ps1.
# Run it yourself, from the orchestrator folder:
#
#     worker/provision/provision.sh                    # agent-01
#     worker/provision/provision.sh --name agent-02    # another agent
#
# Then list every agent in ORCH_AGENTS in the orchestrator's .env
# (ORCH_AGENTS=agent-01,agent-02) and restart the backend.
#
# Run it again with --update to copy a newer worker in and restart it; the VM,
# its disk and /workspace are kept.
#
# Every computer mounts one Mac folder, --shared-dir (~/Library/Application
# Support/Coucou/computers/shared unless you say otherwise), at /computer: the
# agents' own folders and the task folders live there, so any computer can run
# any agent. Give every computer the same --shared-dir.
#
# Needs Lima (`brew install lima`) and Node.js 24 on the Mac.
#
# What it does, and nothing else:
#   1. limactl create --name coucou-<name> worker/provision/lima/agent.yaml   (first run only)
#   2. creates --shared-dir if needed, readable by you only
#   3. starts the VM and copies this folder's code into /opt/coucou-worker (a tar stream)
#   4. runs worker/provision/setup.sh <name> /mnt/coucou-share lima inside the VM as root
#   5. pipes that agent's own worker token into /etc/coucou-worker/worker-token (never written on the Mac)
#   6. restarts the computer's services

set -euo pipefail

NAME="agent-01"
SHARED_DIR="$HOME/Library/Application Support/Coucou/computers/shared"
UPDATE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:?--name needs an agent id}"; shift 2 ;;
    --shared-dir) SHARED_DIR="${2:?--shared-dir needs a folder}"; shift 2 ;;
    --update) UPDATE=1; shift ;;
    -h | --help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "provision.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

# The agent id rule: it names the VM, the pill (agent_<name>) and the token.
if [[ ! "$NAME" =~ ^[a-z0-9-]{1,24}$ || "$NAME" == "claude" ]]; then
  echo "--name must be lowercase letters, digits and dashes (up to 24), e.g. agent-02." >&2
  exit 2
fi
# A plain folder path: it goes into the VM's configuration as a YAML string.
if [[ ! "$SHARED_DIR" =~ ^/[-A-Za-z0-9\ ._/]+$ ]]; then
  echo "--shared-dir must be an absolute folder path (letters, digits, space, . _ - and /)." >&2
  exit 2
fi
SHARED_DIR="${SHARED_DIR%/}"
INSTANCE="coucou-$NAME"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

LIMACTL="${ORCH_LIMACTL:-$(command -v limactl || true)}"
if [[ -z "$LIMACTL" ]]; then
  echo "Lima is not installed. Install it with: brew install lima" >&2
  exit 1
fi
command -v node >/dev/null || { echo "Node.js 24 is needed on the Mac (brew install node)." >&2; exit 1; }

step() { printf '==> %s\n' "$1"; }
in_vm() { "$LIMACTL" shell --workdir / "$INSTANCE" sudo "$@"; }

existing="$("$LIMACTL" list --quiet 2>/dev/null | grep -Fx "$INSTANCE" || true)"
if [[ -z "$existing" ]]; then
  if [[ $UPDATE -eq 1 ]]; then
    echo "$INSTANCE does not exist yet; run without --update first." >&2
    exit 1
  fi
  step "The folder every computer shares: $SHARED_DIR"
  mkdir -p "$SHARED_DIR"
  chmod 700 "$SHARED_DIR"
  step "Creating $INSTANCE"
  "$LIMACTL" create --tty=false --name "$INSTANCE" \
    --set ".mounts[0].location = \"$SHARED_DIR\"" \
    "$HERE/lima/agent.yaml"
elif [[ $UPDATE -eq 0 ]]; then
  echo "$INSTANCE already exists. Use --update to refresh the worker, or remove it yourself first (limactl delete $INSTANCE)." >&2
  exit 1
fi
mkdir -p "$SHARED_DIR"

step "Starting $INSTANCE"
"$LIMACTL" start --tty=false "$INSTANCE" >/dev/null 2>&1 || "$LIMACTL" start --tty=false "$INSTANCE"

step "Copying the worker into $INSTANCE"
unpack="rm -rf /opt/coucou-worker.new && mkdir -p /opt/coucou-worker.new && tar -C /opt/coucou-worker.new -xf - && mkdir -p /opt/coucou-worker && cp -a /opt/coucou-worker.new/. /opt/coucou-worker/ && rm -rf /opt/coucou-worker.new"
# COPYFILE_DISABLE: no macOS ._ resource files in the copy.
COPYFILE_DISABLE=1 tar -C "$ROOT" --exclude=node_modules --exclude=.data --exclude=.env --exclude=tests -cf - . |
  in_vm sh -c "$unpack"

step "Setting up $INSTANCE (this takes a few minutes the first time)"
in_vm bash /opt/coucou-worker/worker/provision/setup.sh "$NAME" /mnt/coucou-share lima

step "Handing the worker its token"
(cd "$ROOT" && node server/src/print-token.ts "$NAME") |
  in_vm sh -c "umask 077 && mkdir -p /etc/coucou-worker && cat > /etc/coucou-worker/worker-token"

step "Starting the worker"
in_vm systemctl daemon-reload
in_vm systemctl restart coucou-computer.service coucou-runner.socket coucou-worker.service

echo
echo "$INSTANCE is ready."
if [[ "$NAME" != "agent-01" ]]; then
  echo "Add it to ORCH_AGENTS in $ROOT/.env (for example ORCH_AGENTS=agent-01,$NAME), then restart the backend."
fi
echo "Start the backend with: npm start   (in $ROOT)"
echo "Worker log: limactl shell $INSTANCE sudo journalctl -u coucou-worker -n 50"
echo "Shell log:  limactl shell $INSTANCE sudo journalctl -u coucou-runner -n 50"
