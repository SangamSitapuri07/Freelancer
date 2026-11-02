param(
    [Parameter(Mandatory = $true)][string]$ServerUrl,
    [string]$Language = "C++",
    [string]$OutputDir = "artifacts",
    [switch]$SkipBuild
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $uri = [Uri]$ServerUrl
    $loopback = $uri.Host -in @("localhost", "127.0.0.1", "::1")
    if ($uri.Scheme -ne "https" -and -not ($uri.Scheme -eq "http" -and $loopback)) {
        throw "ServerUrl must use HTTPS except for loopback development."
    }
    if (-not $SkipBuild) { cargo build --release -p ghost_ai }
    $exe = Join-Path $root "target/release/ghost_ai.exe"
    if (-not (Test-Path $exe)) { throw "Build output not found: $exe" }
    New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
    $stage = Join-Path $OutputDir "GhostAI"
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item $exe (Join-Path $stage "ghost_ai.exe")
    @{ server_url = $uri.AbsoluteUri.TrimEnd('/'); language = $Language } |
        ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $stage "ghostai.config.json")
    @"
@echo off
start "" "%~dp0ghost_ai.exe"
"@ | Set-Content -Encoding ASCII (Join-Path $stage "Start-GhostAI.cmd")
    @"
GhostAI Windows client

1. Extract the whole ZIP.
2. Run Start-GhostAI.cmd or ghost_ai.exe.
3. Enter the 8-digit registration code supplied by the owner.

The client contacts the configured GhostAI control server. It does not contain
the Groq API key. Access, token limits, request limits, expiry, and revocation
are enforced by that server. Keep ghostai.config.json beside the executable.

This package uses the normal ghost_ai.exe process name. It does not impersonate
Windows components or install hidden persistence.
"@ | Set-Content -Encoding UTF8 (Join-Path $stage "README.txt")
    $zip = Join-Path $OutputDir "GhostAI-windows-x64.zip"
    if (Test-Path $zip) { Remove-Item -Force $zip }
    Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
    Get-FileHash $zip -Algorithm SHA256 | Format-List
    Write-Host "Created $zip"
}
finally { Pop-Location }
