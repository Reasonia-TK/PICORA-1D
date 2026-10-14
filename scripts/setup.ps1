param([switch]$Distribution)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $ProjectRoot 'backend')
try {
    $SyncArgs = @('sync')
    if ($Distribution) { $SyncArgs += @('--group', 'dist') }
    & uv @SyncArgs
    if ($LASTEXITCODE -ne 0) { throw 'Python依存関係の同期に失敗しました' }
} finally { Pop-Location }
Push-Location (Join-Path $ProjectRoot 'ui')
try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'UI依存関係の同期に失敗しました' }
} finally { Pop-Location }
