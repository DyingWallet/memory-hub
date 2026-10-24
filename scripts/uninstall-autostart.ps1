# Remove the memd autostart tasks registered by install-autostart.ps1.
#
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
#
# Only the scheduled tasks are removed; a running memd keeps running
# (scripts\stop.ps1 stops it). Order matters when uninstalling: drop the tasks
# first, otherwise the watchdog brings memd back within 5 minutes.
$installScript = Join-Path $PSScriptRoot 'install-autostart.ps1'
if (-not (Test-Path -LiteralPath $installScript)) { throw "missing $installScript" }
& $installScript -Remove
exit $LASTEXITCODE
