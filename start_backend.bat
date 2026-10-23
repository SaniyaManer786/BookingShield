@echo off
cd /d "%~dp0"
echo ========================================================
echo  SMART ST - Starting YOLO + OpenCV FastAPI Backend
echo ========================================================
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8001 --reload
pause
