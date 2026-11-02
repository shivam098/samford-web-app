param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 4318,
    [switch]$Build
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Port -eq 4317) { throw 'Candidate preview must not use the running live port 4317.' }
if ($Build) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Candidate build failed.' }
}
$env:PORT = [string]$Port
$env:SAMFORD_DATA_DIR = Join-Path $PSScriptRoot 'data-candidate'
$env:SAMFORD_ASSET_DIR = Join-Path $PSScriptRoot 'dist-candidate'
& node --import tsx server\main.ts
exit $LASTEXITCODE
