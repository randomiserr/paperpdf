@echo off
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe python -m venv .venv
.venv\Scripts\python.exe -c "import pymupdf, pikepdf" >nul 2>&1
if errorlevel 1 .venv\Scripts\python.exe -m pip install -r requirements.txt
echo Open http://127.0.0.1:8765 in your browser.
.venv\Scripts\python.exe server.py
pause
