<#
.SYNOPSIS
  Publishes the Samford demo's current public address: the mobile discovery gist first, then the permanent web
  link https://shivam098.github.io/samford/ (a GitHub Pages redirect page).

.DESCRIPTION
  App-owned publisher for the Windows "Public link watchdog - samford" task (config.json publishScript). The
  watchdog calls it with -TunnelUrl only when the Pages target differs from its verified working tunnel.

  1. Checks that <tunnel>/api/mobile/v1/meta answers as the synthetic demo.
  2. Updates the discovery gist and reads it back. A failure exits non-zero before Pages is touched, so the next
     watchdog check (5 minutes) retries with the same tunnel.
  3. Runs the installed link kit's Update-PublicLink.ps1 to repoint the Pages redirect.

  -Offline marks the gist offline (apiBaseUrl null) and makes the permanent link show "offline". To turn sharing
  off, run the kit's Set-PublicLinkSharing.ps1 -Off first (it pauses the watchdog and stops the tunnel but does not
  touch the gist), then this script with -Offline. Set-PublicLinkSharing.ps1 -On republishes everything through
  the watchdog.

  The shivam098 GitHub token is read from the gh credential store at runtime for this process only, after
  clearing GH_HOST/GH_TOKEN/GITHUB_TOKEN. It is never printed, logged or stored. Log: <StateDir>\publish.log.

.EXAMPLE
  .\scripts\Publish-PublicEndpoint.ps1 -TunnelUrl https://words.trycloudflare.com
.EXAMPLE
  .\scripts\Publish-PublicEndpoint.ps1 -Offline
.EXAMPLE
  .\scripts\Publish-PublicEndpoint.ps1 -TunnelUrl https://words.trycloudflare.com -DryRun
#>
[CmdletBinding(DefaultParameterSetName = 'online')]
param(
  [Parameter(Mandatory, ParameterSetName = 'online')][string]$TunnelUrl,
  [Parameter(Mandatory, ParameterSetName = 'offline')][switch]$Offline,
  [string]$GistId = 'a4237b7aa37de0c876d5c08a3c250d52',
  [string]$GitHubUser = 'shivam098',
  [ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$')][string]$PagesRepo = 'shivam098/samford',
  [ValidateRange(1024, 65535)][int]$Port = 4317,
  [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'PublicLinks\samford'),
  # Folder holding the link kit's Update-PublicLink.ps1. Default: the watchdog runtime, then the Downloads kit.
  [string]$PublicLinkScripts,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$owner, $name = $PagesRepo.Split('/')
$permanentLink = "https://$owner.github.io/$name/"
$taskName = "Public link watchdog - $name"
[void][IO.Directory]::CreateDirectory($StateDir)
$logPath = Join-Path $StateDir 'publish.log'
function Write-Log([string]$Message) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}{2}' -f (Get-Date), $(if ($DryRun) { '[dry run] ' } else { '' }), $Message
  if (-not $DryRun) { Add-Content -LiteralPath $logPath -Value $line -Encoding utf8 }
  Write-Output $line
}

