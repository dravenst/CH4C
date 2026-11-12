---
name: ch4c-release
description: Cut a new CH4C release: bump the patch version, build all three platforms, draft release notes from the commits since the last tag, and (after the user approves the notes) tag, push and publish the GitHub release with the builds attached. Optionally deploy the released exe to the test/prod machines. Use only when the user asks for a release.
---

# Create a CH4C release

Releases are public: a tag and a GitHub release that CH4C's update check (`/api/check-update`) offers to every user. **Show the user the version and notes and wait for their OK before tagging or publishing.**

## Steps

1. **Check the starting point.**
   - `git status --short` must be clean, and `main` in sync with `origin/main` (`git status -sb`). If not, ask whether to commit or leave out the changes first.
   - Last release: `git tag --sort=-creatordate | head -1` and `gh release list --limit 3`. Its version should match `package.json`. If `package.json` is already ahead of the last tag, the bump was done before; don't bump again.
   - Commits to release: `git log --oneline <last tag>..HEAD`. If there are none, say so and stop.

2. **Bump the version.** Patch bump by default (0.6.6 → 0.6.7). Use minor or major only if the user asks.
   - Edit the `"version"` line in `package.json` (`APP_VERSION` is read from it; `package-lock.json` is gitignored).
   - Commit just that file as `Bump version to <x.y.z>`, matching earlier releases.

3. **Build all platforms:** `npm run build 2>&1 | grep -i " error"; ls -la dist/`
   - Expect `dist/ch4c.exe` (Windows), `dist/ch4c` (macOS Intel) and `dist/ch4c-arm64` (macOS Apple Silicon), all with fresh timestamps. The noVNC bytecode and missing `data/config.json` warnings are normal.
   - On an Apple Silicon Mac, `./dist/ch4c-arm64 --version` must print the new version.

4. **Draft the release notes** from the commits, in the style of earlier releases (`gh release view <last tag> --json body --jq .body`):
   - A `## Changes` list of user-facing changes, grouped by feature or service, in plain language. Read the full commit messages (`git show -s --format=%B <sha>`), not just the subjects.
   - Leave out commits that don't affect users: CLAUDE.md, skills, README-only changes, version bumps.
   - Don't describe bot-detection workarounds in detail; "search updates" is enough.
   - Write them to a file in the scratchpad.

5. **Get the user's OK.** Show the version, the commit list and the drafted notes. Make any edits they ask for. Don't continue until they approve.

6. **Tag and push:**
   ```sh
   git tag v<x.y.z>
   git push origin main
   git push origin v<x.y.z>
   ```

7. **Publish the release:**
   ```sh
   gh release create v<x.y.z> --title v<x.y.z> --notes-file <notes file> dist/ch4c dist/ch4c-arm64 dist/ch4c.exe
   ```
   Then check it: `gh release view v<x.y.z> --json isDraft,isPrerelease,assets` shows three assets whose sizes match `stat -f "%N %z" dist/ch4c dist/ch4c-arm64 dist/ch4c.exe`, and `gh release list --limit 2` shows it as Latest.

8. **Deploy, if the user wants it.** Use the `ch4c-deploy` skill for each machine, but **start from its step 2 and reuse the release's `dist/ch4c.exe`** instead of rebuilding, so the machines run exactly the published file. Confirm each one logs `CH4C version <x.y.z>`. Prod keeps its usual check for active recordings.

## Report

- The version, the release URL, and that the three uploaded assets match the local builds.
- Which machines were deployed to, and that each reports the new version.
