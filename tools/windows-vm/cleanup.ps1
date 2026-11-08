# Run before stopping the VM (vm.sh stop does). Removes finished kit tasks, turns the Tesla T4 back on if
# something left it disabled (that state survives a reboot and would put the next run on WARP without a
# word), and lists kit processes still running. Fails when a task is still running or the T4 is not working.
[CmdletBinding()]
param()
. (Join-Path $PSScriptRoot 'Common.ps1')
$Problems = @()
$Tasks = @(Get-ScheduledTask -TaskName 'VEAcom-*' -ErrorAction SilentlyContinue)
$Running = @($Tasks | Where-Object { $_.State -eq 'Running' })
foreach ($Task in @($Tasks | Where-Object { $_.State -ne 'Running' })) { Unregister-ScheduledTask -TaskName $Task.TaskName -Confirm:$false }
Write-Output "Removed $($Tasks.Count - $Running.Count) finished kit tasks."
foreach ($Task in $Running) { $Problems += "Task $($Task.TaskName) is still running." }
$Gpu = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VEN_10DE' })
if ($Gpu.Count -and @($Gpu | Where-Object { $_.Status -ne 'OK' }).Count) {
    Write-Output 'The T4 is not enabled; enabling it.'
    & (Join-Path $PSScriptRoot 'display-adapter.ps1') -Action Enable -Output (Join-Path $script:KitBase 'display-adapter')
    $Gpu = @(Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VEN_10DE' })
}
foreach ($Device in $Gpu) { Write-Output "Display adapter: $($Device.FriendlyName) $($Device.Status)" }
if (!$Gpu.Count -or @($Gpu | Where-Object { $_.Status -ne 'OK' }).Count) { $Problems += 'The Tesla T4 is missing or not working.' }
$Left = @(Get-Process -Name 'VEAcom Electron', 'veacom-core', 'electron' -ErrorAction SilentlyContinue)
foreach ($Process in $Left) { Write-Output "Still running: $($Process.ProcessName) $($Process.Id) $(Get-Field $Process 'Path' '')" }
if ($Problems.Count) { throw ($Problems -join ' ') }
Write-Output 'Clean: no kit task running and the T4 is on.'
