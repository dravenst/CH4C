---
name: ch4c-deploy
description: Build the CH4C Windows exe and deploy it to the test or prod server listed in CLAUDE.local.md: copy it to the share, swap it in, restart CH4C through its API and confirm the new build is running. Use only when the user asks to build and copy, deploy, or put a new exe on a machine. Pass "test" or "prod".
---

# Build and deploy CH4C to a server

Only deploy to the server the user named, and only when they asked. Never deploy to prod on your own initiative. If they didn't say which server, ask.

## Servers

The servers are in the **Machines** table in `CLAUDE.local.md` at the repo root: each one's CH4C host, SMB share, usual mount on this Mac, and the Windows folder the exe runs from. Below, `<host>`, `<SMB share>` and `<mount>` mean those values for the server named.

If `CLAUDE.local.md` or the table is missing (e.g. a fresh clone), ask the user for the server's details. Don't guess.

The steps assume each server runs CH4C as a Windows service. The service runs a launcher that starts `ch4c.exe` from the share folder and **starts it again 5 seconds after it exits**. Windows lets a running exe be renamed (but not overwritten), including over SMB. So a deploy renames the new build into place while the old one keeps running, then asks CH4C to restart.

The mount point name can change (macOS adds a `-1` suffix when names clash), so find it with `mount | grep -i smbfs` rather than assuming.

## Steps

1. **Build**, from the repo root:
   ```sh
   npm run build:win 2>&1 | grep -i " error"; ls -la dist/ch4c.exe
   ```
   The noVNC bytecode and missing `data/config.json` warnings are normal. Confirm the exe's timestamp is from just now, and note its size in bytes.

2. **Check the share.** Find it in `mount | grep -i smbfs`.
   - **Not mounted:** `osascript -e 'mount volume "<SMB share>"'`, which uses the saved keychain login.
   - **Mounted `read-only`:** `diskutil unmount <mount>`, then mount again. If it's still read-only, the Windows share or folder permissions need Change/Modify. Tell the user rather than working around it.
   - **List it** (`ls -la <mount>`) before changing anything.

3. **Check what's recording.** Restarting kills any active stream, including a Channels DVR recording.
   - `curl -s -m 10 <host>/health`: look at `activeStreams`.
   - `curl -s -m 10 <host>/api/scheduled-recordings`: look for a Record Later recording due in the next 10 minutes.
   - **test:** the user's OK to deploy covers interrupting streams there. Don't stop to ask; deploy anyway, and say in the report which streams or scheduled recordings were interrupted.
   - **prod:** if either is busy, **stop**. Tell the user what's active and ask before going on. Only continue past an active stream if they explicitly say so.
   - If `/health` doesn't respond, CH4C is down. Do steps 4–5, skip the restart, and say the new build will start when CH4C or the service starts.

4. **Copy the new build in:**
   ```sh
   cp dist/ch4c.exe <mount>/ch4c-new.exe && cmp dist/ch4c.exe <mount>/ch4c-new.exe && echo identical
   ```

5. **Swap by renaming.** Keep one rollback copy, named `ch4c-old.exe`. That's the only file the skill replaces or deletes; leave every other file on the share alone (the user may keep their own backups or folders there).
   ```sh
   rm -f <mount>/ch4c-old.exe
   mv <mount>/ch4c.exe <mount>/ch4c-old.exe
   mv <mount>/ch4c-new.exe <mount>/ch4c.exe
   ```
   If the first `mv` fails, stop and put things back as they were. Don't continue with a half-done swap.

6. **Restart CH4C:**
   ```sh
   curl -s -m 10 -X POST <host>/api/settings/restart
   ```
   This closes the browsers cleanly and exits, and the launcher starts the new `ch4c.exe` about 5 seconds later.

7. **Confirm the new build is running.** Poll `<host>/health` every few seconds until it stops answering and then answers again, up to about 2 minutes. Then read the startup lines from `/api/logs` (see the `ch4c-logs` skill) and check:
   - `Executable: <path> (<size> bytes)`: the size matches `dist/ch4c.exe`, and the path is the share folder's `ch4c.exe`. Builds of different code can occasionally come out the same size, so if the old exe (now `ch4c-old.exe`) has the same size as the new one, the size alone doesn't prove anything; say so.
   - `CH4C version <x.y.z>`: matches `package.json`. After a version bump this is what tells the new build apart from the old one.
   - No errors before `CH4C HTTP server listening on port 2442`.
   - Builds from before this line was added won't log it. If it's missing, the old build is still running.

## If it doesn't come back

The launcher keeps retrying every 5 seconds. To roll back without touching the Windows machine:
```sh
mv <mount>/ch4c.exe <mount>/ch4c-bad.exe
mv <mount>/ch4c-old.exe <mount>/ch4c.exe
```
The launcher's next retry starts the old build. Tell the user what happened, and check `/api/logs/previous` for why the new build failed.

## Report

- Which machine, that the copy matched byte for byte, and that the restarted CH4C reports the new exe's size.
- Whether the build includes uncommitted changes (`git status --short`).
- That `ch4c-old.exe` on the share is the rollback copy.
