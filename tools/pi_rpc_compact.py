"""Compact an existing Pi session through RPC mode (print mode cannot run /compact).
Usage: python -I tools/pi_rpc_compact.py <workdir> <session-file-or-id> [custom instructions]
Prints success, tokens before/after, and the summary; exits non-zero on failure."""
import json
import os
import shutil
import subprocess
import sys
import time

workdir, sid = sys.argv[1], sys.argv[2]
instr = sys.argv[3] if len(sys.argv) > 3 else None
pi = shutil.which("pi") or os.path.join(os.path.expanduser("~"), ".pi", "agent", "bin", "pi.cmd")
env = dict(os.environ)
env["INKLING_API_KEY"] = env.get("INKLING_API_KEY") or subprocess.run(
    ["powershell", "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('INKLING_API_KEY','User')"],
    capture_output=True, text=True).stdout.strip()

p = subprocess.Popen([pi, "--mode", "rpc", "--session" if os.path.isfile(sid) else "--session-id", sid], cwd=workdir, env=env, stdin=subprocess.PIPE,
                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1)
cmd = {"id": "c1", "type": "compact"}
if instr:
    cmd["customInstructions"] = instr
time.sleep(3)
p.stdin.write(json.dumps(cmd) + "\n")
p.stdin.flush()
t0 = time.time()
result = None
while True:
    line = p.stdout.readline()
    if not line:
        break
    try:
        ev = json.loads(line)
    except json.JSONDecodeError:
        continue
    if ev.get("type") in ("compaction_start", "compaction_end"):
        print(f"[{time.time()-t0:6.1f}s] event {ev['type']}", flush=True)
    if ev.get("type") == "response" and ev.get("id") == "c1":
        result = ev
        break
p.stdin.close()
try:
    p.wait(timeout=20)
except subprocess.TimeoutExpired:
    p.kill()
if not result:
    print("no compact response; stderr:\n" + p.stderr.read()[-2000:])
    sys.exit(2)
print(f"success={result.get('success')} after {time.time()-t0:.0f}s error={result.get('error')}")
d = result.get("data") or {}
print(f"tokensBefore={d.get('tokensBefore')} estimatedTokensAfter={d.get('estimatedTokensAfter')} details.keys={list((d.get('details') or {}).keys())}")
print("----- SUMMARY -----")
print(d.get("summary", ""))
sys.exit(0 if result.get("success") else 1)
