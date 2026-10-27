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

  Every computer mounts one Windows folder, -SharedDir (D:\coucou-vms\shared
  unless you say otherwise), at /computer: the agents' own folders and the
  task folders live there, so any computer can run any agent. Give every
  computer the same -SharedDir.

  What it does, and nothing else:
    1. wsl --install Ubuntu-24.04 --name <Name> --location <Location>   (first run only)
    2. creates -SharedDir if needed, gives you full control of it and makes it
       case-sensitive like a Linux folder (only while it is still empty)
    3. copies this folder's code into /opt/coucou-worker (a tar stream)
    4. runs worker/provision/setup.sh <Name> <SharedDir> inside the distro as root; it mounts
       -SharedDir at /computer, and moves what this computer had in /computer onto it
    5. pipes that agent's own worker token into /etc/coucou-worker/worker-token (never written on Windows)
    6. restarts the distro so /etc/wsl.conf applies (no Windows drive but -SharedDir, no Windows programs)
#>
param(
  [string]$Name = "agent-01",
  [string]$Location = "",
  [string]$SharedDir = "D:\coucou-vms\shared",
  [switch]$Update
)

$ErrorActionPreference = "Stop"
# The agent id rule: it names the distro, the pill (agent_<name>) and the token.
if ($Name -cnotmatch '^[a-z0-9-]{1,24}$' -or $Name -eq "claude") {
  throw "-Name must be lowercase letters, digits and dashes (up to 24), e.g. agent-02."
}
if (-not $Location) { $Location = "D:\coucou-vms\$Name" }
# setup.sh checks the same rule: a plain Windows path, nothing a shell could read as more.
if ($SharedDir -notmatch '^[A-Za-z]:\\[-A-Za-z0-9 ._\\]+$') {
  throw "-SharedDir must be a plain Windows folder path (letters, digits, space, . _ - and \), e.g. D:\coucou-vms\shared."
}
$SharedDir = $SharedDir.TrimEnd('\')
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")

function Invoke-Checked([string]$what, [scriptblock]$block) {
  Write-Host "==> $what"
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

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
  $unpack = "rm -rf /opt/coucou-worker.new && mkdir -p /opt/coucou-worker.new && tar -C /opt/coucou-worker.new -xf - && mkdir -p /opt/coucou-worker && cp -a /opt/coucou-worker.new/. /opt/coucou-worker/ && rm -rf /opt/coucou-worker.new"
  cmd.exe /c "tar.exe -C `"$root`" --exclude=node_modules --exclude=.data --exclude=.env --exclude=tests -cf - . | wsl.exe -d $Name -u root --exec sh -c `"$unpack`""
}

Invoke-Checked "Setting up $Name (this takes a few minutes the first time)" {
  wsl.exe -d $Name -u root --exec bash /opt/coucou-worker/worker/provision/setup.sh $Name $SharedDir
}

Invoke-Checked "Handing the worker its token" {
  Push-Location $root
  try {
    node server/src/print-token.ts $Name |
      wsl.exe -d $Name -u root --exec sh -c "umask 077 && mkdir -p /etc/coucou-worker && cat > /etc/coucou-worker/worker-token"
  } finally { Pop-Location }
}

Invoke-Checked "Restarting $Name" { wsl.exe --terminate $Name }
Invoke-Checked "Starting the worker" { wsl.exe -d $Name -u root --exec systemctl restart coucou-computer.service coucou-runner.socket coucou-worker.service }

Write-Host ""
Write-Host "$Name is ready."
if ($Name -ne "agent-01") {
  Write-Host "Add it to ORCH_AGENTS in $root\.env (for example ORCH_AGENTS=agent-01,$Name), then restart the backend."
}
Write-Host "Start the backend with: npm start   (in $root)"
Write-Host "Worker log: wsl -d $Name -u root --exec journalctl -u coucou-worker -n 50"
Write-Host "Shell log:  wsl -d $Name -u root --exec journalctl -u coucou-runner -n 50"
