---
name: start-server
description: Start, restart, or check the poker_memo local dev server (npm start / node server/index.js). Use whenever the user asks to run, start, restart, or check the poker_memo app, or wants to verify a change by hitting it locally. Handles the case where node/npm are not on PATH in this environment.
---

# Start the poker_memo server

This is a self-hosted Node.js/Express app (`server/index.js`) with a SQLite
file (`data/poker_memo.db`) and a vanilla JS/HTML/CSS frontend (`public/`).
Only one instance can hold the SQLite file at a time, so always stop any
existing instance before starting a new one.

## 1. Locate node/npm

On this machine, `node`/`npm` are **not on PATH** in the tool shells. First
try plain `node -v` — if that works, skip to step 2. Otherwise, find the
WinGet-installed Node and use its directory for every subsequent command in
this session:

```bash
find /c/Users/*/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.* -maxdepth 1 -iname "node-v*-win-x64" 2>/dev/null
```

That directory contains `node.exe`, `npm.cmd`, and `npx.cmd`. Prepend it to
`PATH` for PowerShell calls, and reference `node.exe`/`npm.cmd` by full path
for Bash calls (Bash and PowerShell tool invocations don't share `PATH`
changes with each other).

## 2. Stop any process already holding the app

Check for a running node process before touching the database file — SQLite
WAL files (`data/poker_memo.db-wal`/`-shm`) will fail to delete or truncate
while a process holds them:

```powershell
Get-Process node -ErrorAction SilentlyContinue
```

If one is running and you intend to restart with fresh code, stop it:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -Confirm:$false
```

Only delete `data/poker_memo.db*` if you specifically want to reset local
data (e.g. after a schema change made during this session) — never do this
to the user's real session data without saying so first.

## 3. Start it

Run `npm start` in the background so the conversation isn't blocked, with
output captured to log files for inspection:

```powershell
$env:PATH = "<node dir from step 1>;" + $env:PATH
Set-Location "<project root>"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm start > server_out.log 2> server_err.log" -WorkingDirectory "<project root>" -WindowStyle Hidden
Start-Sleep -Seconds 2
Get-Content "<project root>\server_out.log" -ErrorAction SilentlyContinue
Get-Content "<project root>\server_err.log" -ErrorAction SilentlyContinue
```

Respect `PORT`/`HOST`/`APP_PASSWORD`/`ANTHROPIC_API_KEY` env vars if the user
has mentioned needing a non-default port, a PIN gate, or the AI-analysis
feature — set them (`$env:PORT = "8080"`, etc.) before `Start-Process`.

## 4. Verify

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/
```

Expect `HTTP 200`. If it fails, check `server_err.log` for a stack trace —
common causes are a stale process still holding the DB file (step 2) or a
syntax error from an in-progress edit.

## 5. Report

Tell the user the URL (`http://localhost:3000` by default, or the LAN/
Tailscale IP if they're testing from a phone — see README.md) and that the
process is running in the background. Don't leave duplicate node processes
running — always stop the old one before starting a new one, not after.
