"""Drive one Pi session over RPC from a JSON script (for testing the learning loop).
Usage: python -I pi_rpc_session.py <workdir> <steps.json> <transcript.txt>
steps.json: [{"prompt": "..."}, {"wait_reflect": 240}, {"prompt": "/reflect"}, ...]
  prompt        send a prompt and wait for agent_settled; prints tool calls and the final answer
  wait_reflect  wait (up to N s) for a new line in vault/.pi-learning.log (a background reflection finished)"""
import json
import os
import shutil
import subprocess
import sys
import threading
import time

workdir, steps_file, out_file = sys.argv[1], sys.argv[2], sys.argv[3]
LOG = os.path.join(os.environ.get("PI_AGENT_HOME") or os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vault", ".pi-learning.log")
pi = shutil.which("pi") or os.path.join(os.path.expanduser("~"), ".pi", "agent", "bin", "pi.cmd")
env = dict(os.environ)
env["INKLING_API_KEY"] = env.get("INKLING_API_KEY") or subprocess.run(
    ["powershell", "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('INKLING_API_KEY','User')"],
    capture_output=True, text=True).stdout.strip()

out = open(out_file, "a", encoding="utf-8")


def say(s):
    print(s, flush=True)
    out.write(s + "\n")
    out.flush()


def log_lines():
    try:
        with open(LOG, encoding="utf-8") as f:
            return f.read().splitlines()
    except FileNotFoundError:
        return []


extra = ["--session", os.environ["PI_SESSION"]] if os.environ.get("PI_SESSION") else []  # continue an existing session file
p = subprocess.Popen([pi, "--mode", "rpc", *extra], cwd=workdir, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.DEVNULL)
events = []
cond = threading.Condition()


def reader():
    for raw in iter(p.stdout.readline, b""):
        try:
            ev = json.loads(raw)
        except Exception:
            continue
        with cond:
            events.append(ev)
            cond.notify_all()


threading.Thread(target=reader, daemon=True).start()
time.sleep(3)


def send(cmd):
    p.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
    p.stdin.flush()


steps = json.load(open(steps_file, encoding="utf-8-sig"))
for n, step in enumerate(steps, 1):
    if "prompt" in step:
        say(f"\n===== step {n} ({time.strftime('%H:%M:%S')}) >>> {step['prompt']}")
        start = len(events)
        t0 = time.time()
        send({"id": f"p{n}", "type": "prompt", "message": step["prompt"]})
        final, handled, started = "", False, False
        deadline = time.time() + step.get("timeout", 900)
        i = start
        while time.time() < deadline:
            with cond:
                while i >= len(events):
                    cond.wait(5)
                    if time.time() > deadline:
                        break
                batch = events[i:]
                i = len(events)
            done = False
            for ev in batch:
                t = ev.get("type")
                if t == "response" and ev.get("id") == f"p{n}" and (ev.get("data") or {}).get("disposition") == "handled":
                    handled = True
                if t == "tool_execution_start":
                    args = json.dumps(ev.get("args") or ev.get("input") or {}, ensure_ascii=False)
                    say(f"  [tool] {ev.get('toolName')} {args[:300]}")
                if t == "tool_execution_end" and ev.get("isError"):
                    say(f"  [tool error] {ev.get('toolName')}")
                if t == "message_end" and (ev.get("message") or {}).get("role") == "assistant":
                    txt = "".join(c.get("text", "") for c in ev["message"].get("content", []) if c.get("type") == "text")
                    if txt.strip():
                        final = txt
                if t == "extension_ui_request" and ev.get("method") == "notify":
                    say(f"  [notify] {ev.get('message')}")
                if t == "agent_start":
                    started = True
                if t == "agent_settled":
                    done = True
            # a handled command (e.g. /learn) may start a run of its own: wait for it if one begins within 15 s
            if done or (handled and not started and time.time() - t0 > 15):
                break
        say(final.strip() or "(no text)")
        say(f"[step {n} took {time.time() - t0:.0f}s]")
    elif "wait_reflect" in step:
        before = len(log_lines())
        t0 = time.time()
        while time.time() - t0 < step["wait_reflect"] and len(log_lines()) <= before:
            time.sleep(3)
        new = log_lines()[before:]
        say(f"\n----- reflection after {time.time() - t0:.0f}s: {new[-1] if new else '(none finished)'}")
        with cond:  # surface notifications emitted by the background pass
            for ev in events[-40:]:
                if ev.get("type") == "extension_ui_request" and ev.get("method") == "notify" and "pi-learning" in str(ev.get("message")):
                    say(f"  [notify] {ev.get('message')}")
p.stdin.close()
try:
    p.wait(timeout=20)
except subprocess.TimeoutExpired:
    p.kill()
say("DONE")
