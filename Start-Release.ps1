param(
    [Parameter(Mandatory = $true)]
    [string]$ReleaseDirectory,
    [ValidateRange(1024, 65535)]
    [int]$Port = 4318,
    [switch]$UseSharedData
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$release = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$releasesRoot = (Join-Path $root 'data\releases') + '\'
if (-not $release.StartsWith($releasesRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Choose an immutable candidate under this project data\releases directory.' }
if ($UseSharedData -and $Port -ne 4317) { throw 'Shared data is only allowed on the live port 4317; this prevents a second server sharing the database.' }
if ($Port -eq 4317 -and -not $UseSharedData) { throw 'Live replacement needs an explicit -UseSharedData decision after testers finish and a backup is verified.' }
$manifest = Get-Content -LiteralPath (Join-Path $release 'release.json') -Raw | ConvertFrom-Json
foreach ($property in $manifest.hashes.PSObject.Properties) {
    $file = Join-Path $release $property.Name
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $property.Value) { throw "Release checksum mismatch: $($property.Name)" }
}
$env:PORT = [string]$Port
$env:SAMFORD_ASSET_DIR = Join-Path $release 'public'
$env:SAMFORD_DATA_DIR = Join-Path $root $(if ($UseSharedData) { 'data' } else { 'data-candidate' })
Set-Location -LiteralPath $release
& node .\server.mjs
exit $LASTEXITCODE
