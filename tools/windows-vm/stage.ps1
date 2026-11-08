# Stages one commit on the VM. vm.sh stage uploads this script beside a `git archive` zip of the commit and
# runs it with the instance's GCP terminationTime, so it stands alone: it cannot dot-source Common.ps1
# before the deadline file exists.
#
# It records that fixed deadline, checks the archive's SHA-256 and the commit stored in its zip comment, and
# replaces C:\veacom\<Name> with exactly the archive's files. Only node_modules and native\target carry over
# from an earlier staging of the same name; everything else, release-electron included, goes, so a file the
# commit deleted cannot linger and still be tested. Extracted files get the staging time: git archive stamps
# them with the commit time, and cargo would otherwise keep an engine built from newer sources. Earlier
# evidence moves aside.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Name,
    [Parameter(Mandatory=$true)][string]$Archive,
    [Parameter(Mandatory=$true)][string]$Sha256,
    [Parameter(Mandatory=$true)][string]$Commit,
    [Parameter(Mandatory=$true)][string]$StopDeadline,
    [string]$Base = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (!$Base) { $Base = Join-Path $env:SystemDrive 'veacom' }
if ($Name -cnotmatch '^[A-Za-z0-9][A-Za-z0-9-]{0,39}$') { throw "Use a short run name such as pr27, not '$Name'." }
if ($Sha256 -notmatch '^[0-9A-Fa-f]{64}$') { throw 'Pass the archive SHA-256 as 64 hexadecimal digits.' }
if ($Commit -notmatch '^[0-9a-f]{40}$') { throw 'Pass the full 40-digit commit.' }
if ($StopDeadline -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$') { throw "The stop deadline '$StopDeadline' is not an RFC 3339 time with a UTC offset." }

function Save-Json([string]$Path, $Value) {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
}
# Antivirus scans can hold a folder for a moment after its files were read.
function Move-WithRetry([string]$From, [string]$To) {
    for ($Try = 1; ; $Try++) {
        try { Move-Item -LiteralPath $From -Destination $To; return }
        catch { if ($Try -ge 5) { throw "Could not move $From to ${To}: $($_.Exception.Message)" }; Start-Sleep -Seconds 2 }
    }
}
# git archive stores the commit in the zip file comment, at the end of the end-of-central-directory record.
function Get-ZipComment([string]$Path) {
    $Bytes = [IO.File]::ReadAllBytes($Path)
    $Last = [Math]::Max(0, $Bytes.Length - 65557)
    for ($i = $Bytes.Length - 22; $i -ge $Last; $i--) {
        if ($Bytes[$i] -eq 0x50 -and $Bytes[$i + 1] -eq 0x4b -and $Bytes[$i + 2] -eq 0x05 -and $Bytes[$i + 3] -eq 0x06) {
            $Length = [BitConverter]::ToUInt16($Bytes, $i + 20)
            if ($i + 22 + $Length -eq $Bytes.Length) { return [Text.Encoding]::ASCII.GetString($Bytes, $i + 22, $Length) }
        }
    }
    return ''
}

# 1. The fixed deadline, before anything else, so every later script can enforce it.
$Now = [DateTimeOffset]::UtcNow
$Deadline = [DateTimeOffset]::Parse($StopDeadline, [Globalization.CultureInfo]::InvariantCulture).ToUniversalTime()
[IO.Directory]::CreateDirectory($Base) | Out-Null
[IO.File]::WriteAllText((Join-Path $Base 'vm-stop-deadline.txt'), $StopDeadline)
if ($Deadline -le $Now.AddMinutes(25)) { throw "The VM stops at $StopDeadline, too soon to stage and build. Stop it; do not extend its schedule from here." }

# 2. The archive is the one vm.sh made from this commit.
$Archive = [IO.Path]::GetFullPath($Archive)
$Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($Actual -ne $Sha256.ToLowerInvariant()) { throw "The archive's SHA-256 is $Actual, not $Sha256. Upload it again." }
$Comment = (Get-ZipComment $Archive).Trim()
if ($Comment -ne $Commit) { throw "The archive was made from '$Comment', not $Commit." }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try { $Entries = @($Zip.Entries | ForEach-Object { $_.FullName }) } finally { $Zip.Dispose() }
foreach ($Entry in $Entries) {
    if ($Entry -match '(^/|^[A-Za-z]:|\\|:|(^|/)\.\.(/|$))') { throw "Unsafe path in the archive: $Entry" }
    if ($Entry -match '^(node_modules|native/target|release-electron)(/|$)') { throw "The archive must not contain $Entry." }
}
if ($Entries -notcontains 'package.json' -or $Entries -notcontains 'tools/windows-vm/Common.ps1') { throw 'This is not a VEAcom source archive with the VM kit.' }

# 3. Nothing may run from the folder being replaced.
$Root = Join-Path $Base $Name
$Evidence = Join-Path $Base "$Name-evidence"
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $Busy = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase) })
    if ($Busy.Count) { throw ('Close what runs from ' + $Root + ' first: ' + (($Busy | ForEach-Object { "$($_.Name) ($($_.ProcessId))" }) -join ', ')) }
    $Tasks = @(Get-ScheduledTask -TaskName 'VEAcom-*' -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' })
    if ($Tasks.Count) { throw ('A kit task is still running: ' + (($Tasks | ForEach-Object { $_.TaskName }) -join ', ') + '. Wait for it, or stop it.') }
}

