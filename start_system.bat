@echo off
cd /d "%~dp0"
echo ========================================================
echo  SMART ST Control Center - Starting Full Stack System
echo ========================================================
echo 1. Launching YOLO + OpenCV Backend on http://127.0.0.1:8001 ...
start "SMART ST Vision Backend" cmd /k call "%~dp0start_backend.bat"

timeout /t 2 /nobreak >nul

echo 2. Launching Vite Frontend on http://localhost:5173 ...
start "SMART ST Frontend" cmd /k "npm run dev"

echo.
echo All services launched!
echo Open your browser to http://localhost:5173
echo.
