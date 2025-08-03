# Automated Port Selection in Setup Scripts

## Feasibility

It is feasible to add logic in both `setup.sh` (bash) and `setup.bat` (batch) to check if the default port (e.g., 3000) is in use and increment to the next available port. This can be achieved using standard command-line utilities.

---

## Outline: Bash (Linux/macOS)

1. **Check if port is in use:**  
   Use `lsof -i :PORT` or `netstat -an | grep PORT`.
2. **Loop to find next available port:**  
   Start from 3000, increment until a free port is found.
3. **Update `.env` or pass port as environment variable:**  
   - Option 1: Edit the `PORT` value in `.env`.
   - Option 2: Export `PORT` variable before starting the server.

**Example Pseudocode:**
```bash
PORT=3000
while lsof -i :$PORT >/dev/null 2>&1; do
  PORT=$((PORT+1))
done
echo "Using port $PORT"
# Optionally update .env or export PORT
```

---

## Outline: Batch (Windows)

1. **Check if port is in use:**  
   Use `netstat -ano | findstr :PORT`.
2. **Loop to find next available port:**  
   Start from 3000, increment until a free port is found.
3. **Update `.env` or set environment variable:**  
   - Option 1: Edit the `PORT` value in `.env`.
   - Option 2: Set `PORT` variable for the session.

**Example Pseudocode:**
```batch
set PORT=3000
:checkport
netstat -ano | findstr :%PORT% >nul
if %ERRORLEVEL%==0 (
  set /a PORT=%PORT%+1
  goto checkport
)
echo Using port %PORT%
REM Optionally update .env or set PORT
```

---

## Considerations

- **Editing `.env`**: Scripts can use `sed` (bash) or `powershell` (batch) to update the `PORT` value.
- **User Notification**: Inform user which port is selected.
- **Docker**: For Docker, port mapping must be specified at run time (`-p` flag).

---

## Recommendation

- Implement port selection logic in both scripts.
- Prefer updating `.env` for consistency.
- Clearly notify user of the chosen port.
