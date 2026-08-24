@echo off
chcp 65001 > nul
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  echo KCEM Museum Sales local server
  echo http://localhost:8000
  start "" http://localhost:8000
  py -m http.server 8000
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  echo KCEM Museum Sales local server
  echo http://localhost:8000
  start "" http://localhost:8000
  python -m http.server 8000
  goto :eof
)

echo Python이 설치되어 있지 않습니다.
echo index.html을 직접 열어 화면을 볼 수 있지만,
echo 실제 연결 테스트는 Python 로컬 서버 사용을 권장합니다.
pause
