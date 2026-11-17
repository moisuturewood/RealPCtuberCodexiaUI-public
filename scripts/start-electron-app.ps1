#requires -Version 5.1
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $ProjectRoot "logs\app-launch"
$LogPath = Join-Path $LogDir ("launch_{0}.log" -f (Get-Date -Format "yyyyMMdd_HHmmss"))
$MutexName = "Local\RealPCtuberCodexia.Launcher"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-LaunchLog {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Show-LaunchMessage {
    param(
        [string]$Message,
        [string]$Title = "RealPCtuber Codexia"
    )
    try {
        $shell = New-Object -ComObject WScript.Shell
        $null = $shell.Popup($Message, 8, $Title, 48)
    }
    catch {
        Write-LaunchLog ("Popup failed: {0}" -f $_.Exception.Message)
    }
}

function Resolve-PackageRunner {
    $candidatePaths = @(
        (Join-Path $env:APPDATA "npm\pnpm.cmd"),
        (Join-Path $env:LOCALAPPDATA "pnpm\pnpm.cmd"),
        "C:\Program Files\nodejs\pnpm.cmd"
    )
    foreach ($candidatePath in $candidatePaths) {
        if (Test-Path -LiteralPath $candidatePath) {
            return [PSCustomObject]@{
                Name = "pnpm"
                FilePath = $candidatePath
                Arguments = @("run", "start")
            }
        }
    }

    $corepackCandidates = @()
    $corepackCommand = Get-Command "corepack.cmd" -ErrorAction SilentlyContinue
    if ($corepackCommand) {
        $corepackCandidates += $corepackCommand.Source
    }
    $corepackCandidates += "C:\Program Files\nodejs\corepack.cmd"
    foreach ($corepackPath in ($corepackCandidates | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $corepackPath) {
            return [PSCustomObject]@{
                Name = "corepack pnpm"
                FilePath = $corepackPath
                Arguments = @("pnpm", "run", "start")
            }
        }
    }

    $command = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
    if ($command) {
        return [PSCustomObject]@{
            Name = "pnpm"
            FilePath = $command.Source
            Arguments = @("run", "start")
        }
    }

    $command = Get-Command "pnpm" -ErrorAction SilentlyContinue
    if ($command) {
        if ([IO.Path]::GetExtension($command.Source) -ieq ".js") {
            $node = Get-Command "node.exe" -ErrorAction SilentlyContinue
            if ($node) {
                return [PSCustomObject]@{
                    Name = "node pnpm.js"
                    FilePath = $node.Source
                    Arguments = @($command.Source, "run", "start")
                }
            }
        }
        else {
            return [PSCustomObject]@{
                Name = "pnpm"
                FilePath = $command.Source
                Arguments = @("run", "start")
            }
        }
    }

    throw "pnpm/corepack was not found. Install Node.js with Corepack or install pnpm."
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RealPCtuberWindow {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@

function Get-ProjectElectronProcessIds {
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -ieq "electron.exe" -and
            $_.CommandLine -like "*$ProjectRoot*" -and
            $_.CommandLine -match "dist[\\/]+electronMain\.js|--app-path="
        } |
        Select-Object -ExpandProperty ProcessId
}

function Focus-ExistingApp {
    $ids = @(Get-ProjectElectronProcessIds)
    if ($ids.Count -eq 0) {
        return $false
    }
    $windows = @(
        foreach ($id in $ids) {
            Get-Process -Id $id -ErrorAction SilentlyContinue |
                Where-Object { $_.MainWindowHandle -ne 0 }
        }
    )
    $window = $windows |
        Sort-Object @{ Expression = {
            if ($_.MainWindowTitle -eq "RealPCtuber Codexia UI") { 0 }
            elseif ($_.MainWindowTitle -eq "RealPCtuber Codexia") { 1 }
            elseif ($_.MainWindowTitle -eq "Floating Metan Avatar") { 2 }
            elseif ($_.MainWindowTitle -eq "Floating Metan Subtitle") { 3 }
            elseif ($_.MainWindowTitle -eq "Floating Metan") { 4 }
            else { 5 }
        } } |
        Select-Object -First 1
    if (-not $window) {
        Write-LaunchLog ("Existing Electron process found without a foreground window: {0}" -f ($ids -join ","))
        return $true
    }
    Write-LaunchLog ("Focusing existing window PID={0} Title='{1}'" -f $window.Id, $window.MainWindowTitle)
    [RealPCtuberWindow]::ShowWindowAsync($window.MainWindowHandle, 9) | Out-Null
    [RealPCtuberWindow]::SetForegroundWindow($window.MainWindowHandle) | Out-Null
    return $true
}

Set-Location -LiteralPath $ProjectRoot

Write-LaunchLog ("Launcher started. ProjectRoot={0}" -f $ProjectRoot)
Write-LaunchLog ("PATH={0}" -f $env:PATH)

if (Focus-ExistingApp) {
    Write-LaunchLog "Existing app handled; launcher exits."
    exit 0
}

$mutex = New-Object System.Threading.Mutex($false, $MutexName)
if (-not $mutex.WaitOne(0)) {
    Write-LaunchLog "Another launch is already in progress."
    Show-LaunchMessage "RealPCtuber Codexia は起動処理中です。少し待ってからもう一度見てください。"
    exit 0
}

try {
    $runner = Resolve-PackageRunner
    Write-LaunchLog ("Using runner: {0} {1}" -f $runner.FilePath, ($runner.Arguments -join " "))
    & $runner.FilePath @($runner.Arguments) *>&1 | Tee-Object -FilePath $LogPath -Append
    $exitCode = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    Write-LaunchLog ("Runner exited with code {0}" -f $exitCode)
    if ($exitCode -ne 0) {
        throw "Launcher command exited with code $exitCode. See $LogPath"
    }
}
catch {
    Write-LaunchLog ("ERROR: {0}" -f $_.Exception.Message)
    Show-LaunchMessage ("RealPCtuber Codexia の起動に失敗しました。`n`n{0}`n`nログ: {1}" -f $_.Exception.Message, $LogPath)
    exit 1
}
finally {
    try {
        $mutex.ReleaseMutex()
    }
    catch {
    }
    $mutex.Dispose()
}
