$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This CI installer requires Windows.'
}
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_PATH) {
    throw 'RUNNER_TEMP and GITHUB_PATH are required.'
}

# Same 9.0.2 essentials archive used by the existing Chocolatey package.
# Pin both version and digest; never resolve latest or fetch a checksum at runtime.
# Provenance: https://github.com/chocolatey-community/chocolatey-packages/blob/e79702655971932f395c5a9cf4be5b649546cd28/automatic/ffmpeg/legal/VERIFICATION.txt
# The vendor's fixed release asset independently reports the same SHA-256.
$version = '9.0.2'
$sha256 = '4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077'
$url = "https://github.com/GyanD/codexffmpeg/releases/download/$version/ffmpeg-$version-essentials_build.7z"
$installRoot = Join-Path $env:RUNNER_TEMP ('reelterminal-ci-ffmpeg-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $installRoot
$archive = Join-Path $installRoot 'ffmpeg.7z'

# Keep downloads bounded and surface native exit codes in PowerShell.
& curl.exe --fail --location --silent --show-error --retry 2 --retry-delay 10 --connect-timeout 15 --max-time 120 --output $archive $url
if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg archive download failed (exit $LASTEXITCODE)."
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
    throw 'FFmpeg archive SHA-256 mismatch; refusing to extract or execute it.'
}

$memberRoot = "ffmpeg-$version-essentials_build/bin"
# Windows tar supports 7z; extract only the two tools needed by the existing tests.
& tar.exe -xf $archive -C $installRoot "$memberRoot/ffmpeg.exe" "$memberRoot/ffprobe.exe"
if ($LASTEXITCODE -ne 0) {
    throw "FFmpeg archive extraction failed (exit $LASTEXITCODE)."
}
$binPath = Join-Path $installRoot $memberRoot
foreach ($tool in @('ffmpeg', 'ffprobe')) {
    $executable = Join-Path $binPath "$tool.exe"
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "Verified archive is missing $tool.exe."
    }
    $versionOutput = @(& $executable -version)
    if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -eq 0 -or
        $versionOutput[0] -notmatch ("^$tool version " + [regex]::Escape($version) + '(?:[-\s]|$)')) {
        throw "$tool failed its pinned-version startup check."
    }
    Write-Host $versionOutput[0]
}

# This is a job-local PATH entry, independent of the application's pinned sidecar.
Add-Content -LiteralPath $env:GITHUB_PATH -Value $binPath -Encoding utf8
Write-Host "CI FFmpeg $version archive SHA-256 verified: $sha256"
