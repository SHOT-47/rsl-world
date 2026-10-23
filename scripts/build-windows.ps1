[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:OS -ne 'Windows_NT') {
    throw 'This script must run in Windows PowerShell/PowerShell on Windows. It creates a Windows x64 NSIS installer.'
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $RepoRoot

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    Write-Host ("`n> {0} {1}" -f $Command, ($Arguments -join ' ')) -ForegroundColor Cyan
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
}

function Get-VersionLine([string]$Command, [string[]]$Arguments) {
    $text = (& $Command @Arguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Unable to query $Command version: $text" }
    return $text
}

$nodeVersionText = Get-VersionLine 'node' @('--version')
$nodeVersion = [version]($nodeVersionText.TrimStart('v'))
if ($nodeVersion -lt [version]'22.12.0') { throw "Node.js >=22.12.0 is required; found $nodeVersionText." }

$npmVersionText = Get-VersionLine 'npm' @('--version')
$npmVersion = [version]$npmVersionText
if ($npmVersion -lt [version]'10.9.0') { throw "npm >=10.9.0 is required; found $npmVersionText." }

$pythonCmd = Get-Command python -ErrorAction SilentlyContinue
if (-not $pythonCmd) { throw 'Python 3.10+ was not found on PATH. Install Python or set it on PATH before packaging.' }
$pythonVersionText = Get-VersionLine 'python' @('-I', '-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))')
$pythonVersion = [version]$pythonVersionText
if ($pythonVersion -lt [version]'3.10.0') { throw "Python >=3.10 is required; found $pythonVersionText." }

if ($Clean -and (Test-Path 'release')) { Remove-Item -Recurse -Force 'release' }

# The source handoff intentionally has no fabricated lockfile. On the first online Windows
# build, npm install resolves exact top-level versions and emits package-lock.json. Commit the
# resulting lockfile for fully repeatable subsequent builds; once present this script uses npm ci.
if (Test-Path 'package-lock.json') {
    Invoke-Checked 'npm' @('ci', '--no-audit', '--no-fund')
} else {
    Write-Warning 'package-lock.json is absent. Bootstrapping dependencies with npm install; capture and commit the generated lockfile before repeatable releases.'
    Invoke-Checked 'npm' @('install', '--no-audit', '--no-fund')
}

if (-not $SkipTests) {
    Invoke-Checked 'npm' @('run', 'typecheck')
    Invoke-Checked 'npm' @('test')
    Invoke-Checked 'npm' @('run', 'test:syntax')
    Invoke-Checked 'npm' @('run', 'test:static')
} else {
    Write-Warning 'Tests were explicitly skipped. Do not distribute this build as release-verified.'
}

Invoke-Checked 'npm' @('run', 'build')
# NSIS can be generated on Linux too, but native better-sqlite3/Windows lifecycle must be rebuilt
# and verified for Windows. This script deliberately builds on Windows x64 instead.
Invoke-Checked 'npx' @('electron-builder', '--win', 'nsis', '--x64')

$installer = Get-ChildItem -Path 'release' -Filter '*Setup.exe' -File |
    Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not $installer) { throw 'Build completed without producing the expected *Setup.exe installer in release/.' }

$hash = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumLine = "${hash}  $($installer.Name)"
Set-Content -LiteralPath (Join-Path $installer.DirectoryName 'SHA256SUMS.txt') -Value $checksumLine -Encoding utf8

$signingConfigured = [bool]($env:CSC_LINK -or $env:WIN_CSC_LINK -or $env:CSC_NAME)
$manifest = [ordered]@{
    product = 'RSL Workbench'
    version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
    target = 'win-x64-nsis'
    builtAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    hostOS = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
    node = $nodeVersionText
    npm = $npmVersionText
    python = $pythonVersionText
    installer = $installer.Name
    installerBytes = $installer.Length
    sha256 = $hash
    signingConfigured = $signingConfigured
    testsSkipped = [bool]$SkipTests
    lockfilePresent = (Test-Path 'package-lock.json')
}
$manifestPath = Join-Path $installer.DirectoryName 'build-manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
if (Test-Path 'package-lock.json') { Copy-Item -LiteralPath 'package-lock.json' -Destination (Join-Path $installer.DirectoryName 'package-lock.json') -Force }

Write-Host "`nNSIS installer created: $($installer.FullName)" -ForegroundColor Green
Write-Host "SHA-256: $hash" -ForegroundColor Green
if (-not $signingConfigured) {
    Write-Warning 'No explicit code-signing configuration was detected. Verify the resulting signature; unsigned installers may trigger Windows SmartScreen warnings.'
}
if (-not (Test-Path 'package-lock.json')) { Write-Warning 'No lockfile was generated; review release/package-lock.json (if present) and commit the lockfile for repeatable builds.' }
