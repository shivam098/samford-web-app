param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 4317,
    [Alias('NoGist')][switch]$NoPublish
)
# Manual fallback for a machine WITHOUT the Windows watchdog ("Public link watchdog - samford"): starts a temporary
# Cloudflare Quick Tunnel to the loopback demo and publishes it with scripts\Publish-PublicEndpoint.ps1 (discovery
# gist, then the permanent link https://shivam098.github.io/samford/). When cloudflared exits, both are marked offline.
# The GitHub token is read from gh at runtime by the publisher; it is never written to disk.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (Get-ScheduledTask -TaskName 'Public link watchdog - samford' -TaskPath '\' -ErrorAction SilentlyContinue) {
    throw "Windows owns this app's tunnel and links through the scheduled task 'Public link watchdog - samford'. Use that task (README: Permanent link and Windows recovery) instead; a second publisher would fight it."
}
$cloudflared = Get-Command cloudflared -ErrorAction Stop
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health"
if ($health.status -ne 'ok' -or $health.synthetic -ne $true) { throw 'The expected synthetic Samford server is not ready. Start it first.' }
Write-Warning 'PUBLIC SYNTHETIC DEMO: anyone with this temporary link can change shared sample data. No password gate.'

$publisher = Join-Path $PSScriptRoot 'scripts\Publish-PublicEndpoint.ps1'
function Publish-Endpoint([string[]]$Arguments) {
    if ($NoPublish) { return }
    & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File $publisher @Arguments -Port $Port
    if ($LASTEXITCODE -ne 0) { Write-Warning "Publishing failed ($LASTEXITCODE); see $env:LOCALAPPDATA\PublicLinks\samford\publish.log." }
}

$stdout = Join-Path $PSScriptRoot 'data\tunnel.out.log'; $stderr = Join-Path $PSScriptRoot 'data\tunnel.log'
$process = Start-Process -FilePath $cloudflared.Source -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate', '--protocol', 'http2') -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
$url = $null
for ($i = 0; $i -lt 120 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if ($process.HasExited) { throw "cloudflared exited with code $($process.ExitCode). See $stderr." }
    $text = "$(Get-Content -LiteralPath $stderr -Raw -ErrorAction SilentlyContinue) $(Get-Content -LiteralPath $stdout -Raw -ErrorAction SilentlyContinue)"
    if ($text -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $url = $Matches[0] }
}
if (-not $url) { Stop-Process -Id $process.Id; throw 'cloudflared did not report a Quick Tunnel URL within two minutes.' }
$ready = $false
for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
    try { $ready = (Invoke-RestMethod -Uri "$url/api/mobile/v1/meta" -TimeoutSec 10).synthetic -eq $true } catch { Start-Sleep -Seconds 3 }
}
@{ url = $url; cloudflaredPid = $process.Id; scriptPid = $PID; port = $Port; startedAt = (Get-Date).ToUniversalTime().ToString('o'); publicReady = $ready } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'data\tunnel.json') -Encoding utf8
if ($ready) { Publish-Endpoint @('-TunnelUrl', $url) }
else { Write-Warning 'The tunnel URL did not answer yet; nothing was published.' }
Write-Output "TUNNEL_READY $url cloudflared=$($process.Id)"
try { Wait-Process -Id $process.Id }
finally { Publish-Endpoint @('-Offline') }
exit $process.ExitCode
