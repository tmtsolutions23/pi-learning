---
name: python-src-layout-package
description: "Scaffold, install and test a src-layout Python package (setuptools + venv + pytest) on Windows"
metadata:
  source: pi-learning
  created: 2026-11-22
  updated: 2026-11-22
---

# Python src-layout package scaffold

Creates a minimal installable Python package using src layout (setuptools + venv + pytest) and proves it works.

## When to use

When asked to create a new Python package skeleton, scaffold a src-layout package, or install and test one on this Windows machine (PowerShell / Git Bash, Python 3.12).

## Procedure

1. Create the layout:
   - `pyproject.toml` with `[build-system]` (setuptools>=61, `setuptools.build_meta`), `[project]` (name, version, requires-python), an optional `dev` extra with `pytest`, `[tool.setuptools.packages.find] where = ["src"]`, and `[tool.pytest.ini_options] testpaths = ["tests"]`.
   - `src/<pkg>/__init__.py` with the package code.
   - `tests/test_<module>.py` importing from the package.
2. Create the venv: `python -m venv .venv`
3. Install editable with dev deps: `.venv/Scripts/python.exe -m pip install -e ".[dev]"`
4. Run tests: `.venv/Scripts/python.exe -m pytest`

## Pitfalls

- In Git Bash / bash on Windows, use forward slashes for the venv path (`.venv/Scripts/python.exe`); backslash paths like `.venv\Scripts\python.exe` fail with "command not found". In PowerShell, use `.venv\Scripts\python.exe`.
- Do not rely on bare `pytest` or `python` outside the venv — install into `.venv` and invoke its interpreter explicitly.
- `[tool.setuptools.packages.find] where = ["src"]` is required for src layout; without it the package is not found.
- Keep `testpaths = ["tests"]` in pyproject so pytest does not collect from the venv.

## Verification

`.venv/Scripts/python.exe -m pytest` reports `N passed` (e.g. `2 passed in 0.02s`).
