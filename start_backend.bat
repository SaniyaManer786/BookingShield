@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=python"
if exist "backend\.venv\Scripts\python.exe" set "PYTHON=backend\.venv\Scripts\python.exe"
echo ========================================================
echo  SMART ST - Starting YOLO + OpenCV FastAPI Backend
echo ========================================================
"%PYTHON%" -m uvicorn backend.main:app --host 127.0.0.1 --port 8001 --reload
pause
