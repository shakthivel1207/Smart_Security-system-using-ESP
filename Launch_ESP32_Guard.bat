@echo off
title ESP32 RFID & Footstep Guard Launcher
echo Starting ESP32 RFID & Footstep Security Management Suite...
echo.
if exist "dist\ESP32_RFID_Guard.exe" (
    echo Launching Desktop Executable...
    start "" "dist\ESP32_RFID_Guard.exe"
) else (
    echo Launching Web Desktop Server...
    start "" "http://localhost:8080"
)
exit
