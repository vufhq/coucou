<#
  Creates an agent's persistent Linux computer as a WSL2 distro named after
  the agent, and installs the worker in it. Run it yourself, from the
  orchestrator folder:

      powershell -ExecutionPolicy Bypass -File worker\provision\provision.ps1                  # agent-01
      powershell -ExecutionPolicy Bypass -File worker\provision\provision.ps1 -Name agent-02   # another agent

  Then list every agent in ORCH_AGENTS in the orchestrator's .env
  (ORCH_AGENTS=agent-01,agent-02) and restart the backend.

  Run it again with -Update to copy a newer worker in and restart it; the
  distro, its disk and /workspace are kept.

  Every computer mounts one Windows folder, -SharedDir (D:\vufh-vms\shared
  unless you say otherwise), at /computer: the agents' own folders and the
  task folders live there, so any computer can run any agent. Give every
  computer the same -SharedDir.

  A computer that is not on this PC: -RemoteHost, a rented Ubuntu 24.04
  machine you can already reach with `ssh` as a user with sudo (x86 or ARM):

      powershell -ExecutionPolicy Bypass -File worker\provision\provision.ps1 -Name agent-03 -RemoteHost 203.0.113.7 -IdentityFile $HOME\.ssh\cloud.key

  -RemoteUser (ubuntu) and -RemotePort (22) say how. It copies the worker
  there over SSH, runs setup.sh, hands it its token, and lets your SSH keys
  open one thing as the machine's `agent` user: the socket the worker uses to
  talk to the backend on this PC. It creates, resizes and deletes no machine,
  and its /computer is that machine's own disk, not -SharedDir. Then list it
  in ORCH_AGENTS as agent-03@203.0.113.7 and restart the backend.

  What it does on this PC, and nothing else:
    1. wsl --install Ubuntu-24.04 --name <Name> --location <Location>   (first run only)
    2. creates -SharedDir if needed, gives you full control of it and makes it
       case-sensitive like a Linux folder (only while it is still empty)
    3. copies this folder's code into /opt/vufh-worker (a tar stream)
    4. runs worker/provision/setup.sh <Name> <SharedDir> inside the distro as root; it mounts
       -SharedDir at /computer, and moves what this computer had in /computer onto it
    5. pipes that agent's own worker token into /etc/vufh-worker/worker-token (never written on Windows)
    6. restarts the distro so /etc/wsl.conf applies (no Windows drive but -SharedDir, no Windows programs)
#>
param(
  [string]$Name = "agent-01",
  [string]$Location = "",
  [string]$SharedDir = "",
  [string]$RemoteHost = "",
  [string]$RemoteUser = "ubuntu",
  [int]$RemotePort = 22,
  [string]$IdentityFile = "",
  [switch]$Update
)

$ErrorActionPreference = "Stop"
# The agent id rule: it names the distro, the pill (agent_<name>) and the token.
if ($Name -cnotmatch '^[a-z0-9-]{1,24}$' -or $Name -eq "claude") {
  throw "-Name must be lowercase letters, digits and dashes (up to 24), e.g. agent-02."
}
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

