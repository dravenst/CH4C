# Local setup (not committed)

Copy this file to `CLAUDE.local.md` (gitignored) and fill in your own values. The `ch4c-deploy` and `ch4c-logs` skills in `.claude/skills/` read the Machines table below; without it they ask for the details each time.

## Machines
| Name | Windows machine | CH4C host | SMB share | Usual mount (this Mac) | Exe folder on Windows | Runs as |
|------|-----------------|-----------|-----------|------------------------|-----------------------|---------|
| test | MYTESTPC | `http://192.168.1.10:2442` | `smb://user@MYTESTPC/CH4C` | `/Volumes/CH4C` | `D:\CH4C` | Windows service |
| prod | MYPRODPC | `http://192.168.1.20:2442` | `smb://user@MYPRODPC/ch4c` | `/Volumes/ch4c` | `C:\Users\user\Documents\ch4c` | Windows service |

- **Name**: what you call the machine when asking for a deploy or logs (`test`, `prod`, ...).
- **CH4C host**: CH4C's web address on that machine, used for `/health`, `/api/logs` and the restart API.
- **SMB share**: the share for the folder `ch4c.exe` runs from, as used by Finder's Connect to Server. The account needs write access.
- **Usual mount (this Mac)**: where macOS mounts that share on this Mac (`mount | grep -i smbfs`). It can differ between Macs.
- **Exe folder on Windows**: the same folder as seen on Windows. The startup log's `Executable:` line should show this path.
- **Runs as**: the deploy skill assumes a Windows service (`ch4c service install`). Its launcher restarts CH4C after it exits, which is how a deploy picks up the new exe.

## Working preferences
Optional. Anything you want every Claude session in this project to know, for example:
- Test changes on the test machine before committing.
- Deploys to test can interrupt active streams; prod deploys stop and ask if anything is recording.