$mutex = [Threading.Mutex]::new($false, "Local\SamfordEndpointPublish-$name")
try { $acquired = $mutex.WaitOne([TimeSpan]::FromMinutes(5)) } catch [Threading.AbandonedMutexException] { $acquired = $true }
if (-not $acquired) { Write-Log 'Another publish is still running; try again later.'; exit 1 }
$savedEnv = @{}
foreach ($variable in 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN') {
  $savedEnv[$variable] = [Environment]::GetEnvironmentVariable($variable)
  [Environment]::SetEnvironmentVariable($variable, $null)
}
try {
  if ($Offline) { $TunnelUrl = '' }
  else {
    $TunnelUrl = $TunnelUrl.TrimEnd('/')
    if ($TunnelUrl -cnotmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') { throw "Expected a Quick Tunnel origin such as https://words.trycloudflare.com, got '$TunnelUrl'." }
  }
  if ($Offline -and -not (Test-Path -LiteralPath (Join-Path $StateDir 'disabled'))) {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
    if ($task -and $task.State -ne 'Disabled') { Write-Warning "The watchdog is active and will republish its working tunnel at the next check. Turn sharing off first: Set-PublicLinkSharing.ps1 -ConfigPath `"$(Join-Path $StateDir 'config.json')`" -Off" }
  }

  # 1. The tunnel must serve the mobile API before apps are told to use it.
  $remote = $null
  if ($TunnelUrl) {
    for ($attempt = 0; $attempt -lt 3 -and -not $remote; $attempt++) {
      if ($attempt) { Start-Sleep -Seconds 5 }
      try { $answer = Invoke-RestMethod -Uri "$TunnelUrl/api/mobile/v1/meta" -TimeoutSec 20; if ($answer.synthetic -eq $true) { $remote = $answer } } catch { }
    }
    if (-not $remote) { throw "$TunnelUrl/api/mobile/v1/meta did not answer as the synthetic demo; nothing was published." }
  }
  $local = $null
  try { $answer = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/mobile/v1/meta" -TimeoutSec 15; if ($answer.synthetic -eq $true) { $local = $answer } } catch { }

  # 2. The discovery gist, with a runtime-only token for the expected account.
  $token = & gh auth token --hostname github.com --user $GitHubUser 2>$null
  if (-not $token) { throw "No stored github.com login for $GitHubUser in gh." }
  $env:GH_TOKEN = $token
  $login = & gh api user --jq '.login' 2>$null
  if ($login -ne $GitHubUser) { throw "gh resolved to '$login', not $GitHubUser; nothing was published." }
  $gist = & gh api "gists/$GistId" | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw "Could not read gist $GistId." }
  $current = $null
  try { $current = [string]$gist.files.'samford-endpoint.json'.content | ConvertFrom-Json } catch { }
  # Minimum app versions follow the running app. When it is down (offline publishing), keep the published values.
  $versions = if ($local) { $local } elseif ($remote) { $remote } else { $current }
  $endpoint = [ordered]@{
    schema = 'samford-endpoint/1'
    status = $(if ($TunnelUrl) { 'online' } else { 'offline' })
    apiBaseUrl = $(if ($TunnelUrl) { "$TunnelUrl/api/mobile/v1" } else { $null })
    webUrl = $(if ($TunnelUrl) { "$TunnelUrl/" } else { $null })
    updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    minDoctorAppVersion = $(if ($versions.minDoctorAppVersion) { [int]$versions.minDoctorAppVersion } else { 1 })
    minPatientAppVersion = $(if ($versions.minPatientAppVersion) { [int]$versions.minPatientAppVersion } else { 1 })
    synthetic = $true
    message = $(if ($TunnelUrl) { "Public synthetic demo. Web desks: $permanentLink . Anyone with the link can change shared sample data. Never enter real patient information." }
      else { "Sharing is off; the demo is not reachable right now. Web desks: $permanentLink shows when it is back." })
  }
  $same = $current -and $current.status -eq $endpoint.status -and $current.apiBaseUrl -eq $endpoint.apiBaseUrl -and $current.webUrl -eq $endpoint.webUrl -and
    [int]$current.minDoctorAppVersion -eq $endpoint.minDoctorAppVersion -and [int]$current.minPatientAppVersion -eq $endpoint.minPatientAppVersion -and $current.message -eq $endpoint.message
  $json = $endpoint | ConvertTo-Json
  if ($same) { Write-Log "Discovery gist already says $($endpoint.status)$(if ($TunnelUrl) { " at $($endpoint.apiBaseUrl)" })." }
  elseif ($DryRun) { Write-Log "Would publish to gist $GistId`n$json" }
  else {
    @{ files = @{ 'samford-endpoint.json' = @{ content = $json } } } | ConvertTo-Json -Depth 5 | & gh api --method PATCH "gists/$GistId" --input - | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'The discovery gist update was rejected.' }
    $readBack = [string](& gh api "gists/$GistId" --jq '.files["samford-endpoint.json"].content') | ConvertFrom-Json
    if ($readBack.status -ne $endpoint.status -or $readBack.apiBaseUrl -ne $endpoint.apiBaseUrl) { throw 'The discovery gist did not read back as published.' }
    Write-Log "Discovery gist: $($endpoint.status)$(if ($TunnelUrl) { " at $($endpoint.apiBaseUrl)" })."
  }

  # 3. The permanent web link, through the installed kit.
  $candidates = if ($PublicLinkScripts) { @(Join-Path $PublicLinkScripts 'Update-PublicLink.ps1') }
    else { @((Join-Path $StateDir 'runtime\Update-PublicLink.ps1'), (Join-Path $env:USERPROFILE 'Downloads\Localhost-Public-Link-Skill\scripts\Update-PublicLink.ps1')) }
  $update = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $update) { throw "Update-PublicLink.ps1 not found (looked in: $($candidates -join '; ')). Register the watchdog or pass -PublicLinkScripts." }
  $arguments = @('-NoProfile', '-NonInteractive', '-File', $update, '-PagesRepo', $PagesRepo, '-GitHubUser', $GitHubUser)
  $arguments += $(if ($TunnelUrl) { @('-TunnelUrl', $TunnelUrl, '-SkipTunnelCheck') } else { @('-Offline') })
  if ($DryRun) { $arguments += '-DryRun' }
  $output = & (Join-Path $PSHOME 'pwsh.exe') @arguments 2>&1
  $code = $LASTEXITCODE
  foreach ($line in $output) { Write-Log "Pages: $line" }
  if ($code -ne 0) { throw "Update-PublicLink.ps1 failed ($code)." }
  Write-Log "Done: $permanentLink $(if ($TunnelUrl) { "-> $TunnelUrl" } else { 'shows offline' })."
  exit 0
} catch {
  Write-Log "Publish failed: $($_.Exception.Message)"
  exit 1
} finally {
  foreach ($variable in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($variable, $savedEnv[$variable]) }
  $mutex.ReleaseMutex()
}
