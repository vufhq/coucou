<#
  Creates agent-01, the agent's persistent Linux computer, as a WSL2 distro,
  and installs the worker in it. Run it yourself, from the orchestrator folder:

      powershell -ExecutionPolicy Bypass -File worker\provision\provision.ps1

  Run it again with -Update to copy a newer worker in and restart it; the
  distro, its disk and /workspace are kept.

  What it does, and nothing else:
    1. wsl --install Ubuntu-24.04 --name agent-01 --location <Location>   (first run only)
    2. copies this folder's code into /opt/coucou-worker (a tar stream: no shared folder)
    3. runs worker/provision/setup.sh inside the distro as root
    4. pipes the worker's token into /etc/coucou-worker/worker-token (never written on Windows)
    5. restarts the distro so /etc/wsl.conf applies (no Windows drives, no Windows programs)
#>
param(
  [string]$Name = "agent-01",
  [string]$Location = "D:\coucou-vms\agent-01",
  [switch]$Update
)

$ErrorActionPreference = "Stop"
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

Invoke-Checked "Copying the worker into $Name" {
  # Through cmd.exe: Windows PowerShell would turn the tar stream into text.
  $unpack = "rm -rf /opt/coucou-worker.new && mkdir -p /opt/coucou-worker.new && tar -C /opt/coucou-worker.new -xf - && mkdir -p /opt/coucou-worker && cp -a /opt/coucou-worker.new/. /opt/coucou-worker/ && rm -rf /opt/coucou-worker.new"
  cmd.exe /c "tar.exe -C `"$root`" --exclude=node_modules --exclude=.data --exclude=tests -cf - . | wsl.exe -d $Name -u root --exec sh -c `"$unpack`""
}

Invoke-Checked "Setting up $Name (this takes a few minutes the first time)" {
  wsl.exe -d $Name -u root --exec bash /opt/coucou-worker/worker/provision/setup.sh
}

Invoke-Checked "Handing the worker its token" {
  Push-Location $root
  try {
    node server/src/print-token.ts |
      wsl.exe -d $Name -u root --exec sh -c "umask 077 && mkdir -p /etc/coucou-worker && cat > /etc/coucou-worker/worker-token"
  } finally { Pop-Location }
}

Invoke-Checked "Restarting $Name" { wsl.exe --terminate $Name }
Invoke-Checked "Starting the worker" { wsl.exe -d $Name -u root --exec systemctl restart coucou-worker.service }

Write-Host ""
Write-Host "$Name is ready. Start the backend with: npm start   (in $root)"
Write-Host "Worker log: wsl -d $Name -u root --exec journalctl -u coucou-worker -n 50"