function Invoke-Checked([string]$what, [scriptblock]$block) {
  Write-Host "==> $what"
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

if ($RemoteHost) {
  # Plain values only: each one ends up on an ssh command line.
  if ($RemoteHost -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$') {
    throw "-RemoteHost must be a host name or an IPv4 address, e.g. 203.0.113.7."
  }
  if ($RemoteUser -cnotmatch '^[a-z_][a-z0-9_-]{0,31}$') { throw "-RemoteUser must be a Linux user name, e.g. ubuntu." }
  if ($RemotePort -lt 1 -or $RemotePort -gt 65535) { throw "-RemotePort must be between 1 and 65535." }
  if (-not (Get-Command ssh.exe -ErrorAction SilentlyContinue)) {
    throw "ssh.exe was not found. Add Windows' OpenSSH Client (Settings, System, Optional features)."
  }
  # accept-new: the first connection remembers the machine's key (in your
  # known_hosts); the backend then refuses any other key.
  $ssh = @("-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=20", "-p", "$RemotePort")
  if ($IdentityFile) {
    if (-not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) { throw "-IdentityFile: $IdentityFile is not a file." }
    $IdentityFile = (Resolve-Path -LiteralPath $IdentityFile).Path
    if ($IdentityFile -match '"') { throw "-IdentityFile must not contain a quote." }
    $ssh += @("-i", $IdentityFile, "-o", "IdentitiesOnly=yes")
  }
  $target = "$RemoteUser@$RemoteHost"
  # Remote commands hold no double quote: Windows PowerShell would mangle one.
  function Invoke-Remote([string]$command) { & ssh.exe @ssh $target $command }

  Invoke-Checked "Reaching $target (it must let $RemoteUser use sudo without a password)" { Invoke-Remote "sudo -n true" }
  Invoke-Remote "test -d /opt/vufh-worker/worker"
  $installed = $LASTEXITCODE -eq 0
  if ($installed -and -not $Update) { throw "$RemoteHost already has a worker. Use -Update to refresh it." }
  if (-not $installed -and $Update) { throw "$RemoteHost has no worker yet; run without -Update first." }

  Invoke-Checked "Copying the worker to $RemoteHost" {
    Invoke-Remote "sudo rm -rf /opt/vufh-worker.new && sudo mkdir -p /opt/vufh-worker.new /opt/vufh-worker"
    if ($LASTEXITCODE -ne 0) { return }
    # Through cmd.exe: Windows PowerShell would turn the tar stream into text.
    $sshLine = ($ssh | ForEach-Object { if ($_ -match '[ ]') { "`"$_`"" } else { $_ } }) -join " "
    cmd.exe /c "tar.exe -C `"$root`" --exclude=node_modules --exclude=.data --exclude=.env --exclude=tests -cf - . | ssh.exe $sshLine $target sudo tar -C /opt/vufh-worker.new -xf -"
    if ($LASTEXITCODE -ne 0) { return }
    Invoke-Remote "sudo cp -a /opt/vufh-worker.new/. /opt/vufh-worker/ && sudo rm -rf /opt/vufh-worker.new"
  }

  Invoke-Checked "Setting up $Name on $RemoteHost (this takes a few minutes the first time)" {
    Invoke-Remote "sudo bash /opt/vufh-worker/worker/provision/setup.sh $Name remote"
  }

  Invoke-Checked "Handing the worker its token" {
    Push-Location $root
    try {
      node server/src/print-token.ts $Name |
        & ssh.exe @ssh $target "sudo sh -c 'umask 077 && mkdir -p /etc/vufh-worker && cat > /etc/vufh-worker/worker-token'"
    } finally { Pop-Location }
  }

  Invoke-Checked "Starting the worker" {
    Invoke-Remote "sudo systemctl restart vufh-computer.service vufh-runner.socket vufh-worker.service"
  }

  $entry = if ($RemotePort -eq 22) { "$Name@$RemoteHost" } else { "$Name@${RemoteHost}:$RemotePort" }
  Write-Host ""
  Write-Host "$Name is ready on $RemoteHost."
  Write-Host "List it in ORCH_AGENTS in $root\.env as $entry (for example ORCH_AGENTS=agent-01,$entry),"
  if ($IdentityFile) { Write-Host "add ORCH_SSH_KEY=$IdentityFile on its own line," }
  Write-Host "then restart the backend. It opens the connection itself and keeps it open; that key must work without a passphrase prompt."
  Write-Host "Worker log: ssh $target sudo journalctl -u vufh-worker -n 50"
  Write-Host "Shell log:  ssh $target sudo journalctl -u vufh-runner -n 50"
  return
}

# Computers made before the app was renamed live in D:\coucou-vms, shared
# folder included: they stay there, and new ones join them.
$vmRoot = if ((Test-Path "D:\coucou-vms") -and -not (Test-Path "D:\vufh-vms")) { "D:\coucou-vms" } else { "D:\vufh-vms" }
if (-not $Location) { $Location = "$vmRoot\$Name" }
if (-not $SharedDir) { $SharedDir = "$vmRoot\shared" }
# setup.sh checks the same rule: a plain Windows path, nothing a shell could read as more.
if ($SharedDir -notmatch '^[A-Za-z]:\\[-A-Za-z0-9 ._\\]+$') {
  throw "-SharedDir must be a plain Windows folder path (letters, digits, space, . _ - and \), e.g. D:\vufh-vms\shared."
}
$SharedDir = $SharedDir.TrimEnd('\')

$existing = (wsl.exe --list --quiet) -replace "`0", "" | Where-Object { $_.Trim() -eq $Name }
if (-not $existing) {
  if ($Update) { throw "$Name does not exist yet; run without -Update first." }
  New-Item -ItemType Directory -Force -Path $Location | Out-Null
  Invoke-Checked "Creating $Name in $Location" { wsl.exe --install Ubuntu-24.04 --name $Name --location $Location --no-launch }
} elseif (-not $Update) {
  throw "$Name already exists. Use -Update to refresh the worker, or remove it yourself first."
}

Write-Host "==> The folder every computer shares: $SharedDir"
New-Item -ItemType Directory -Force -Path $SharedDir | Out-Null
# WSL makes the folders it creates there case-sensitive only if you may change
# their attributes: full control, for you only (it is your folder).
& icacls.exe $SharedDir /grant "$($env:USERNAME):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed on $SharedDir (exit $LASTEXITCODE)" }
$caseInfo = & fsutil.exe file queryCaseSensitiveInfo $SharedDir
if ($caseInfo -notmatch 'enabled') {
  if (Get-ChildItem -Force -Path $SharedDir | Select-Object -First 1) {
    Write-Warning "$SharedDir is not empty, so it cannot be made case-sensitive; File.txt and file.txt would be one file."
  } else {
    & fsutil.exe file setCaseSensitiveInfo $SharedDir enable | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "fsutil could not make $SharedDir case-sensitive (exit $LASTEXITCODE)" }
  }
}

Invoke-Checked "Copying the worker into $Name" {
  # Through cmd.exe: Windows PowerShell would turn the tar stream into text.
  $unpack = "rm -rf /opt/vufh-worker.new && mkdir -p /opt/vufh-worker.new && tar -C /opt/vufh-worker.new -xf - && mkdir -p /opt/vufh-worker && cp -a /opt/vufh-worker.new/. /opt/vufh-worker/ && rm -rf /opt/vufh-worker.new"
  cmd.exe /c "tar.exe -C `"$root`" --exclude=node_modules --exclude=.data --exclude=.env --exclude=tests -cf - . | wsl.exe -d $Name -u root --exec sh -c `"$unpack`""
}

Invoke-Checked "Setting up $Name (this takes a few minutes the first time)" {
  wsl.exe -d $Name -u root --exec bash /opt/vufh-worker/worker/provision/setup.sh $Name $SharedDir
}

Invoke-Checked "Handing the worker its token" {
  Push-Location $root
  try {
    node server/src/print-token.ts $Name |
      wsl.exe -d $Name -u root --exec sh -c "umask 077 && mkdir -p /etc/vufh-worker && cat > /etc/vufh-worker/worker-token"
  } finally { Pop-Location }
}

Invoke-Checked "Restarting $Name" { wsl.exe --terminate $Name }
Invoke-Checked "Starting the worker" { wsl.exe -d $Name -u root --exec systemctl restart vufh-computer.service vufh-runner.socket vufh-worker.service }

Write-Host ""
Write-Host "$Name is ready."
if ($Name -ne "agent-01") {
  Write-Host "Add it to ORCH_AGENTS in $root\.env (for example ORCH_AGENTS=agent-01,$Name), then restart the backend."
}
Write-Host "Start the backend with: npm start   (in $root)"
Write-Host "Worker log: wsl -d $Name -u root --exec journalctl -u vufh-worker -n 50"
Write-Host "Shell log:  wsl -d $Name -u root --exec journalctl -u vufh-runner -n 50"
