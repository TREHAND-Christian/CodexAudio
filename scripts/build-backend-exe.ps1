param(
  [string]$Python = ".\.venv\Scripts\python.exe"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path $Python)) {
  throw "Python introuvable: $Python"
}

$iconIco = Join-Path $root "assets\CAC-logo.ico"
$iconPng = Join-Path $root "assets\CAC-logo.png"
$chatCss = Join-Path $root "python\translation_chat.css"
$backendEntry = Join-Path $root "python\codex_audio_backend.py"

& $Python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --windowed `
  --name CodexAudioBackend `
  --icon $iconIco `
  --distpath "backend-win" `
  --workpath "build\backend-pyinstaller" `
  --specpath "build\backend-pyinstaller" `
  --paths "python" `
  --add-data "${iconIco};assets" `
  --add-data "${iconPng};assets" `
  --add-data "${chatCss};python" `
  --hidden-import "winsdk.windows.media.speechsynthesis" `
  --hidden-import "winsdk.windows.media.core" `
  --hidden-import "winsdk.windows.media.playback" `
  $backendEntry
