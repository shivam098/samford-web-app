param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 4317,
    [string]$GistId = 'a4237b7aa37de0c876d5c08a3c250d52',
    [string]$GitHubUser = 'shivam098',
    [switch]$NoGist
)
# Starts a temporary Cloudflare Quick Tunnel to the loopback demo and publishes its URL to the public discovery gist.
# The GitHub token is read from the gh credential store at runtime for this process only; it is never written to disk.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$cloudflared = Get-Command cloudflared -ErrorAction Stop
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health"
if ($health.status -ne 'ok' -or $health.synthetic -ne $true) { throw 'The expected synthetic Samford server is not ready. Start it first.' }
$meta = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/mobile/v1/meta"
Write-Warning 'PUBLIC SYNTHETIC DEMO: anyone with this temporary link can change shared sample data. No password gate.'

function Publish-Endpoint([string]$Status, [string]$Url, [string]$Message) {
    if ($NoGist) { return }
    $saved = @{}; foreach ($name in 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST') { $saved[$name] = [Environment]::GetEnvironmentVariable($name); [Environment]::SetEnvironmentVariable($name, $null) }
    try {
        $token = & gh auth token --hostname github.com --user $GitHubUser 2>$null
        if (-not $token) { Write-Warning "No gh credential for $GitHubUser; the discovery gist was not updated."; return }
        $env:GH_TOKEN = $token
        $login = & gh api user --jq '.login'
        if ($login -ne $GitHubUser) { Write-Warning "gh resolved to $login, not $GitHubUser; the discovery gist was not updated."; return }
        $endpoint = [ordered]@{
            schema = 'samford-endpoint/1'; status = $Status
            apiBaseUrl = $(if ($Url) { "$Url/api/mobile/v1" } else { $null }); webUrl = $(if ($Url) { "$Url/" } else { $null })
            updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
            minDoctorAppVersion = [int]$meta.minDoctorAppVersion; minPatientAppVersion = [int]$meta.minPatientAppVersion; synthetic = $true; message = $Message
        } | ConvertTo-Json
        $body = @{ files = @{ 'samford-endpoint.json' = @{ content = $endpoint } } } | ConvertTo-Json -Depth 5
        $body | & gh api --method PATCH "gists/$GistId" --input - | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning 'The discovery gist update failed.' } else { Write-Output "DISCOVERY_UPDATED $Status" }
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
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
if ($ready) { Publish-Endpoint 'online' $url 'Public synthetic demo. Anyone with the link can change shared sample data. Never enter real patient information.' }
else { Write-Warning 'The tunnel URL did not answer yet; the discovery gist was not switched online.' }
Write-Output "TUNNEL_READY $url cloudflared=$($process.Id)"
try { Wait-Process -Id $process.Id }
finally { Publish-Endpoint 'offline' $null 'The temporary tunnel stopped. Use the last known URL or ask the demo owner.' }
exit $process.ExitCode
