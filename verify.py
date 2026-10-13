"""Run the same verification locally and in CI: python verify.py."""
import importlib.metadata
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def run(label, command):
    print(f"\n{label}", flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def main():
    # Use the environment created by start.bat when invoked with a system Python.
    local_python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if sys.prefix == sys.base_prefix and local_python.is_file():
        return subprocess.call([str(local_python), str(Path(__file__).resolve())], cwd=ROOT)
    if sys.version_info < (3, 11):
        raise RuntimeError("The pinned PDF dependencies require Python 3.11 or newer.")
    for requirement in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        if not requirement.strip() or requirement.startswith("#"):
            continue
        name, expected = requirement.split("==")
        try:
            installed = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            raise RuntimeError("Install dependencies with python -m pip install -r requirements.txt.") from None
        if installed != expected:
            raise RuntimeError(f"{name} must be {expected}; installed {installed}. Install requirements.txt.")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Install Node.js 22 or newer to run JavaScript checks and tests.")
    version = subprocess.check_output([node, "--version"], text=True).strip()
    if int(version.lstrip("v").split(".")[0]) < 22:
        raise RuntimeError(f"Node.js 22 or newer is required; found {version}.")
    print(f"Python {sys.version.split()[0]}; Node.js {version}", flush=True)

    python_files = sorted(ROOT.glob("*.py")) + sorted((ROOT / "tests").rglob("*.py"))
    print("\nPython syntax", flush=True)
    for path in python_files:
        compile(path.read_bytes(), str(path.relative_to(ROOT)), "exec")
    run("Dependency consistency", [sys.executable, "-m", "pip", "check"])
    js_tests = sorted((ROOT / "tests").rglob("*.test.cjs"))
    if not js_tests or not list((ROOT / "tests").rglob("test_*.py")):
        raise RuntimeError("Both PDF and JavaScript regression suites must be present.")
    for path in sorted((ROOT / "static").glob("*.js")) + js_tests:
        run(f"JavaScript syntax: {path.relative_to(ROOT)}", [node, "--check", str(path)])
    run("PDF and HTTP regressions", [sys.executable, "-m", "unittest", "discover",
        "--start-directory", "tests", "--top-level-directory", ".", "--pattern", "test_*.py", "--verbose"])
    run("Editor refresh regressions", [node, "--test", *map(str, js_tests)])
    print("\nVerification passed.", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f"\nVerification failed: {error}", file=sys.stderr)
        sys.exit(1)
