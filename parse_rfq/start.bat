@echo off
echo Starting RFQ Parser service...
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3.10+ first.
    pause
    exit /b 1
)

if not exist ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
)

call .venv\Scripts\activate.bat

echo Installing dependencies...
pip install -r requirements.txt -q

echo.
echo ✓ RFQ Parser running at http://localhost:8000
echo   Health check: http://localhost:8000/health
echo   Press Ctrl+C to stop.
echo.

uvicorn main:app --host 0.0.0.0 --port 8000 --reload
