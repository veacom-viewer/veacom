# Starts run-fallback.ps1 for a plan of desktop checks in the logged-in desktop session, through an interactive
# scheduled task, so the app gets a real window and the session's display adapter. The plan is checked here
# first, so a malformed one fails in the SSH session instead of inside a hidden task.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Plan, [string]$TaskUser="$env:COMPUTERNAME\veacom")
. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-TimeRemaining 10
$Config = Read-Json $Plan
Assert-Plan $Config
Assert-NoKitTask
[IO.Directory]::CreateDirectory($Config.Output) | Out-Null
$Acl = Get-Acl $Config.Output
$Acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($TaskUser,'Modify','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $Config.Output -AclObject $Acl
$Minutes = 5
foreach ($Step in @($Config.Steps)) { if (!(Get-Field $Step 'Skip')) { $Minutes += [int]$Step.Minutes } }
$TaskName = 'VEAcom-Checks-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')
Start-KitTask -TaskName $TaskName -Script (Join-Path $PSScriptRoot 'run-fallback.ps1') -Arguments ('-Plan ' + (Quote-NativeArgument $Plan)) `
    -WorkingDirectory $Config.Root -Minutes $Minutes -TaskUser $TaskUser -TaskFile (Join-Path $Config.Output 'task.json')
Write-Output "Started $TaskName."
