#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$resolved = (Resolve-Path -LiteralPath $Path).Path
$player = [System.Media.SoundPlayer]::new($resolved)
$player.Load()
Write-Output "PLAYBACK_STARTED"
$player.PlaySync()
