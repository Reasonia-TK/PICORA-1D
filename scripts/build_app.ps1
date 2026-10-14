param([switch]$SkipBackend)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $ProjectRoot 'backend'
$UiRoot = Join-Path $ProjectRoot 'ui'
Push-Location $BackendRoot
try {
    & uv sync --group dist
    if ($LASTEXITCODE -ne 0) { throw '配布用依存関係の同期に失敗しました' }
    if (-not $SkipBackend) {
        & uv run --group dist python -m PyInstaller --noconfirm --clean (Join-Path $PSScriptRoot 'picora_backend.spec')
        if ($LASTEXITCODE -ne 0) { throw 'バックエンドのビルドに失敗しました' }
    }
    & uv run --group dist python (Join-Path $PSScriptRoot 'collect_licenses.py')
    if ($LASTEXITCODE -ne 0) { throw '依存ライセンスの収集に失敗しました' }
} finally { Pop-Location }
Push-Location $UiRoot
try {
    & npm.cmd run tauri -- build --config src-tauri/tauri.bundle.json
    if ($LASTEXITCODE -ne 0) { throw 'デスクトップアプリのビルドに失敗しました' }
} finally { Pop-Location }
Write-Host "配布物: $UiRoot\src-tauri\target\release\bundle\nsis"
