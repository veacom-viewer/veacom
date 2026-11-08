# Writes summary.json for a commit's run and zips its evidence for vm.sh collect to download. The zip is
# written entry by entry with forward slashes: Compress-Archive, and ZipFile.CreateFromDirectory under Windows
# PowerShell, can store backslash paths that other systems' unzip tools mangle. Videos over 5 MB, crash dumps
# and PNGs over 2 MB are left out. The last line is "EVIDENCE-ZIP: <bytes> <sha256> <commit> <path>".
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Name)
. (Join-Path $PSScriptRoot 'Common.ps1')
$Run = Get-RunPaths $Name
$StageFile = Join-Path $Run.Evidence 'stage.json'
if (!(Test-Path -LiteralPath $StageFile)) { throw "Nothing is staged as $Name." }
$Stage = Read-Json $StageFile
function Read-Phase([string]$Relative) {
    $File = Join-Path $Run.Evidence $Relative
    if (Test-Path -LiteralPath $File) { return Read-Json $File }
    return $null
}
function Get-Steps($Document) {
    return @(@(Get-Field $Document 'steps' @()) | Where-Object { $_ } | ForEach-Object {
        [ordered]@{ name = $_.name; status = (Get-Field $_ 'status' ''); note = [string](Get-Field $_ 'reason' (Get-Field $_ 'error' '')) } })
}
$Build = Read-Phase 'build\build.json'
$T4 = Read-Phase 't4\fallback.json'
$BuildStatus = [string](Get-Field $Build 'status' 'not run')
$T4Status = [string](Get-Field $T4 'status' 'not run')
$Os = Get-CimInstance Win32_OperatingSystem
$Summary = [ordered]@{
    name = $Name; commit = $Stage.commit; archiveSha256 = $Stage.archiveSha256; staged = $Stage.staged
    stopDeadline = $script:StopDeadline.ToString('o'); collected = [DateTimeOffset]::UtcNow.ToString('o')
    verdict = if ($Stage.status -eq 'passed' -and $BuildStatus -eq 'passed' -and $T4Status -eq 'passed') { 'passed' } else { 'failed' }
    machine = [ordered]@{ computer = $env:COMPUTERNAME; windows = "$($Os.Caption) $($Os.Version)"
        display = @(Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name), $($_.Status), driver $($_.DriverVersion), $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)" }) }
    build = [ordered]@{ status = $BuildStatus; error = (Get-Field $Build 'error'); node = (Get-Field $Build 'node'); nativeSha256 = (Get-Field $Build 'nativeSha256')
        packagedExeSha256 = (Get-Field $Build 'packagedExeSha256'); warnings = @(Get-Field $Build 'warnings' @()); steps = @(Get-Steps $Build) }
    t4 = [ordered]@{ status = $T4Status; error = (Get-Field $T4 'error'); steps = @(Get-Steps $T4) }
    notHere = @(
        'Engine tests, unit tests, the installer and the desktop checks without a GPU: the hosted Windows job (.github/workflows/windows.yml).',
        'Independent engine checks, source display, study workflows and the archive force-quit proof: Python tools in the old repository.',
        'The PNG export golden: captured on Apple Silicon and not compared on the T4.',
        'Engine crash recovery: a POSIX-only probe, run on macOS.',
        'Scroll and window/level latency: the VM composes at about 30 Hz.',
        'Windows 10 or 11 on a real PC, and signed builds.')
}
Save-Json (Join-Path $Run.Evidence 'summary.json') $Summary

$Zip = Join-Path $script:KitBase "$Name-evidence.zip"
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$Prefix = [IO.Path]::GetFullPath($Run.Evidence).TrimEnd('\', '/').Length + 1
$Stream = [IO.File]::Open($Zip, [IO.FileMode]::CreateNew)
try {
    $Archive = New-Object IO.Compression.ZipArchive($Stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($File in Get-ChildItem -LiteralPath $Run.Evidence -Recurse -File -Force) {
            $Large = ($File.Extension -eq '.mp4' -and $File.Length -gt 5MB) -or ($File.Extension -eq '.png' -and $File.Length -gt 2MB) -or $File.Extension -eq '.dmp'
            if ($Large) { continue }
            $Entry = $File.FullName.Substring($Prefix).Replace('\', '/')
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive, $File.FullName, $Entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $Archive.Dispose() }
} finally { $Stream.Dispose() }
$Item = Get-Item -LiteralPath $Zip
Write-Output "Verdict: $($Summary.verdict) (build $BuildStatus, T4 checks $T4Status)."
Write-Output "EVIDENCE-ZIP: $($Item.Length) $((Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash.ToLowerInvariant()) $($Stage.commit) $Zip"
