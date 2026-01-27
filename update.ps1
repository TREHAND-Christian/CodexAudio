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
  & npx @vscode/vsce package --no-dependencies -o $fixedPath | Out-Null
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
$reloadArgs = @(".", "--reuse-window", "--command", "workbench.action.reloadWindow")
if (-not $env:VSCODE_IPC_HOOK_CLI) {
  try {
    $codeCmd = (Get-Command code -ErrorAction Stop).Source
    $codeRoot = Split-Path (Split-Path $codeCmd)
    $shellIntegration = Join-Path $codeRoot "resources\\app\\out\\vs\\workbench\\contrib\\terminal\\common\\scripts\\shellIntegration.ps1"
    if (Test-Path $shellIntegration) {
      . $shellIntegration
    }
  } catch {
    # ignore
  }
}
Write-Host ("   [debug] VSCODE_IPC_HOOK_CLI=" + ($env:VSCODE_IPC_HOOK_CLI ?? "<not set>")) -ForegroundColor DarkGray
Write-Host "   [debug] code . --reuse-window --command workbench.action.reloadWindow" -ForegroundColor DarkGray
& code @reloadArgs | Out-Null
if (-not $env:VSCODE_IPC_HOOK_CLI) {
  # Fallback: send the exact command via Command Palette in the active VS Code window
  Write-Host "   [debug] fallback: sending Ctrl+Shift+P -> 'Développeur : Recharger la fenêtre'" -ForegroundColor DarkGray
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $ws = New-Object -ComObject WScript.Shell
    $vs = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1
    if ($vs) {
      $null = $ws.AppActivate($vs.MainWindowTitle)
    } else {
      $null = $ws.AppActivate("Visual Studio Code")
    }
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("^+p")
    Start-Sleep -Milliseconds 200
    [System.Windows.Forms.SendKeys]::SendWait("Développeur : Recharger la fenêtre")
    Start-Sleep -Milliseconds 150
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  } catch {
    # ignore
  }
}

Write-Host "OK." -ForegroundColor Green
