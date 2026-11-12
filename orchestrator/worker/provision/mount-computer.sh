#!/usr/bin/env bash
# Mounts the Windows folder every computer shares (provision.ps1 -SharedDir)
# at /computer, as root, before the worker and the runner start. Only that
# folder: wsl.conf still mounts no Windows drive.
#
# Everything on it belongs to runner:computer with mode 770 (a Windows folder
# keeps no Linux owners), so the runner and the worker (group computer) can
# both write, and nobody else can. case=dir: folders created here are case
# sensitive, like on Linux, because the top one is.
#
# Also writes /etc/resolv.conf (wsl.conf stops WSL from generating it: WSL
# links it into /mnt/wsl, which the worker and the runner cannot see, so
# neither could look up a name). 10.255.255.254 is WSL's DNS tunnel, the one
# resolver vufh-runner.service lets the runner reach.
#
# On a remote computer (COMPUTER_SHARE=remote) there is no Windows folder:
# /computer is a folder on the machine's own disk, with the same owners, and
# its name lookups are left as the machine has them.

set -euo pipefail

# COMPUTER_SHARE='D:\vufh-vms\shared' or 'remote', written by setup.sh.
source /etc/vufh-worker/computer.env

if [[ "$COMPUTER_SHARE" == "remote" ]]; then
  # Set-group-id folders: what the worker creates stays writable by the runner.
  install -d -o runner -g computer -m 2770 /computer /computer/tasks /computer/agents /computer/shared
  exit 0
fi

rm -f /etc/resolv.conf
printf 'nameserver 10.255.255.254\n' > /etc/resolv.conf

if mountpoint -q /computer; then
  exit 0
fi
install -d -m 0770 /computer
mount -t drvfs "$COMPUTER_SHARE" /computer \
  -o "uid=$(id -u runner),gid=$(getent group computer | cut -d: -f3),umask=007,case=dir"
install -d /computer/tasks /computer/agents /computer/shared
