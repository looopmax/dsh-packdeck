# Publish dsh-packdeck to npm
#
# Run this in an interactive PowerShell window (it needs your npm credentials).
# Everything else is already verified: name is unclaimed, 48 files packed, dry-run passes.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File publish-npm.ps1
#
# What it does:
#   1. points npm at registry.npmjs.org for this publish only (your global .npmrc stays on the mirror)
#   2. logs you in (browser flow; fall back to a token with -Token)
#   3. publishes with --access public
#   4. verifies the published version is anonymously reachable

param(
  [string]$Token
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$REG = 'https://registry.npmjs.org'

Write-Host '== 1/4 preflight ==' -ForegroundColor Cyan
$pkg = Get-Content package.json -Raw | ConvertFrom-Json
Write-Host "   package : $($pkg.name)@$($pkg.version)"
if ($pkg.private -eq $true) { throw 'package.json has "private": true — npm refuses to publish it.' }

$existing = $null
try {
  $resp = Invoke-WebRequest "$REG/$($pkg.name)" -UseBasicParsing -TimeoutSec 20 -ErrorAction Stop
  $existing = ($resp.Content | ConvertFrom-Json).versions.PSObject.Properties.Name | Select-Object -Last 1
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
}
if ($existing) {
  Write-Host "   version $($pkg.version) may already exist (latest on npm: $existing)" -ForegroundColor Yellow
  Write-Host '   Bump "version" in package.json before publishing again.' -ForegroundColor Yellow
  return
}
Write-Host '   name is unclaimed, version is new' -ForegroundColor Green

Write-Host '== 2/4 authentication ==' -ForegroundColor Cyan
if ($Token) {
  # Token auth: written to a throwaway userconfig so the global .npmrc is untouched.
  $tmp = Join-Path $env:TEMP "npmrc-publish-$PID"
  "//registry.npmjs.org/:_authToken=$Token" | Set-Content $tmp -NoNewline
  $env:NPM_CONFIG_USERCONFIG = $tmp
  Write-Host '   using -Token (temporary userconfig)'
} else {
  npm login --registry=$REG --auth-type=web
  if ($LASTEXITCODE -ne 0) { throw 'npm login failed' }
}

$who = (npm whoami --registry=$REG) 2>&1
if ($LASTEXITCODE -ne 0) { throw "not logged in: $who" }
Write-Host "   logged in as $who" -ForegroundColor Green

Write-Host '== 3/4 publish ==' -ForegroundColor Cyan
npm publish --registry=$REG --access public
if ($LASTEXITCODE -ne 0) { throw 'npm publish failed — see the output above' }

Write-Host '== 4/4 verify (anonymous) ==' -ForegroundColor Cyan
Start-Sleep -Seconds 5
try {
  $v = Invoke-WebRequest "https://registry.npmjs.org/$($pkg.name)/latest" -UseBasicParsing -TimeoutSec 30
  $j = $v.Content | ConvertFrom-Json
  if ($j.version -eq $pkg.version) {
    Write-Host "   LIVE: https://www.npmjs.com/package/$($pkg.name)/v/$($j.version)" -ForegroundColor Green
  } else {
    Write-Host "   registry reports $($j.version) (propagation can lag a minute)" -ForegroundColor Yellow
  }
} catch {
  Write-Host "   could not verify yet: $($_.Exception.Message)" -ForegroundColor Yellow
}

if (Test-Path Env:NPM_CONFIG_USERCONFIG) {
  Remove-Item $env:NPM_CONFIG_USERCONFIG -Force -ErrorAction SilentlyContinue
  Remove-Item Env:NPM_CONFIG_USERCONFIG -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'Done. Users can now install with:' -ForegroundColor Cyan
Write-Host '   plugin_manager install_bundle target=dsh-packdeck'
