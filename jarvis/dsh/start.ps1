param(
  [string]$HomePath = '',
  [string]$NodePath = '',
  [switch]$Desktop,
  [ValidateRange(1, 35)][int]$WaitSeconds = 25,
  [int]$BootProcessId = 0,
  [string]$BootNonce = ''
)
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$lock = $null

function Read-Registration([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch { return $null }
}

function Valid-Registration($Record) {
  try {
    return ($Record -and [long]$Record.pid -gt 0 -and [long]$Record.pid -le [int]::MaxValue -and
      ([DateTimeOffset]$Record.startedAt).UtcTicks -gt 0 -and
      $Record.url -eq $origin -and $Record.jarvisUrl -eq ($origin + 'jarvis/'))
  } catch { return $false }
}

function Registered-Process($Record) {
  if (!(Valid-Registration $Record)) { return $null }
  $service = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
  if (!$service) { return $null }
  try {
    $started = $service.StartTime.ToUniversalTime()
    if ($Record.processStartedAt) {
      if ($started.Ticks -ne ([DateTimeOffset]$Record.processStartedAt).UtcTicks) { return $null }
    } elseif ($started -gt ([DateTimeOffset]$Record.startedAt).UtcDateTime.AddSeconds(1)) {
      # Old registrations lack the OS birth time. A newer process is PID reuse.
      return $null
    }
    return $service
  } catch {
    $service.Refresh()
    if ($service.HasExited) { return $null }
    throw 'Cannot verify the registered process identity.'
  }
}

function Write-Registration([string]$Path, $Record) {
  $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($temporary, ($Record | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Write-DshEntry {
  # Manual callers still receive DSH's authenticated URL; Desktop never calls this.
  $logPath = Join-Path $jarvisHome 'server.log'
  if (Test-Path -LiteralPath $logPath) {
    $matches = [regex]::Matches((Get-Content -Raw -LiteralPath $logPath), [regex]::Escape($origin) + '\?token=[^\s]+')
    if ($matches.Count) { Write-Output $matches[$matches.Count - 1].Value; return }
  }
  Write-Output $origin
}

function Get-ServiceState {
  $runtime = Read-Registration $runtimeFile
  $pending = Read-Registration $pendingFile
  $runtimeProcess = Registered-Process $runtime
  $pendingProcess = Registered-Process $pending
  if ($runtimeProcess -and $pendingProcess -and $runtimeProcess.Id -ne $pendingProcess.Id) {
    return @{ Kind = 'failed'; Message = 'Two different live processes are registered for this profile.' }
  }
  $record = if ($runtimeProcess) { $runtime } elseif ($pendingProcess) { $pending } else { $null }
  $listeners = @([JarvisLauncherTcp]::ListenerPids([int]$launchConfig.port))
  if (!$listeners.Count) {
    if ($record) { return @{ Kind = 'starting'; Record = $record } }
    if (((Test-Path -LiteralPath $runtimeFile) -and !$runtime) -or ((Test-Path -LiteralPath $pendingFile) -and !$pending)) {
      return @{ Kind = 'failed'; Message = 'A process registration is unreadable; verify it before starting.' }
    }
    return @{ Kind = 'absent' }
  }
  if (!$record -or @($listeners | Where-Object { $_ -ne $record.pid }).Count) {
    return @{ Kind = 'conflict' }
  }
  try {
    $health = Invoke-RestMethod ($origin + 'jarvis/api/health') -TimeoutSec 1 -MaximumRedirection 0
  } catch {
    # This exact process owns the listener, but its Jarvis route may still be mounting.
    return @{ Kind = 'starting'; Record = $record }
  }
  if (!$health -or $health.app -ne 'jarvis' -or $health.runtime -ne 'dsh' -or $health.pid -ne $record.pid) {
    return @{ Kind = 'conflict' }
  }
  if (!(Registered-Process $record)) { return @{ Kind = 'failed'; Message = 'DSH exited while its readiness was being checked.' } }
  if ($health.ready -ne $true) { return @{ Kind = 'starting'; Record = $record } }
  if (!$runtimeProcess -or $runtime.pid -ne $record.pid) {
    # The boot adapter is the sole publisher; it remains alive after this caller times out.
    return @{ Kind = 'starting'; Record = $record }
  }
  return @{ Kind = 'ready'; Record = $record; Pending = $pending }
}

function Invoke-JarvisLaunch {
  # FileShare.None covers every caller, including other desktop processes and junction aliases.
  $lockPath = Join-Path $jarvisHome 'launcher.lock'
  while (!$script:lock) {
    try { $script:lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
      if (($_.Exception.HResult -band 65535) -notin @(32, 33)) { throw }
      if ($clock.Elapsed.TotalSeconds -ge $WaitSeconds) { return @{ Code = 3 } }
      Start-Sleep -Milliseconds 100
    }
  }
  $spawned = $null
  while ($clock.Elapsed.TotalSeconds -lt $WaitSeconds) {
    $state = Get-ServiceState
    switch ($state.Kind) {
      'conflict' { return @{ Code = 2 } }
      'failed' { return @{ Code = 1; Message = $state.Message } }
      'ready' {
        $record = $state.Record
        if ($state.Pending -and $state.Pending.pid -eq $record.pid -and $state.Pending.phase -ne 'ready') {
          $state.Pending.phase = 'ready'
          Write-Registration $pendingFile $state.Pending
        }
        return @{ Code = 0 }
      }
      'absent' {
        if ($spawned) {
          $spawned.phase = 'failed'
          Write-Registration $pendingFile $spawned
          return @{ Code = 1; Message = 'DSH exited. See server.err.log and server.log in the profile.' }
        }
        $nonce = if ($BootProcessId) { $BootNonce } else { [Guid]::NewGuid().ToString('N') }
        if ($BootProcessId) {
          $service = Get-Process -Id $BootProcessId -ErrorAction Stop
        } else {
          $launcher = Join-Path $PSScriptRoot 'launch-local.mjs'
          $arguments = @(('"{0}"' -f $launcher), ('"{0}"' -f $jarvisHome), '--launcher-nonce', $nonce)
          $service = Start-Process -FilePath $NodePath -WindowStyle Hidden -WorkingDirectory $repoPath -ArgumentList $arguments -RedirectStandardOutput (Join-Path $jarvisHome 'server.log') -RedirectStandardError (Join-Path $jarvisHome 'server.err.log') -PassThru
        }
        $spawned = [pscustomobject]@{
          pid = $service.Id; startedAt = [DateTime]::UtcNow.ToString('o')
          processStartedAt = $service.StartTime.ToUniversalTime().ToString('o')
          url = $origin; jarvisUrl = $origin + 'jarvis/'; phase = 'starting'; bootNonce = $nonce
        }
        Write-Registration $pendingFile $spawned
      }
    }
    Start-Sleep -Milliseconds 100
  }
  return @{ Code = 3 }
}

try {
  if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows.' }
  if (($BootProcessId -ne 0 -or $BootNonce) -and ($BootProcessId -le 0 -or $BootNonce -notmatch '^[a-f0-9]{32}$')) { throw 'Invalid internal boot handshake.' }
  $repoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
  if (!$HomePath) {
    if ($repoPath -match '^(?<home>.+)[\\/]profiles[\\/]jarvis[\\/](?:deployments[\\/][^\\/]+|node_modules[\\/]dsh-superagent)$') {
      $HomePath = $Matches.home
      $installedConfig = Read-Registration (Join-Path $HomePath 'launch.json')
      if (!$installedConfig -or $installedConfig.profile -ne 'jarvis') { throw 'Cannot verify the installed jarvis profile.' }
    } else {
      $HomePath = Join-Path $repoPath '.artifacts/jarvis-dsh/home'
    }
  }
  $jarvisHome = (Resolve-Path -LiteralPath $HomePath).Path
  $launchFile = Join-Path $jarvisHome 'launch.json'
  if (!(Test-Path -LiteralPath $launchFile)) { throw 'This profile must already have a launch.json; do not initialize an existing profile.' }
  $launchConfig = Get-Content -Raw -LiteralPath $launchFile | ConvertFrom-Json
  if ([int]$launchConfig.port -lt 1 -or [int]$launchConfig.port -gt 65535 -or !$launchConfig.profile -or !$launchConfig.dshPackage) { throw 'Invalid launch configuration.' }
  if (!$NodePath) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
    $NodePath = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
  }
  $version = & $NodePath -p 'process.versions.node' 2>$null
  if ($LASTEXITCODE -ne 0 -or [version]$version -lt [version]'22.19.0') { throw 'Node 22.19+ is required.' }
  $origin = "http://127.0.0.1:$($launchConfig.port)/"
  $runtimeFile = Join-Path $jarvisHome 'runtime.json'
  $pendingFile = Join-Path $jarvisHome 'launcher-state.json'
  . (Join-Path $PSScriptRoot 'listener-identity.ps1')
  $result = Invoke-JarvisLaunch
} catch {
  if ($jarvisHome) {
    try { [IO.File]::WriteAllText((Join-Path $jarvisHome 'launcher.err.log'), ($_.Exception.ToString() + [Environment]::NewLine + $_.ScriptStackTrace), (New-Object Text.UTF8Encoding $false)) } catch {}
  }
  $result = @{ Code = 1; Message = 'DSH could not start. Verify the configured profile, Node version and launcher logs.' }
} finally {
  if ($lock) { $lock.Dispose() }
}

switch ($result.Code) {
  0 { if ($Desktop) { Write-Output 'DSH ready.' } else { Write-DshEntry } }
  2 { [Console]::Error.WriteLine('The configured port is occupied by another or unverified service.') }
  3 {
    if ($Desktop) { Write-Output 'DSH is starting.' }
    else { Write-Output "DSH is starting. Open the DSH URL from $jarvisHome/server.log when ready." }
  }
  default {
    if ($Desktop) { [Console]::Error.WriteLine('DSH could not start. Check its local launcher logs.') }
    else { [Console]::Error.WriteLine($result.Message) }
  }
}
exit $result.Code
