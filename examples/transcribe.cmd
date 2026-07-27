@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "folder=%~1"
set "mode=%~3"

pushd "%folder%" || exit /b 1
if /I "%mode%"=="document" (
  if exist "prompt.md" (
    (type "prompt.md" & echo. & echo Read every page-*.png in order. Write exactly one output file named document.md. Do not write per-page Markdown files.) | claude --print --safe-mode --no-session-persistence --effort low --tools Read,Write,Glob --allowedTools Read,Write,Glob --max-budget-usd 2.00
  ) else (
    echo Read every page-*.png in order. Write exactly one output file named document.md. Do not write per-page Markdown files. | claude --print --safe-mode --no-session-persistence --effort low --tools Read,Write,Glob --allowedTools Read,Write,Glob --max-budget-usd 2.00
  )
) else (
  echo Read every page-*.png. For each image, write a sibling Markdown file with the identical basename. Do not write document.md. | claude --print --safe-mode --no-session-persistence --effort low --tools Read,Write,Glob --allowedTools Read,Write,Glob --max-budget-usd 2.00
)
set "result=%ERRORLEVEL%"
popd
exit /b %result%
