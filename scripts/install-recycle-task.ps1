param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE '.config\openchamber\extensions\instabox-matrix'),
  [string]$TaskName = 'OpenChamber-InstaboxRecycle',
  [int]$Minutes = 5,
  [string]$DataDir = (Join-Path $env:USERPROFILE '.openchamber-instabox-matrix'),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "removed task $TaskName"
  exit 0
}

$cli = Join-Path $InstallDir 'scripts\recycle.js'
if (-not (Test-Path $cli)) {
  throw "recycle.js not found at $cli - run 'node scripts/sync.mjs' first"
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$log = Join-Path $DataDir 'recycle-task.log'

$cmd = '/c ""{0}" "{1}" --once >> "{2}" 2>&1"' -f $node, $cli, $log
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $Minutes)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $logon, $repeat `
  -Settings $settings `
  -Description 'Recycle Instabox machines before the free-plan max-run cooldown (Instabox Matrix).' `
  -Force | Out-Null

Write-Output "registered $TaskName (at logon, every $Minutes min)"
Write-Output "command: $node $cli --once >> $log"
