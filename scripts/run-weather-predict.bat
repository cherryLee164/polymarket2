@echo off
rem Set missing city backfill retry interval to 5 minutes (same as capture interval)
rem Normal 0:10 start captures all at once; failed ones retry every 5 min until 02:00 exit
set WEATHER_MISSING_CAPTURE_RETRY_MS=300000
"D:\Program Files\nodejs\node.exe" "D:\cursor\ploymarket\scripts\weather_sync_launcher.js"
