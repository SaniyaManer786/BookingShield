@echo off
echo ========================================================
echo  SMART ST - Starting YOLO & OpenCV FastAPI Backend
echo ========================================================
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000 --reload
pause
