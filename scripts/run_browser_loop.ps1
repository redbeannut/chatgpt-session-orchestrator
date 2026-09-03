# Browser Bridge 서버와 범용 ChatGPT 검증 루프를 한 명령으로 실행한다.
param(
    [Parameter(Mandatory = $true)]
    [string]$RunDir,
    [string]$Spec,
    [int]$TabId = 0,
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$env:PYTHONUTF8 = '1'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([System.IO.Path]::IsPathRooted($RunDir)) {
    $resolvedRunDir = [System.IO.Path]::GetFullPath($RunDir)
} else {
    $resolvedRunDir = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $RunDir))
}
$statePath = Join-Path $resolvedRunDir 'state.json'

& (Join-Path $PSScriptRoot 'start_browser_bridge.ps1') | Out-Null

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $prepareArgs = @(
        (Join-Path $projectRoot 'src\harness.py'),
        'prepare',
        '--run-dir',
        $resolvedRunDir
    )
    if ($Spec) {
        if ([System.IO.Path]::IsPathRooted($Spec)) {
            $resolvedSpec = [System.IO.Path]::GetFullPath($Spec)
        } else {
            $resolvedSpec = [System.IO.Path]::GetFullPath((Join-Path $projectRoot $Spec))
        }
        $prepareArgs += @('--spec', $resolvedSpec)
    }
    & python @prepareArgs
    if ($LASTEXITCODE -ne 0) {
        throw "작업 준비에 실패했습니다. 종료 코드 $LASTEXITCODE"
    }
}

$runnerArgs = @(
    (Join-Path $projectRoot 'src\browser_bridge_loop.mjs'),
    '--run-dir',
    $resolvedRunDir,
    '--timeout-seconds',
    $TimeoutSeconds
)
if ($TabId -gt 0) {
    $runnerArgs += @('--tab-id', $TabId)
}

& node @runnerArgs
exit $LASTEXITCODE
