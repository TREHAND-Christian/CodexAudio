param(
  [string]$VsixPath = "",
  [string]$FixedName = "codexaudio-latest.vsix"
)

$ErrorActionPreference = "Stop"
$extId = "trehand.codexaudio"

Write-Host "== CodexAudio update ==" -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm introuvable dans le PATH."
}

Write-Host "-> Build + package..." -ForegroundColor Yellow
@"
y
y
"@ | npm run package

if (-not $VsixPath) {
  $VsixPath = Get-ChildItem -Path . -Filter "codexaudio-*.vsix" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 |
    ForEach-Object { $_.FullName }
}

if (-not $VsixPath -or -not (Test-Path $VsixPath)) {
  throw "VSIX introuvable. Chemin: $VsixPath"
}

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
  throw "La commande 'code' n'est pas disponible. Active 'Shell Command: Install 'code' command in PATH' dans VS Code."
}

Write-Host "-> Uninstall $extId (si présent)..." -ForegroundColor Yellow
& code --uninstall-extension $extId | Out-Null

$fixedPath = Join-Path (Get-Location) $FixedName
Copy-Item -Force $VsixPath $fixedPath
Write-Host "-> Install VSIX: $fixedPath" -ForegroundColor Yellow
& code --install-extension $fixedPath --force | Out-Null

Write-Host "-> Reload VS Code window..." -ForegroundColor Yellow
& code . --reuse-window --command workbench.action.reloadWindow | Out-Null

Write-Host "OK." -ForegroundColor Green
