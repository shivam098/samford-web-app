param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 4317
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$cloudflared = Get-Command cloudflared -ErrorAction Stop
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health"
if ($health.status -ne 'ok' -or $health.synthetic -ne $true) {
    throw 'The expected synthetic Samford server is not ready. Start it first.'
}
Write-Warning 'PUBLIC SYNTHETIC DEMO: anyone with this temporary link can change shared sample data. No password gate.'
& $cloudflared.Source tunnel --url "http://127.0.0.1:$Port" --no-autoupdate --protocol http2
exit $LASTEXITCODE
