# One-time setup on Windows (PowerShell 5.1+). Run from the repo folder:  .\setup.ps1
# 1) creates vault/ from vault-template/ (never overwrites an existing vault)
# 2) fetches + installs the curated skills (git and Python 3 required)
# 3) registers the skills folders and the pi-learning extension in ~/.pi/agent/settings.json (backup first)
$ErrorActionPreference = "Stop"
$home_ = $PSScriptRoot
if (-not (Test-Path "$home_\vault")) { Copy-Item -Recurse "$home_\vault-template" "$home_\vault"; "created vault\" } else { "vault\ exists, left as is" }
python -I "$home_\tools\install_skills.py"
$settings = Join-Path $env:USERPROFILE ".pi\agent\settings.json"
if (-not (Test-Path $settings)) { throw "Pi settings not found at $settings - install Pi and run it once first." }
Copy-Item $settings "$settings.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
$j = [IO.File]::ReadAllText($settings).TrimStart([char]0xFEFF) | ConvertFrom-Json
$fwd = $home_ -replace '\', '/'
$add = @{ skills = @("$fwd/skills/core", "$fwd/vault/Skills"); extensions = @("$fwd/extensions/pi-learning") }
foreach ($k in $add.Keys) {
  $cur = @(); if ($j.PSObject.Properties[$k]) { $cur = @($j.$k) }
  $j | Add-Member -NotePropertyName $k -NotePropertyValue @($cur + $add[$k] | Select-Object -Unique) -Force
}
[IO.File]::WriteAllText($settings, ($j | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding $false))
"Registered in $settings. Start pi and run /vault to check."
"Optional: copy extensions\inkling-memory to ~/.pi/agent/extensions/ if you run a small local model (see its README)."