# 4. Extract beside the old tree, stamp the files, carry the caches over and swap the folders.
$Stamp = $Now.ToString('yyyyMMddTHHmmss')
$Incoming = Join-Path $Base "$Name.incoming-$Stamp"
[IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Incoming)
$Files = 0
foreach ($File in Get-ChildItem -LiteralPath $Incoming -Recurse -File -Force) { $File.LastWriteTimeUtc = $Now.UtcDateTime; $Files++ }
$Kept = @()
$Warnings = @()
$Old = $null
if (Test-Path -LiteralPath $Root) {
    foreach ($Cache in @('node_modules', (Join-Path 'native' 'target'))) {
        $From = Join-Path $Root $Cache
        if (Test-Path -LiteralPath $From -PathType Container) {
            $To = Join-Path $Incoming $Cache
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($To)) | Out-Null
            Move-WithRetry $From $To
            $Kept += $Cache
        }
    }
    $Old = Join-Path $Base "$Name.old-$Stamp"
    try { Move-WithRetry $Root $Old }
    catch { throw "$($_.Exception.Message) The new tree and the caches are in $Incoming; remove $Root and rename $Incoming to it." }
}
Move-WithRetry $Incoming $Root
if ($Old) {
    try { Remove-Item -LiteralPath $Old -Recurse -Force } catch { $Warnings += "Could not delete ${Old}: $($_.Exception.Message)" }
}
$Previous = $null
if (Test-Path -LiteralPath $Evidence) {
    $Previous = Join-Path $Base "$Name-evidence.previous-$Stamp"
    Move-WithRetry $Evidence $Previous
}
[IO.Directory]::CreateDirectory($Evidence) | Out-Null
Save-Json (Join-Path $Evidence 'stage.json') ([ordered]@{
    status = 'passed'; name = $Name; commit = $Commit; archive = $Archive; archiveSha256 = $Actual
    archiveBytes = (Get-Item -LiteralPath $Archive).Length; files = $Files
    staged = $Now.ToString('o'); stagedFileTimeUtc = $Now.UtcDateTime.ToFileTimeUtc(); stopDeadline = $Deadline.ToString('o')
    root = $Root; evidence = $Evidence; keptCaches = $Kept; previousEvidence = $Previous; warnings = $Warnings; computer = $env:COMPUTERNAME })
Write-Output "Staged $Commit as $Root ($Files files; kept: $(if ($Kept.Count) { $Kept -join ', ' } else { 'nothing' })). Evidence: $Evidence"
foreach ($Warning in $Warnings) { Write-Warning $Warning }
