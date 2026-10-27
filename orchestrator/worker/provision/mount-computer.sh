#!/usr/bin/env bash
# Mounts the Windows folder every computer shares (provision.ps1 -SharedDir)
# at /computer, as root, before the worker and the runner start. Only that
# folder: wsl.conf still mounts no Windows drive.
#
# Everything on it belongs to runner:computer with mode 770 (a Windows folder
# keeps no Linux owners), so the runner and the worker (group computer) can
# both write, and nobody else can. case=dir: folders created here are case
# sensitive, like on Linux, because the top one is.

set -euo pipefail

# COMPUTER_SHARE='D:\coucou-vms\shared', written by setup.sh.
source /etc/coucou-worker/computer.env

if mountpoint -q /computer; then
  exit 0
fi
install -d -m 0770 /computer
mount -t drvfs "$COMPUTER_SHARE" /computer \
  -o "uid=$(id -u runner),gid=$(getent group computer | cut -d: -f3),umask=007,case=dir"
install -d /computer/tasks /computer/agents /computer/shared
