# Packdeck native helper build (idempotent).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1           # build if stale
#   powershell -NoProfile -ExecutionPolicy Bypass -File native/build.ps1 -Force    # always rebuild
#
# Compiles packdeck-procs.cs into packdeck-procs.exe with the C# compiler that ships with
# .NET Framework 4.8 (%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe). No SDK, no
# NuGet, no MSBuild project: the tool is one source file plus a System.Management reference.
#
# Idempotent: it only compiles when the source is newer than the binary (or the binary is
# missing), so calling it on every plugin start costs one stat and one compare.
#
# Exit codes: 0 = binary present and current (built or reused), 1 = build failed.
# Diagnostics go to stdout/stderr; the plugin treats a non-zero exit as "no native helper" and
# falls back to the PowerShell implementation.
#
# NOTE: this file stays ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI unless
# they carry a BOM, and non-ASCII text in comments has broken the parser before.

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $root 'packdeck-procs.cs'
$output = Join-Path $root 'packdeck-procs.exe'

if (-not (Test-Path -LiteralPath $source)) {
    Write-Error "missing source: $source"
    exit 1
}

# The C# compiler paired with the installed .NET Framework, 64-bit preferred.
$cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    Write-Error 'csc.exe not found (needs .NET Framework 4.x)'
    exit 1
}

$frameworkDir = Split-Path -Parent $csc
$management = Join-Path $frameworkDir 'System.Management.dll'
if (-not (Test-Path -LiteralPath $management)) {
    Write-Error "missing System.Management.dll: $management"
    exit 1
}

# Idempotency: rebuild only when the source is newer than the binary.
$needsBuild = $true
if (-not $Force -and (Test-Path -LiteralPath $output)) {
    $sourceTime = (Get-Item -LiteralPath $source).LastWriteTimeUtc
    $outputTime = (Get-Item -LiteralPath $output).LastWriteTimeUtc
    if ($outputTime -ge $sourceTime) {
        $needsBuild = $false
        Write-Output "native: up to date ($output)"
    }
}

if ($needsBuild) {
    $arguments = @(
        '/nologo',
        '/codepage:65001',
        '/optimize+',
        '/platform:anycpu',
        '/target:exe',
        "/out:$output",
        '/r:System.Management.dll',
        $source
    )

    $started = Get-Date
    $log = & $csc @arguments 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0 -or -not (Test-Path -LiteralPath $output)) {
        Write-Output ($log | Out-String)
        Write-Error "native: build failed (csc exit code $code)"
        exit 1
    }
    $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
    $warnings = @($log | Where-Object { $_ -like '*warning*' })
    if ($warnings.Count -gt 0) { Write-Output ($warnings | Out-String) }
    $size = (Get-Item -LiteralPath $output).Length
    Write-Output "native: built $output (${elapsed}ms, $size bytes)"
}

exit 0
