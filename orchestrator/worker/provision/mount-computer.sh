#!/usr/bin/env bash
# Mounts the host folder every computer shares at /computer, as root, before
# the worker and the runner start. Only that folder.
#
# On WSL (provision.ps1 -SharedDir) it is a Windows folder through drvfs, and
# wsl.conf still mounts no Windows drive.
#
# On a Mac (provision.sh) Lima mounts the Mac folder at /mnt/coucou-share over
# virtiofs, and nothing else of the Mac (worker/provision/lima/agent.yaml).
# virtiofs shows the Mac's owner and modes and has no uid=/gid=/umask= like
# drvfs, so bindfs re-presents it at /computer with the same rules: owned by
# runner:computer, 770 for folders, nobody else. Files are created on the Mac
# as the Mac user (--create-as-mounter); chown and chgrp are ignored, chmod
# reaches the Mac (an agent's `chmod +x` works).
#
# Everything on it belongs to runner:computer with mode 770 (a Windows folder
# keeps no Linux owners), so the runner and the worker (group computer) can
# both write, and nobody else can. case=dir: folders created here are case
# sensitive, like on Linux, because the top one is.
#
# On WSL, also writes /etc/resolv.conf (wsl.conf stops WSL from generating it: WSL
# links it into /mnt/wsl, which the worker and the runner cannot see, so
# neither could look up a name). 10.255.255.254 is WSL's DNS tunnel, the one
# resolver coucou-runner.service lets the runner reach.

# On Lima, systemd-resolved's stub (127.0.0.53, localhost to the runner) is kept.

set -euo pipefail

# COMPUTER_SHARE='D:\coucou-vms\shared' (WSL) or /mnt/coucou-share (Lima),
# COMPUTER_DRIVER=wsl|lima, written by setup.sh. An older setup.sh wrote no driver: WSL.
source /etc/coucou-worker/computer.env
COMPUTER_DRIVER="${COMPUTER_DRIVER:-wsl}"

if [[ "$COMPUTER_DRIVER" == wsl ]]; then
  rm -f /etc/resolv.conf
  printf 'nameserver 10.255.255.254\n' > /etc/resolv.conf
fi

if mountpoint -q /computer; then
  exit 0
fi
install -d -m 0770 /computer
runner_uid=$(id -u runner)
computer_gid=$(getent group computer | cut -d: -f3)
case "$COMPUTER_DRIVER" in
  wsl)
    mount -t drvfs "$COMPUTER_SHARE" /computer \
      -o "uid=$runner_uid,gid=$computer_gid,umask=007,case=dir"
    ;;
  lima)
    # Lima mounts the share after boot; wait for it rather than bind an empty folder.
    for _ in $(seq 1 60); do
      mountpoint -q "$COMPUTER_SHARE" && break
      sleep 1
    done
    if ! mountpoint -q "$COMPUTER_SHARE"; then
      echo "mount-computer.sh: $COMPUTER_SHARE is not mounted; is the Lima VM's shared folder there?" >&2
      exit 1
    fi
    bindfs -o allow_other \
      --force-user="$runner_uid" --force-group="$computer_gid" \
      --perms=u=rwX:g=rwX:o= \
      --create-as-mounter --chown-ignore --chgrp-ignore \
      "$COMPUTER_SHARE" /computer
    ;;
  *)
    echo "mount-computer.sh: unknown driver $COMPUTER_DRIVER" >&2
    exit 1
    ;;
esac
install -d /computer/tasks /computer/agents /computer/shared
