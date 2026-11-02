param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 4317,
    [switch]$Build
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if ($Build) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. The server was not started.' }
}
$env:PORT = [string]$Port
& node --import tsx server\main.ts
exit $LASTEXITCODE
