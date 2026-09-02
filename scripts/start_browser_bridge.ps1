# Windows에서 Browser Bridge 서버를 중복 없이 숨김 실행하고 상태만 확인한다.
param(
    [string]$BridgeRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'tools\browser-bridge')
)

$ErrorActionPreference = 'Stop'
$serverEntry = Join-Path $BridgeRoot 'server\dist\index.js'
$serverDirectory = Split-Path -Parent $serverEntry
$runtimeDirectory = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.browser-bridge'
$healthUrl = 'http://127.0.0.1:8765/health'

if (-not (Test-Path -LiteralPath $serverEntry -PathType Leaf)) {
    throw "Browser Bridge 서버 빌드가 없습니다: $serverEntry"
}

try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
} catch {
    New-Item -ItemType Directory -Force -Path $runtimeDirectory | Out-Null
    $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
    Start-Process -FilePath $nodeExecutable `
        -ArgumentList $serverEntry `
        -WorkingDirectory $serverDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtimeDirectory 'server.log') `
        -RedirectStandardError (Join-Path $runtimeDirectory 'server.err.log')
    Start-Sleep -Seconds 2
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
}

$health | ConvertTo-Json -Compress
