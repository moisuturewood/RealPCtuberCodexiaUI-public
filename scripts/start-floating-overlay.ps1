#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$BaseUrl = "http://127.0.0.1:48731",
    [switch]$StartDetached,
    [switch]$NoServerStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$OverlayScript = Join-Path $ProjectRoot "tools\floating_overlay.py"
$ServerScript = Join-Path $ProjectRoot "scripts\start-ui-server.ps1"
$LogDir = Join-Path $ProjectRoot "logs\overlay"

function Test-UiServer {
    try {
        Invoke-RestMethod -Uri "$BaseUrl/api/overlay-state" -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Resolve-UvCommand {
    $uv = Get-Command "uv.exe" -ErrorAction SilentlyContinue
    if ($uv) {
        return $uv.Source
    }
    $uv = Get-Command "uv" -ErrorAction SilentlyContinue
    if ($uv) {
        return $uv.Source
    }
    throw "uv was not found on PATH."
}

if (-not (Test-UiServer)) {
    if ($NoServerStart) {
        throw "UI server is not responding: $BaseUrl"
    }
    Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ServerScript, "-NoBrowser") `
        -WorkingDirectory $ProjectRoot `
        -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 80; $i++) {
        if (Test-UiServer) {
            break
        }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-UiServer)) {
        throw "UI server did not become ready: $BaseUrl"
    }
}

$uv = Resolve-UvCommand
$arguments = @("run", "python", $OverlayScript, "--base-url", $BaseUrl)

if ($StartDetached) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $stdout = Join-Path $LogDir "overlay_$stamp.out.log"
    $stderr = Join-Path $LogDir "overlay_$stamp.err.log"
    $launcher = Join-Path $LogDir "overlay_$stamp.launch.ps1"
    $quotedArgs = (($arguments | ForEach-Object { "'" + ($_ -replace "'", "''") + "'" }) -join ", ")
    $launcherScript = @"
Set-Location -LiteralPath '$($ProjectRoot -replace "'", "''")'
`$argsForUv = @($quotedArgs)
& '$($uv -replace "'", "''")' @argsForUv 1>> '$($stdout -replace "'", "''")' 2>> '$($stderr -replace "'", "''")'
"@
    Set-Content -LiteralPath $launcher -Value $launcherScript -Encoding UTF8
    $process = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $launcher) `
        -WindowStyle Hidden `
        -PassThru
    [pscustomobject]@{
        status = "started"
        pid = $process.Id
        stdout = $stdout
        stderr = $stderr
        launcher = $launcher
    } | ConvertTo-Json -Depth 4
    return
}

Set-Location -LiteralPath $ProjectRoot
& $uv @arguments
