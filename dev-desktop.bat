@echo off
REM Double-click to start Voquill desktop (hosted / dev Firebase).
cd /d "%~dp0"
echo Starting Voquill desktop…  (Close this window or press Ctrl+C to stop.)
npx pnpm@10.11.0 run dev:desktop
