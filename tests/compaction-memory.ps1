# Full inkling-memory test (needs the inkling-memory extension and an "inkling" provider, or PI_MEMORY_ALL=1) on a fresh session: build up, compaction #1 (RPC), recall, more work, compaction #2, recall.
$root = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force (Join-Path $root "logs") | Out-Null
$out = Join-Path $root "logs\compaction-memory.txt"
$work = Join-Path $env:TEMP "pi-memtest3"
Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $work | Out-Null
$work = (Get-Item $work).FullName
Set-Location $work
if (-not $env:INKLING_API_KEY) { $env:INKLING_API_KEY = [Environment]::GetEnvironmentVariable("INKLING_API_KEY", "User") }
$env:PYTHONIOENCODING = "utf-8"
$sid = "memtest3-" + (Get-Date -Format "HHmmss")
"session id $sid in $work" | Set-Content -Encoding utf8 $out
function Turn($n, $prompt) {
  $t0 = Get-Date
  "`n===== $n ($(Get-Date -Format HH:mm:ss)) =====`n>>> $prompt" | Add-Content -Encoding utf8 $out
  $r = pi --session-id $sid -p $prompt 2>&1 | Where-Object { $_ -notmatch "No project session found" } | Out-String
  "$r`n[$n took $([math]::Round(((Get-Date)-$t0).TotalSeconds))s]" | Add-Content -Encoding utf8 $out
}
function Compact($n) {
  $sess = (Get-ChildItem (Join-Path $env:USERPROFILE ".pi\agent\sessions") -Recurse -Filter "*$sid.jsonl").FullName
  "`n===== $n ($(Get-Date -Format HH:mm:ss)) =====" | Add-Content -Encoding utf8 $out
  python -I (Join-Path $root "tools\pi_rpc_compact.py") $work $sess 2>&1 | Select-Object -First 4 | Add-Content -Encoding utf8 $out
  $mem = Get-ChildItem (Join-Path $env:USERPROFILE ".pi\agent\inkling-memory") -Filter "$sid*.md" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($mem) { "`n----- MEMORY after $n -----`n" + (Get-Content $mem.FullName -Raw -Encoding utf8) | Add-Content -Encoding utf8 $out }
}
$recall = "Answer from memory only, do NOT read or run anything: (a) list all four hard requirements, (b) the client codename, (c) which commands exist and what each prints, (d) every error that happened so far and how it was fixed, (e) which files exist."
Turn "T1 brief" "Project brief. We are building inventory.py, a command-line inventory tracker. HARD REQUIREMENTS: (1) Python standard library only, no third-party packages. (2) Data lives in stock.csv with columns sku,name,qty. (3) Every command prints JSON to stdout. (4) The client codename is HERON-42 and it must appear in the --help description. Create inventory.py with 'add' and 'list' commands, plus test_inventory.py using unittest, then run the tests. Save the requirements with the remember tool."
Turn "T2 remove" "Add a 'remove SKU QTY' command that never lets qty go below zero; in that case print a JSON error object and exit with code 1. Add a test for it and run all tests."
Turn "T3 run report" "Run: python inventory.py report"
Turn "T4 fix report" "That failed. Implement a 'report' command that prints total item count and total quantity as JSON. Add a test, run all tests, and use the remember tool to record what went wrong and how you fixed it."
Turn "T5 explain" "Read inventory.py and test_inventory.py in full and explain every function briefly."
Compact "C1 compaction #1"
Turn "R1 recall" $recall
Turn "T6 find" "Add a 'find TEXT' command that lists items whose name contains TEXT, case-insensitive. Add a test, run all tests, and remember anything important."
Turn "T7 export" "Add an 'export' command that writes stock.json. Follow all of the project's hard requirements. Add a test and run all tests."
Compact "C2 compaction #2"
Turn "R2 recall" $recall
"`n----- files -----" | Add-Content -Encoding utf8 $out
Get-ChildItem $work -File | ForEach-Object { "$($_.Name) $($_.Length)" } | Add-Content -Encoding utf8 $out
Remove-Item env:INKLING_API_KEY
"DONE" | Add-Content -Encoding utf8 $out
