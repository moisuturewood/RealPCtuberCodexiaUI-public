#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Port = if ($env:PORT) { [int]$env:PORT } else { 48731 }
$BaseUrl = "http://127.0.0.1:$Port/"
$StateUrl = "${BaseUrl}api/state"
$LogDir = Join-Path $ProjectRoot "logs\server"
$LogPath = Join-Path $LogDir ("server_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))

function Test-UiServer {
    try {
        Invoke-RestMethod -Uri $StateUrl -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Open-UiWhenReady {
    param([string]$Url, [string]$State)

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes(@"
`$url = '$Url'
`$state = '$State'
for (`$i = 0; `$i -lt 80; `$i++) {
    try {
        Invoke-RestMethod -Uri `$state -TimeoutSec 2 | Out-Null
        Start-Process `$url
        exit 0
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
"@))
    Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        $encoded
    ) -WindowStyle Hidden | Out-Null
}

function Resolve-PnpmCommand {
    $pnpm = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
    if ($pnpm) {
        return $pnpm.Source
    }
    $pnpm = Get-Command "pnpm" -ErrorAction SilentlyContinue
    if ($pnpm) {
        return $pnpm.Source
    }
    return $null
}

if (Test-UiServer) {
    Write-Host "RealPCtuber Codexia UI is already running: $BaseUrl"
    if (-not $NoBrowser) {
        Start-Process $BaseUrl
    }
    return
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location -LiteralPath $ProjectRoot

$pnpm = Resolve-PnpmCommand
if (-not $pnpm) {
    $message = "pnpm was not found on PATH. Install Node.js/pnpm or start from a shell where pnpm works."
    $message | Tee-Object -FilePath $LogPath -Append
    Read-Host "Press Enter to close"
    exit 1
}

if (-not $NoBrowser) {
    Open-UiWhenReady -Url $BaseUrl -State $StateUrl
}

"[{0}] Starting RealPCtuber Codexia UI at {1}" -f (Get-Date -Format o), $BaseUrl |
    Tee-Object -FilePath $LogPath -Append

& $pnpm "start" 2>&1 | Tee-Object -FilePath $LogPath -Append

"[{0}] Server process exited." -f (Get-Date -Format o) |
    Tee-Object -FilePath $LogPath -Append

Read-Host "Server stopped. Press Enter to close"
