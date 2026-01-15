# noVNC Git Submodule Setup

## Overview
The `novnc/` directory is now managed as a git submodule, pointing to the official noVNC repository. This allows easy version tracking and updates.

## Current Setup
- **Repository**: https://github.com/novnc/noVNC.git
- **Current Version**: v1.6.0
- **Directory**: `novnc/`

## For New Clones

When someone clones the CH4C repository for the first time, they need to initialize the submodule:

```bash
git clone https://github.com/dravenst/CH4C.git
cd CH4C
git submodule init
git submodule update
```

Or clone with submodules in one command:
```bash
git clone --recurse-submodules https://github.com/dravenst/CH4C.git
```

## Updating noVNC

### Check for Updates
```bash
cd novnc
git fetch --tags
git tag | grep "^v1\." | sort -V | tail -5  # See latest v1.x versions
```

### Update to Latest Version
```bash
cd novnc
git fetch --tags
git checkout v1.6.0  # or whatever version you want
cd ..
git add novnc
git commit -m "Update noVNC to v1.6.0"
```

### Test After Updating
1. Start CH4C: `node main.js -s "http://YOUR_IP" -e "http://YOUR_ENCODER"`
2. Open Remote Access page
3. Test VNC connection, clipboard, zoom, and scroll controls
4. If working, push the commit

### Rollback if Issues
```bash
cd novnc
git checkout v1.5.0  # rollback to previous version
cd ..
git add novnc
git commit -m "Rollback noVNC to v1.5.0"
```

## Viewing Current Version
```bash
cd novnc
git describe --tags
```

Or check package.json:
```bash
cat novnc/package.json | grep version
```

## Important Notes

1. **Detached HEAD**: When you checkout a specific tag, git will be in "detached HEAD" state. This is normal and expected for submodules.

2. **Committing Changes**: After updating the submodule, you must commit in the parent repo:
   ```bash
   git add novnc
   git commit -m "Update noVNC to vX.Y.Z"
   ```

3. **Never Modify Submodule Files**: Don't make changes inside the `novnc/` directory. It's a reference to the upstream repository.

4. **Package Build**: The `pkg` configuration in package.json includes `"novnc/**/*"` which will bundle the submodule in the `.exe` build.

## Advantages Over Previous Approach

- ✅ Easy updates: Just `git checkout <tag>`
- ✅ Clear version tracking: Git shows exact commit/tag
- ✅ No manual downloads needed
- ✅ Can quickly test different versions
- ✅ Automatic on clone with `--recurse-submodules`
- ✅ Works with browser ES6 module imports (core/ directory)

## Related Documentation

- [REMOTE_ACCESS_SETUP.md](REMOTE_ACCESS_SETUP.md) - User guide for Remote Access feature
- [NOVNC_MIGRATION.md](NOVNC_MIGRATION.md) - Why npm package didn't work
