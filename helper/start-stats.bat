@echo off
rem Starts the wallpaper's system-stats helper (keep this window open, or use start-stats-hidden.vbs).
cd /d "%~dp0"
node stats-server.mjs
