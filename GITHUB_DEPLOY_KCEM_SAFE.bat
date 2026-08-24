@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title KCEM GitHub Pages Deploy

echo ============================================================
echo KCEM Museum Sales - GitHub Pages Deploy
echo ============================================================
echo.

rem ------------------------------------------------------------
rem Keep this script simple and compatible with Windows CMD.
rem ------------------------------------------------------------

if not exist "index.html" (
    echo [ERROR] index.html was not found.
    echo.
    echo Put this BAT file in the same folder as index.html.
    echo Current folder:
    cd
    echo.
    goto :END_ERROR
)

echo [1/7] Checking Git...
where git >nul 2>&1
if errorlevel 1 (
    echo Git is not installed.
    echo.

    where winget >nul 2>&1
    if errorlevel 1 (
        echo winget was not found.
        echo Install Git manually:
        echo https://git-scm.com/download/win
        echo.
        goto :END_ERROR
    )

    echo Installing Git...
    winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements

    if errorlevel 1 (
        echo.
        echo Git installation failed.
        goto :END_ERROR
    )

    echo.
    echo Git installation finished.
    echo CLOSE THIS WINDOW and run this BAT again.
    echo.
    goto :END_OK
)

echo Git OK
echo.

echo [2/7] Checking GitHub CLI...
where gh >nul 2>&1
if errorlevel 1 (
    echo GitHub CLI is not installed.
    echo.

    where winget >nul 2>&1
    if errorlevel 1 (
        echo winget was not found.
        echo Install GitHub CLI manually:
        echo https://cli.github.com/
        echo.
        goto :END_ERROR
    )

    echo Installing GitHub CLI...
    winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements

    if errorlevel 1 (
        echo.
        echo GitHub CLI installation failed.
        goto :END_ERROR
    )

    echo.
    echo GitHub CLI installation finished.
    echo CLOSE THIS WINDOW and run this BAT again.
    echo.
    goto :END_OK
)

echo GitHub CLI OK
echo.

echo [3/7] Checking GitHub login...
gh auth status -h github.com >nul 2>&1

if errorlevel 1 (
    echo.
    echo A GitHub login will open in your browser.
    echo Approve the login, then return to this window.
    echo.

    gh auth login --hostname github.com --git-protocol https --web

    if errorlevel 1 (
        echo.
        echo GitHub login failed.
        goto :END_ERROR
    )
)

gh auth setup-git >nul 2>&1

set "GH_OWNER="
for /f "usebackq delims=" %%A in (`gh api user --jq ".login" 2^>nul`) do set "GH_OWNER=%%A"

if not defined GH_OWNER (
    echo.
    echo Could not detect the GitHub account.
    goto :END_ERROR
)

echo Logged in as: %GH_OWNER%
echo.

echo [4/7] Repository settings
set "REPO_NAME="
set /p "REPO_NAME=Repository name [KCEM-Sales]: "
if not defined REPO_NAME set "REPO_NAME=KCEM-Sales"

echo.
echo Repository: %GH_OWNER%/%REPO_NAME%
echo.

echo [5/7] Preparing local Git repository...

if not exist ".git" (
    git init
    if errorlevel 1 goto :GIT_ERROR
)

git branch -M main
if errorlevel 1 goto :GIT_ERROR

for /f "delims=" %%A in ('git config user.name 2^>nul') do set "GIT_NAME=%%A"
if not defined GIT_NAME git config user.name "%GH_OWNER%"

for /f "delims=" %%A in ('git config user.email 2^>nul') do set "GIT_EMAIL=%%A"
if not defined GIT_EMAIL git config user.email "%GH_OWNER%@users.noreply.github.com"

git add .
if errorlevel 1 goto :GIT_ERROR

git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Deploy KCEM Museum Sales"
    if errorlevel 1 goto :GIT_ERROR
) else (
    echo No new files to commit.
)

echo.
echo [6/7] Creating or connecting GitHub repository...

gh repo view "%GH_OWNER%/%REPO_NAME%" >nul 2>&1

if errorlevel 1 (
    echo Creating public repository...
    gh repo create "%GH_OWNER%/%REPO_NAME%" --public --source=. --remote=origin
    if errorlevel 1 (
        echo.
        echo GitHub repository creation failed.
        goto :END_ERROR
    )
) else (
    echo Existing repository found.

    git remote get-url origin >nul 2>&1
    if errorlevel 1 (
        git remote add origin "https://github.com/%GH_OWNER%/%REPO_NAME%.git"
    ) else (
        git remote set-url origin "https://github.com/%GH_OWNER%/%REPO_NAME%.git"
    )
)

echo.
echo Uploading files...
git push -u origin main

if errorlevel 1 (
    echo.
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

echo Triggering Pages workflow...
gh workflow run pages.yml --ref main -R "%GH_OWNER%/%REPO_NAME%" >nul 2>&1

echo.
echo ============================================================
echo UPLOAD COMPLETE
echo ============================================================
echo.
echo Repository:
echo https://github.com/%GH_OWNER%/%REPO_NAME%
echo.
echo Expected Pages URL:
echo https://%GH_OWNER%.github.io/%REPO_NAME%/
echo.
echo GitHub Actions:
echo https://github.com/%GH_OWNER%/%REPO_NAME%/actions
echo.

start "" "https://github.com/%GH_OWNER%/%REPO_NAME%/actions"

goto :END_OK


:GIT_ERROR
echo.
echo Git command failed.
goto :END_ERROR


:END_ERROR
echo.
echo ============================================================
echo DEPLOY FAILED
echo ============================================================
echo.
echo The window will stay open so you can read the error.
echo.
pause
exit /b 1


:END_OK
echo.
echo Press any key to close this window.
pause >nul
exit /b 0
