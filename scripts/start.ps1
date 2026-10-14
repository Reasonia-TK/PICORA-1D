param([switch]$Browser)
$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $ProjectRoot 'backend'
$UiRoot = Join-Path $ProjectRoot 'ui'
$ReleaseExe = Join-Path $UiRoot 'src-tauri\target\release\picora-1d.exe'
if (-not $Browser -and (Test-Path -LiteralPath $ReleaseExe) -and (Test-Path -LiteralPath (Join-Path $UiRoot 'src-tauri\target\release\backend\picora-backend.exe'))) {
    Start-Process -FilePath $ReleaseExe
    exit 0
}
$PythonExe = Join-Path $BackendRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $PythonExe)) { throw 'scripts/setup.ps1 を先に実行してください' }
if (-not (Test-Path -LiteralPath (Join-Path $UiRoot 'node_modules'))) { throw 'scripts/setup.ps1 を先に実行してください' }
if (-not $Browser) {
    Push-Location $UiRoot
    try { & npm.cmd run tauri -- dev } finally { Pop-Location }
    exit $LASTEXITCODE
}
if (-not (Test-Path -LiteralPath (Join-Path $UiRoot 'dist\index.html'))) {
    Push-Location $UiRoot
    try {
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'UIビルドに失敗しました' }
    } finally { Pop-Location }
}
$BackendProcess = Start-Process -FilePath $PythonExe -ArgumentList @('-m', 'uvicorn', 'es_sim.server:app', '--host', '127.0.0.1', '--port', '8321') -WorkingDirectory $BackendRoot -WindowStyle Hidden -PassThru
try {
    $Ready = $false
    for ($Attempt = 0; $Attempt -lt 100; $Attempt++) {
        if ($BackendProcess.HasExited) { throw 'バックエンドが終了しました。ポート8321の使用状況を確認してください。' }
        try {
            $Health = Invoke-RestMethod 'http://127.0.0.1:8321/health' -TimeoutSec 1
            if ($Health.app -eq 'PICORA-1D') { $Ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 150
    }
    if (-not $Ready) { throw 'バックエンドの起動を確認できませんでした。' }
    Start-Process 'http://127.0.0.1:8321'
    Write-Host 'PICORA-1D: http://127.0.0.1:8321 / 終了は Ctrl+C'
    Wait-Process -Id $BackendProcess.Id
} finally {
    if (-not $BackendProcess.HasExited) { Stop-Process -Id $BackendProcess.Id -ErrorAction SilentlyContinue }
}
