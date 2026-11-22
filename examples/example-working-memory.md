# Working memory (carried across context compactions)
This covers the conversation BEFORE the messages that follow it. Trust it over your own assumptions, but where the
newer messages below show later progress (e.g. a step now done), the newer messages win.
## Goal
Build and maintain inventory.py (CLI inventory tracker) in C:/Users/<you>/AppData/Local/Temp/pi-memtest3 (working dir: /c/Users/<you>/AppData/Local/Temp/pi-memtest3). HARD requirements: (1) Python stdlib only; (2) data in stock.csv with columns sku,name,qty; (3) every command prints JSON to stdout; (4) client codename HERON-42 must appear in the --help description. Commands: 'add', 'list', 'remove', 'report' (all implemented); plus test_inventory.py using unittest; run the tests.

## Constraints & Preferences
- Stdlib only; stock.csv columns exactly sku,name,qty; every command prints JSON to stdout; HERON-42 in --help description.
- 'remove SKU QTY' must never let qty go below zero; on insufficient stock print a JSON error object and exit with code 1.
- Tests use temp dirs via monkeypatching inventory.CSV_PATH (setUp/tearDown); sys.exit(1) paths must be caught with assertRaises(SystemExit).

## Key Decisions
- 'add' requires --name even when sku exists (used as fallback/override name).
- 'remove': finds row by sku; if current < requested → prints {"error":"insufficient stock","sku","requested","available"} and sys.exit(1); else decrements, saves, prints {"sku","name","qty","action":"removed"}; unknown sku → {"error":"sku not found","sku"} + exit 1. Rows at qty 0 are kept (not deleted) — user notified; deletion at zero is a possible future option.
- 'report': cmd_report prints {"total_items": N, "total_qty": M} JSON. Help description now: "HERON-42 inventory tracker: add, remove, list and report stock items."
- 'find' command (per saved notes): substring match on item name, case-insensitive, prints {"items":[...],"count":N}; tests test_find and test_find_no_match.
- 'export' command (per saved notes): writes stock.json next to stock.csv (derived from CSV_PATH dir) with {"items":[...],"count":N}, prints {"exported":path,"count":N}; test_export added.

## Progress
Done:
- Initial inventory.py: add/list; load_stock/save_stock helpers; CSV_PATH anchored to script dir.
- 'remove' command implemented + tests (test_remove success; test_remove_below_zero_errors: exit 1, error JSON, stock unchanged). 5/5 passed.
- 'report' command added (user ran `python inventory.py report`, argparse exited 2 'invalid choice'). cmd_report + report subparser + tests (test_report: 2 items qty 5+7 → {"total_items":2,"total_qty":12}; test_report_empty). All 7 tests passed. Verified via `python inventory.py report` → {"total_items": 0, "total_qty": 0} exit 0 (real stock.csv empty — expected).
- Pitfall recorded via remember tool (kind="pitfall"): report was missing; fixed; all 7 pass.
- Saved notes indicate 'find' and 'export' commands were added after report (tests: 9/9 then 10/10 pass) — these appear in saved memory as done facts; excerpt truncated before showing them.
- Just read inventory.py and test_inventory.py in full (outputs truncated in transcript; key structure visible: load_stock/save_stock, cmd_add, cmd_remove, cmd_report, cmd_list, cmd_main argparse subcommands).

In progress:
- User asked: "Read inventory.py and test_inventory.py in full and explain every function briefly." Files were just read; the explanation to the user is NOT yet delivered.

## Pitfalls & Fixed Errors
- 'report' missing → `python inventory.py report` gave argparse exit 2 "invalid choice". Fixed by adding cmd_report + subparser + 2 tests. Recorded via remember tool.
- Test design: sys.exit(1) in cmd_remove must be caught — test_remove_below_zero_errors uses assertRaises(SystemExit) and checks ctx.exception.code == 1.
- Real stock.csv reports 0 items because tests use temp dirs — expected, not a bug.

