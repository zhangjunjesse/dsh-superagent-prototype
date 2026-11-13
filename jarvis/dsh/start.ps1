param(
  [string]$HomePath = '',
  [string]$NodePath = ''
)
$ErrorActionPreference = 'Stop'
$repoPath = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
if (!$HomePath) { $HomePath = Join-Path $repoPath '.artifacts/jarvis-dsh/home' }
$jarvisHome = (Resolve-Path -LiteralPath $HomePath).Path
$launchFile = Join-Path $jarvisHome 'launch.json'
if (!(Test-Path -LiteralPath $launchFile)) { throw 'Create a new isolated profile with setup-local.mjs first.' }
$launchConfig = Get-Content -Raw -LiteralPath $launchFile | ConvertFrom-Json
if (!$NodePath) {
  $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  $NodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
}
$version = & $NodePath -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.19.0') { throw 'Node 22.19+ is required.' }
$url = "http://127.0.0.1:$($launchConfig.port)/jarvis/"
function Write-DshEntry {
  # Use DSH's own authenticated launch URL; do not bypass the host login.
  $logPath = Join-Path $jarvisHome 'server.log'
  $origin = "http://127.0.0.1:$($launchConfig.port)/"
  if (Test-Path -LiteralPath $logPath) {
    $launchMatch = [regex]::Match((Get-Content -Raw -LiteralPath $logPath), [regex]::Escape($origin) + '\?token=[^\s]+')
    if ($launchMatch.Success) { Write-Output $launchMatch.Value; return }
  }
  Write-Output $origin
}
try { $health = Invoke-RestMethod ($url + 'api/health') -TimeoutSec 2 } catch { $health = $null }
if ($health) {
  $record = Get-Content -Raw -LiteralPath (Join-Path $jarvisHome 'runtime.json') | ConvertFrom-Json
  if ($health.app -eq 'jarvis' -and $health.runtime -eq 'dsh' -and $health.pid -eq $record.pid) { Write-DshEntry; exit }
  throw 'This port is already occupied by another instance.'
}
$launcher = Join-Path $PSScriptRoot 'launch-local.mjs'
$service = Start-Process -FilePath $NodePath -WindowStyle Hidden -WorkingDirectory $repoPath -ArgumentList @("`"$launcher`"", "`"$jarvisHome`"") -RedirectStandardOutput (Join-Path $jarvisHome 'server.log') -RedirectStandardError (Join-Path $jarvisHome 'server.err.log') -PassThru
for ($attempt = 0; $attempt -lt 15; $attempt++) {
  if ($service.HasExited) { throw "DSH exited. See $jarvisHome/server.err.log and server.log." }
  try { $health = Invoke-RestMethod ($url + 'api/health') -TimeoutSec 1 } catch { $health = $null }
  if ($health.ready -and $health.pid -eq $service.Id) { Write-DshEntry; exit }
  Start-Sleep -Milliseconds 1000
}
Write-Output "DSH is starting. Open the DSH URL from $jarvisHome/server.log when ready."
