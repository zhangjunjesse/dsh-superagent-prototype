param([string]$NodePath = '', [int]$Port = 4317)
$ErrorActionPreference = 'Stop'
$jarvisData = Join-Path $env:LOCALAPPDATA 'Jarvis-superagent'
New-Item -ItemType Directory -Force -Path $jarvisData | Out-Null
$jarvisUrl = "http://127.0.0.1:$Port"
try {
  $jarvisHealth = Invoke-RestMethod -Uri "$jarvisUrl/api/health" -TimeoutSec 2
  if ($jarvisHealth.app -eq 'jarvis' -and $jarvisHealth.ready) { Write-Output $jarvisUrl; exit 0 }
} catch {}
if (-not $NodePath) {
  $jarvisCandidates = @((Get-Command node -ErrorAction SilentlyContinue).Source, (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'))
  foreach ($jarvisCandidate in $jarvisCandidates) {
    if ($jarvisCandidate -and (Test-Path -LiteralPath $jarvisCandidate)) {
      $jarvisVersion = [version]((& $jarvisCandidate --version).TrimStart('v'))
      if ($jarvisVersion -ge [version]'22.19.0') { $NodePath = $jarvisCandidate; break }
    }
  }
}
if (-not $NodePath) { throw '需要 Node.js 22.19 或更新版本；可通过 -NodePath 指定。' }
$env:JARVIS_PORT = "$Port"
$env:JARVIS_DATA_DIR = $jarvisData
$jarvisEntry = Join-Path $PSScriptRoot 'main.mjs'
$jarvisProcess = Start-Process -FilePath $NodePath -ArgumentList @('"' + $jarvisEntry + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $jarvisData 'server.log') -RedirectStandardError (Join-Path $jarvisData 'server.err.log') -PassThru
for ($jarvisAttempt = 0; $jarvisAttempt -lt 30; $jarvisAttempt++) {
  Start-Sleep -Milliseconds 200
  if ($jarvisProcess.HasExited) { throw "服务启动失败，请查看 $jarvisData\server.err.log" }
  try {
    $jarvisHealth = Invoke-RestMethod -Uri "$jarvisUrl/api/health" -TimeoutSec 1
    if ($jarvisHealth.ready -and $jarvisHealth.pid -eq $jarvisProcess.Id) { Write-Output $jarvisUrl; exit 0 }
  } catch {}
}
throw "启动状态尚未确认；请查看 $jarvisData 下的日志和 runtime.json。"
