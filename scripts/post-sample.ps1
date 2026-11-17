#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$Url = "http://127.0.0.1:48731/api/events"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$payload = @{
    threadId = "codex://threads/00000000-0000-0000-0000-000000000000"
    source = "codex-progress"
    kind = "progress"
    text = "Elinの移動経路を確認しています。危険な敵を避けながら花拠点へ向かいます。"
    priority = "normal"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json; charset=utf-8" -Body $payload
