@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title KCEM Museum Sales GitHub Pages Deploy

echo ============================================================
echo KCEM Museum Sales - GitHub Pages Deploy
echo ============================================================
echo.

if not exist "index.html" (
  echo ERROR: index.html was not found.
  pause
  exit /b 1
)
if not exist ".github\workflows\pages.yml" (
  echo ERROR: .github\workflows\pages.yml was not found.
  pause
  exit /b 1
)

where git >nul 2>&1
if errorlevel 1 (
  where winget >nul 2>&1 || goto :NO_WINGET
  winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
  echo Git was installed. Close this window and run this BAT again.
  pause
  exit /b 0
)

where gh >nul 2>&1
if errorlevel 1 (
  where winget >nul 2>&1 || goto :NO_WINGET
  winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
  echo GitHub CLI was installed. Close this window and run this BAT again.
  pause
  exit /b 0
)

gh auth status -h github.com >nul 2>&1
if errorlevel 1 (
  gh auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 goto :FAILED
)
gh auth setup-git >nul 2>&1

for /f "delims=" %%A in ('gh api user --jq ".login" 2^>nul') do set "GH_OWNER=%%A"
if not defined GH_OWNER goto :FAILED

set "REPO_NAME=KCEM-Sales"
set /p "REPO_INPUT=Repository name [KCEM-Sales]: "
if defined REPO_INPUT set "REPO_NAME=%REPO_INPUT%"

if not exist ".git" git init
if errorlevel 1 goto :FAILED
git branch -M main

git config user.name >nul 2>&1 || git config user.name "%GH_OWNER%"
git config user.email >nul 2>&1 || git config user.email "%GH_OWNER%@users.noreply.github.com"
git add .
git diff --cached --quiet || git commit -m "Deploy KCEM Museum Sales"
if errorlevel 1 goto :FAILED

gh repo view "%GH_OWNER%/%REPO_NAME%" >nul 2>&1
if errorlevel 1 (
  gh repo create "%GH_OWNER%/%REPO_NAME%" --public --source=. --remote=origin
  if errorlevel 1 goto :FAILED
) else (
  git remote get-url origin >nul 2>&1
  if errorlevel 1 (
    git remote add origin "https://github.com/%GH_OWNER%/%REPO_NAME%.git"
  ) else (
    git remote set-url origin "https://github.com/%GH_OWNER%/%REPO_NAME%.git"
  )
)

git push -u origin main
if errorlevel 1 goto :FAILED

gh api "repos/%GH_OWNER%/%REPO_NAME%/pages" >nul 2>&1
if errorlevel 1 (
  gh api --method POST "repos/%GH_OWNER%/%REPO_NAME%/pages" -f build_type=workflow >nul 2>&1
) else (
  gh api --method PUT "repos/%GH_OWNER%/%REPO_NAME%/pages" -f build_type=workflow >nul 2>&1
)

timeout /t 2 /nobreak >nul
gh workflow run pages.yml --ref main -R "%GH_OWNER%/%REPO_NAME%" >nul 2>&1

echo.
echo Upload complete.
echo Repository: https://github.com/%GH_OWNER%/%REPO_NAME%
echo Expected page: https://%GH_OWNER%.github.io/%REPO_NAME%/
start "" "https://github.com/%GH_OWNER%/%REPO_NAME%/actions"
pause
exit /b 0

:NO_WINGET
echo winget was not found. Install Git/GitHub CLI manually.
pause
exit /b 1

:FAILED
echo.
echo DEPLOY FAILED
pause
exit /b 1
