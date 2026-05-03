param(
  [string]$VsixPath = "",
  [string]$FixedName = "codexaudio-latest.vsix"
)

$ErrorActionPreference = "Stop"

Write-Host "== CodexAudio update ==" -ForegroundColor Cyan

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm introuvable dans le PATH."
}

Write-Host "-> Build..." -ForegroundColor Yellow
npm run compile

# Force output name to avoid stale picks
$fixedPath = Join-Path (Get-Location) $FixedName
if (Test-Path $fixedPath) {
  Remove-Item -Force $fixedPath
}

Write-Host "-> Package VSIX..." -ForegroundColor Yellow
if ($VsixPath) {
  if (-not (Test-Path $VsixPath)) {
    throw "VSIX introuvable. Chemin: $VsixPath"
  }
  Copy-Item -Force $VsixPath $fixedPath
} else {
  & npx @vscode/vsce package --no-dependencies --allow-missing-repository -o $fixedPath | Out-Null
}

if (-not (Test-Path $fixedPath)) {
  throw "VSIX introuvable après packaging. Chemin: $fixedPath"
}

if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
  throw "La commande 'code' n'est pas disponible. Active 'Shell Command: Install 'code' command in PATH' dans VS Code."
}

Write-Host "-> Install VSIX: $fixedPath" -ForegroundColor Yellow
@"
y
"@ | code --install-extension $fixedPath --force | Out-Null

Write-Host "-> Reload VS Code window..." -ForegroundColor Yellow
# Ensure Ctrl+Alt+R is bound to reload (and not captured by terminal)
try {
  $kbRoot = Join-Path $env:APPDATA "Code\\User"
  if (-not (Test-Path $kbRoot)) {
    $kbRoot = Join-Path $env:APPDATA "Code - Insiders\\User"
  }
  $kbPath = Join-Path $kbRoot "keybindings.json"
  if (Test-Path $kbRoot) {
    $kb = @()
    if (Test-Path $kbPath) {
      $raw = Get-Content -Raw $kbPath
      try {
        $kb = @($raw | ConvertFrom-Json)
      } catch {
        $kb = $null
      }
    }
    if ($kb -ne $null) {
      $kb = @($kb | Where-Object {
        -not (
          ($_.key -eq "ctrl+alt+r") -and (
            $_.command -eq "workbench.action.reloadWindow" -or
            $_.command -eq "-workbench.action.terminal.runRecentCommand"
          )
        )
      })
      $kb += @{
        key = "ctrl+alt+r"
        command = "-workbench.action.terminal.runRecentCommand"
        when = "terminalFocus"
      }
      $kb += @{
        key = "ctrl+alt+r"
        command = "workbench.action.reloadWindow"
      }
      $json = $kb | ConvertTo-Json -Depth 5
      Set-Content -Path $kbPath -Value $json -Encoding UTF8
    }
  }
} catch {
  # ignore
}
# Reload: wait a bit so the correct session/cwd is ready, then simulate Ctrl+Alt+R
try {
  Add-Type -AssemblyName System.Windows.Forms
  $ws = New-Object -ComObject WScript.Shell
  $vs = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
  if ($vs) {
    $null = $ws.AppActivate($vs.MainWindowTitle)
  } else {
    $null = $ws.AppActivate("Visual Studio Code")
  }
  Start-Sleep -Milliseconds 1200
  [System.Windows.Forms.SendKeys]::SendWait("^%r")
} catch {
  # ignore
}

Write-Host "OK." -ForegroundColor Green
