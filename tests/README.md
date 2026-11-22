# Tests

End-to-end scripts for `tools/pi_rpc_session.py`, which drives a real Pi session over RPC and prints every tool call.
Each scenario runs in a fresh, empty working folder. Back up `vault/Memory/USER.md` first: the scenarios teach Pi fake preferences.

```powershell
python -I tools\pi_rpc_session.py $env:TEMP\projA tests\cross-session-A.json logs\A.txt   # teaches a preference
python -I tools\pi_rpc_session.py $env:TEMP\projB tests\cross-session-B.json logs\B.txt   # fresh session must apply it
python -I tools\pi_rpc_session.py $env:TEMP\projC tests\abort-on-typing.json logs\C.txt   # review cancelled by the next prompt
```

What to check: in B, `c2f.py` uses argparse + type hints + a main guard without being asked, and `learn search` finds the
library skill `semgrep`. In C, `vault/.pi-learning.log` shows `review cancelled (you typed)` followed by a successful review.
Set `PI_SESSION=<session file>` to continue an existing session instead of starting a new one.
