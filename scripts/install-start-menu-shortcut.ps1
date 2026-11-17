#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ShortcutName = "RealPCtuber Codexia"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StartScript = Join-Path $PSScriptRoot "start-electron-app.ps1"
$ProgramsDir = [Environment]::GetFolderPath("Programs")
$ShortcutDir = Join-Path $ProgramsDir "Codexia"
$ShortcutPath = Join-Path $ShortcutDir "$ShortcutName.lnk"
$OldServerShortcutPath = Join-Path $ShortcutDir "RealPCtuber Codexia UI Server.lnk"
$PowerShellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

New-Item -ItemType Directory -Force -Path $ShortcutDir | Out-Null
Remove-Item -LiteralPath $OldServerShortcutPath -Force -ErrorAction SilentlyContinue

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $PowerShellPath
$shortcut.Arguments = ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $StartScript)
$shortcut.WorkingDirectory = $ProjectRoot
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.WindowStyle = 7
$shortcut.Description = "Start the RealPCtuber Codexia desktop app."
$shortcut.Save()

[PSCustomObject]@{
    status = "ok"
    shortcutPath = $ShortcutPath
    target = $StartScript
    removedOldServerShortcut = -not (Test-Path -LiteralPath $OldServerShortcutPath)
}
