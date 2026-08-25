@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title KCEM GitHub Pages Deploy

echo ============================================================
echo KCEM Museum Sales - GitHub Pages Deploy / Update
echo ============================================================
echo.

if not exist "index.html" (
    echo [ERROR] index.html was not found.
    echo Put this BAT in the same folder as index.html.
    goto :END_ERROR
)

echo [1/7] Checking Git...
where git >nul 2>&1
if errorlevel 1 (
    where winget >nul 2>&1
    if errorlevel 1 (
        echo Git and winget were not found.
        echo Install Git: https://git-scm.com/download/win
        goto :END_ERROR
    )
    echo Installing Git...
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements
    if errorlevel 1 goto :END_ERROR
    echo Git installation finished.
    echo Close this window and run this BAT again.
    goto :END_OK
)
echo Git OK
echo.

echo [2/7] Checking GitHub CLI...
where gh >nul 2>&1
if errorlevel 1 (
    where winget >nul 2>&1
    if errorlevel 1 (
        echo GitHub CLI and winget were not found.
        echo Install GitHub CLI: https://cli.github.com/
        goto :END_ERROR
    )
    echo Installing GitHub CLI...
    winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements
    if errorlevel 1 goto :END_ERROR
    echo GitHub CLI installation finished.
    echo Close this window and run this BAT again.
    goto :END_OK
)
echo GitHub CLI OK
echo.

echo [3/7] Checking GitHub login...
gh auth status -h github.com >nul 2>&1
if errorlevel 1 (
    echo A GitHub device login will open in your browser.
    echo Copy the one-time code shown in THIS CMD window into GitHub.
    echo.
    gh auth login --hostname github.com --git-protocol https --web
    if errorlevel 1 goto :END_ERROR
)
gh auth setup-git >nul 2>&1

set "GH_OWNER="
for /f "usebackq delims=" %%A in (`gh api user --jq ".login" 2^>nul`) do set "GH_OWNER=%%A"
if not defined GH_OWNER (
    echo Could not detect the GitHub account.
    goto :END_ERROR
)
echo Logged in as: %GH_OWNER%
echo.

echo [4/7] Repository settings
set "REPO_NAME="
set /p "REPO_NAME=Repository name [KCEM-Sales]: "
if not defined REPO_NAME set "REPO_NAME=KCEM-Sales"
echo Repository: %GH_OWNER%/%REPO_NAME%
echo.

rem Determine whether the remote repo already exists BEFORE creating a local commit.
set "REMOTE_EXISTS=0"
gh repo view "%GH_OWNER%/%REPO_NAME%" >nul 2>&1
if not errorlevel 1 set "REMOTE_EXISTS=1"

echo [5/7] Preparing local Git repository...
if not exist ".git" (
    git init
    if errorlevel 1 goto :GIT_ERROR
)

git branch -M main

rem Configure remote first.
git remote get-url origin >nul 2>&1
if errorlevel 1 (
    git remote add origin "https://github.com/%GH_OWNER%/%REPO_NAME%.git"
) else (
    git remote set-url origin "https://github.com/%GH_OWNER%/%REPO_NAME%.git"
)

rem If the repository already exists, attach this new extracted folder to
rem the existing remote history while KEEPING the files in this folder.
if "%REMOTE_EXISTS%"=="1" (
    echo Existing GitHub repository found. Loading its history...
    git fetch origin main
    if not errorlevel 1 (
        git reset --mixed origin/main
    )
)

set "GIT_NAME="
for /f "delims=" %%A in ('git config user.name 2^>nul') do set "GIT_NAME=%%A"
if not defined GIT_NAME git config user.name "%GH_OWNER%"

set "GIT_EMAIL="
for /f "delims=" %%A in ('git config user.email 2^>nul') do set "GIT_EMAIL=%%A"
if not defined GIT_EMAIL git config user.email "%GH_OWNER%@users.noreply.github.com"

git add .
if errorlevel 1 goto :GIT_ERROR

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Update KCEM Museum Sales"
    if errorlevel 1 goto :GIT_ERROR
) else (
    echo No new changes to commit.
)
echo.

echo [6/7] Creating or updating GitHub repository...
if "%REMOTE_EXISTS%"=="0" (
    echo Creating public repository...
    gh repo create "%GH_OWNER%/%REPO_NAME%" --public
    if errorlevel 1 goto :END_ERROR
)

git push -u origin main
if errorlevel 1 (
    echo Git push failed.
    goto :END_ERROR
)
echo.

echo [7/7] Enabling GitHub Pages...
gh api "repos/%GH_OWNER%/%REPO_NAME%/pages" >nul 2>&1
if errorlevel 1 (
    gh api --method POST "repos/%GH_OWNER%/%REPO_NAME%/pages" -f build_type=workflow >nul 2>&1
) else (
    gh api --method PUT "repos/%GH_OWNER%/%REPO_NAME%/pages" -f build_type=workflow >nul 2>&1
)

gh workflow run pages.yml --ref main -R "%GH_OWNER%/%REPO_NAME%" >nul 2>&1

echo.
echo ============================================================
echo UPLOAD / UPDATE COMPLETE
echo ============================================================
echo Repository:
echo https://github.com/%GH_OWNER%/%REPO_NAME%
echo.
echo Pages:
echo https://%GH_OWNER%.github.io/%REPO_NAME%/
echo.
echo Actions:
echo https://github.com/%GH_OWNER%/%REPO_NAME%/actions
echo.
start "" "https://github.com/%GH_OWNER%/%REPO_NAME%/actions"
goto :END_OK

:GIT_ERROR
echo Git command failed.
goto :END_ERROR

:END_ERROR
echo.
echo ============================================================
echo DEPLOY FAILED
 echo ============================================================
echo The window will stay open so the error can be read.
pause
exit /b 1

:END_OK
echo.
echo Press any key to close this window.
pause >nul
exit /b 0