## Next Steps
1. Deliver the requested brief explanation of every function in inventory.py and test_inventory.py (load_stock, save_stock, cmd_add, cmd_remove, cmd_report, cmd_list, cmd_find/export if present, main/argparse; TestInventory setUp/tearDown/run_cmd and each test).
2. If the explanation reveals gaps (e.g. find/export not in file or tests failing), fix and rerun `python -m unittest test_inventory -v 2>&1`.
3. Confirm full suite passes and report to user.

## Critical Context
- Project dir: /c/Users/<you>/AppData/Local/Temp/pi-memtest3 (files inventory.py, test_inventory.py).
- inventory.py: CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stock.csv"); load_stock() returns list of dicts (csv.DictReader); save_stock(rows) writes via csv.DictWriter with fieldnames ["sku","name","qty"]; cmd_add prints {"sku","name","qty","action":"added"|"updated"}; cmd_list prints {"items":[...],"count":N}; cmd_report prints {"total_items","total_qty"}; cmd_remove as above; argparse subcommands add/remove/list/report (+ find/export per saved notes — verify).
- test_inventory.py: setUp creates temp dir and monkeypatches inventory.CSV_PATH; tearDown restores; run_cmd(argv) sets sys.argv, redirects stdout, calls inventory.main(), returns json.loads(buf.getvalue()); tests: test_add_and_list, test_list_empty, test_remove, test_remove_below_zero_errors, test_report, test_report_empty, test_help_mentions_codename (subprocess check for HERON-42 in --help).
- Exit codes: 0 success; 1 for insufficient stock / sku not found; 2 for argparse usage errors.
- Test run command: `python -m unittest test_inventory -v 2>&1`.
- Exit-code-1 paths require SystemExit handling in tests.

# Verbatim record (copied exactly, not summarized)
## User requests (first, then most recent)
FIRST: Project brief. We are building inventory.py, a command-line inventory tracker. HARD REQUIREMENTS: (1) Python standard library only, no third-party packages. (2) Data lives in stock.csv with columns sku,name,qty. (3) Every command prints JSON to stdout. (4) The client codename is HERON-42 and it must appear in the --help description. Create inventory.py with 'add' and 'list' commands, plus test_inventory.py using unittest, then run the tests. Save the requirements with the remember tool.

#1: Add a 'remove SKU QTY' command that never lets qty go below zero; in that case print a JSON error object and exit with code 1. Add a test for it and run all tests.

#2: Run: python inventory.py report

#3: That failed. Implement a 'report' command that prints total item count and total quantity as JSON. Add a test, run all tests, and use the remember tool to record what went wrong and how you fixed it.

#4: Read inventory.py and test_inventory.py in full and explain every function briefly.
## Pinned notes
- [fact] Project brief: build inventory.py (CLI inventory tracker) in C:/Users/<you>/AppData/Local/Temp/pi-memtest3. HARD requirements: (1) Python stdlib only, no third-party packages; (2) data in stock.csv with columns sku,name,qty; (3) every command prints JSON to stdout; (4) client codename HERON-42 must appear in the --help description. Commands: 'add' and 'list'; plus test_inventory.py using unittest; run the tests.
- [pitfall] inventory.py 'report' command was missing (user ran `python inventory.py report`, argparse exited 2 with 'invalid choice'); fixed by adding cmd_report printing {"total_items","total_qty"} JSON plus tests, all 7 pass.
- [fact] inventory.py now has a 'find TEXT' command: substring match on item name, case-insensitive, prints {"items":[...],"count":N}; tests test_find and test_find_no_match added, 9/9 pass.
- [fact] inventory.py now has an 'export' command: writes stock.json next to stock.csv (derived from CSV_PATH dir, so tests can redirect) with {"items":[...],"count":N}, and prints {"exported":path,"count":N} as JSON to stdout; test_export added, 10/10 pass.
## Recent errors (from the compacted span)
- (none)

<read-files>
inventory.py
test_inventory.py
</read-files>
<modified-files>
inventory.py
test_inventory.py
</modified-files>