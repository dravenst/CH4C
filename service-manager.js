'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SERVICE_ID = 'CH4C';
const MAC_LABEL = 'com.ch4c';

// WinSW (Windows Service Wrapper) — turns CH4C into a real Windows service
// registered with the Service Control Manager (visible in services.msc).
// The wrapper executable is bundled with CH4C (vendor/winsw/WinSW-x64.exe,
// pinned at v2.12.0) so installs work offline — no runtime download.
const WINSW_BUNDLED = path.join(__dirname, 'vendor', 'winsw', 'WinSW-x64.exe');

/**
 * Parse -d or --data-dir from install arguments.
 * @param {string[]} args - Arguments after 'install'
 * @returns {string|null} - Data directory path or null
 */
function parseDataDir(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--data-dir=')) return arg.split('=')[1];
    if (arg.startsWith('-d=')) return arg.split('=')[1];
    if ((arg === '--data-dir' || arg === '-d') && args[i + 1]) return args[i + 1];
  }
  return null;
}

// ─── Windows helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the directory that holds the WinSW wrapper, its XML config and logs.
 * Uses the -d data directory when given, otherwise CH4C's default %APPDATA%\ch4c.
 * @param {string|null} dataDir
 * @returns {string}
 */
function getWindowsServiceDir(dataDir) {
  if (dataDir) return dataDir;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'ch4c');
}

/** Escape a string for safe inclusion in XML text content. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Resolve how the service should launch CH4C (packaged exe vs. node + main.js).
 * @param {string|null} dataDir
 * @returns {{ executable: string, args: string, workingDir: string }}
 */
function resolveServiceTarget(dataDir) {
  const exePath = process.execPath;
  const isPackaged = path.basename(exePath).toLowerCase().startsWith('ch4c');
  const dataDirArg = dataDir ? ` -d "${dataDir}"` : '';

  if (isPackaged) {
    return { executable: exePath, args: dataDirArg.trim(), workingDir: path.dirname(exePath) };
  }
  const mainScript = path.join(__dirname, 'main.js');
  return { executable: exePath, args: `"${mainScript}"${dataDirArg}`, workingDir: __dirname };
}

/**
 * Write the WinSW XML config. The service itself runs as LocalSystem — the
 * default — so it holds the privilege needed to launch CH4C into the
 * interactive user's session (see ch4c-launcher.cs). The wrapped executable
 * is therefore the launcher, not CH4C directly.
 * @param {string} xmlPath
 * @param {string} launcherExe - Path to the compiled ch4c-launcher.exe
 * @param {string|null} dataDir
 */
function writeServiceXml(xmlPath, launcherExe, dataDir) {
  const { executable, args, workingDir } = resolveServiceTarget(dataDir);

  // The launcher receives CH4C's command line as its own arguments.
  const ch4cCommand = (executable.includes(' ') ? `"${executable}"` : executable)
    + (args ? ` ${args}` : '');

  const xml = `<service>
  <id>${SERVICE_ID}</id>
  <name>CH4C - Chrome HDMI for Channels</name>
  <description>Chrome HDMI for Channels DVR - captures web streams via Chrome for Channels DVR.</description>
  <executable>${escapeXml(launcherExe)}</executable>
  <arguments>${escapeXml(ch4cCommand)}</arguments>
  <workingdirectory>${escapeXml(workingDir)}</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="15 sec"/>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>3</keepFiles>
  </log>
</service>
`;
  fs.writeFileSync(xmlPath, xml, 'utf8');
}

/**
 * Locate the .NET Framework C# compiler. csc.exe ships with the .NET
 * Framework 4.x runtime, which is present on every supported Windows release.
 * @returns {string|null}
 */
function findCsc() {
  const winDir = process.env.WINDIR || process.env.SystemRoot;
  if (!winDir) return null;
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find(fs.existsSync) || null;
}

/**
 * Copy ch4c-launcher.cs into the service directory and compile it to an exe.
 * Done at install time so the service ships no prebuilt binaries.
 * @param {string} serviceDir
 * @returns {string} - Path to the compiled ch4c-launcher.exe
 */
function compileLauncher(serviceDir) {
  const csc = findCsc();
  if (!csc) {
    throw new Error('Could not find the C# compiler (csc.exe). '
      + 'The .NET Framework 4.x runtime is required to install the CH4C service.');
  }
  const srcPath = path.join(serviceDir, 'ch4c-launcher.cs');
  const exePath = path.join(serviceDir, 'ch4c-launcher.exe');
  fs.writeFileSync(srcPath, fs.readFileSync(path.join(__dirname, 'ch4c-launcher.cs')));
  execSync(`"${csc}" /nologo /optimize+ /target:exe /out:"${exePath}" "${srcPath}"`, { stdio: 'pipe' });
  return exePath;
}

/**
 * Register CH4C as a Windows service via the WinSW wrapper.
 *
 * The service runs as LocalSystem and its job is to launch CH4C into the
 * logged-in user's interactive session with a de-elevated token — a Windows
 * service cannot run Chrome itself (it has no desktop, and CH4C refuses to
 * start elevated). No account or password is needed: LocalSystem already
 * holds the privilege required to spawn into the user's session.
 * @param {string|null} dataDir
 */
async function installWindows(dataDir) {
  const serviceDir = getWindowsServiceDir(dataDir);
  fs.mkdirSync(serviceDir, { recursive: true });

  const winswPath = path.join(serviceDir, 'ch4c-service.exe');
  const xmlPath = path.join(serviceDir, 'ch4c-service.xml');

  if (!fs.existsSync(winswPath)) {
    console.log('Installing the Windows service wrapper (WinSW)...');
    try {
      fs.writeFileSync(winswPath, fs.readFileSync(WINSW_BUNDLED));
    } catch (error) {
      console.error(`\nFailed to install the service wrapper: ${error.message}`);
      process.exit(1);
    }
  }

  const runWinSW = (verb) => execSync(`"${winswPath}" ${verb}`, { cwd: serviceDir, stdio: 'pipe' });

  // Clear any previous install first — compiling the launcher below overwrites
  // ch4c-launcher.exe in place, which fails if a still-running service instance
  // from a prior install has that file open.
  for (const verb of ['stop', 'uninstall']) {
    try { runWinSW(verb); } catch { /* nothing to clean up */ }
  }

  let launcherExe;
  try {
    console.log('Building the CH4C session launcher...');
    launcherExe = compileLauncher(serviceDir);
  } catch (error) {
    const detail = ((error.stderr && error.stderr.toString()) || error.message || '').trim();
    console.error(`\nFailed to build the session launcher:\n  ${detail.split('\n').join('\n  ')}`);
    process.exit(1);
  }

  writeServiceXml(xmlPath, launcherExe, dataDir);

  try {
    runWinSW('install');
  } catch (error) {
    const msg = error.message || '';
    if (/access is denied|administrator|elevation/i.test(msg)) {
      console.error('\nAccess denied. Run this command as Administrator.');
    } else if (/1072|marked for deletion/i.test(msg)) {
      console.error('\nThe previous CH4C service is still being removed.');
      console.error('Close services.msc if it is open, then run: ch4c service install');
    } else {
      console.error(`\nFailed to register the CH4C service: ${msg}`);
    }
    process.exit(1);
  }

  let startError = '';
  try {
    runWinSW('start');
  } catch (error) {
    startError = ((error.stderr && error.stderr.toString()) || error.message || '').trim();
  }

  console.log(`\nCH4C Windows service installed successfully.`);
  console.log(`  Service name: ${SERVICE_ID} (visible in services.msc)`);
  console.log(`  Startup: Automatic`);
  console.log(`  Runs CH4C as: the logged-in user, in their interactive session`);
  if (dataDir) console.log(`  Data directory: ${dataDir}`);
  console.log(`  Files: ${serviceDir}`);

  if (startError) {
    console.error(`\nThe service was registered but did not start:`);
    console.error(`  ${startError.split('\n').join('\n  ')}`);
  } else {
    console.log(`\nThe service is running. CH4C starts whenever a user is logged in.`);
    console.log(`Manage it with: ch4c service start | stop | status | logs | uninstall`);
  }

  await offerPathSetup();
}

/**
 * Append a directory to the current user's PATH (persisted, not just this
 * session). Returns 'added' or 'present'.
 * @param {string} dir
 */
function addToPath(dir) {
  const safeDir = dir.replace(/'/g, "''");
  const ps = `$d='${safeDir}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); `
    + `if($null -eq $p){$p=''}; if(($p -split ';') -contains $d){'present'}`
    + `else{[Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';'+$d).TrimStart(';'),'User');'added'}`;
  // Pass the script as -EncodedCommand (base64 of UTF-16LE) so no characters in
  // the install path can break out of the shell's command-line quoting.
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { encoding: 'utf8' }).trim();
}

/** Ask a Yes/No question. Returns `defaultYes` on a blank answer, false if non-interactive. */
function askYesNo(question, defaultYes) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === '' ? defaultYes : (a === 'y' || a === 'yes'));
    });
  });
}

/**
 * After install, ask whether to add ch4c.exe's folder to the user's PATH so
 * the `ch4c` command works from any terminal. Packaged executable only.
 */
async function offerPathSetup() {
  const exePath = process.execPath;
  const isPackaged = path.basename(exePath).toLowerCase().startsWith('ch4c');
  if (!isPackaged) return; // running from source — nothing to add

  const dir = path.dirname(exePath);
  const yes = await askYesNo(
    `\nWould you like to add CH4C to your PATH, so you can run the "ch4c"\n`
    + `command (for example "ch4c service logs") from any terminal? [Y/n] `, true);

  if (!yes) {
    console.log(`\nOK, skipped. You can always run CH4C from:\n  ${dir}`);
    return;
  }
  try {
    if (addToPath(dir) === 'added') {
      console.log(`\nAll set! Open a new terminal and "ch4c" will work from anywhere.`);
    } else {
      console.log(`\nCH4C is already on your PATH — you're good to go.`);
    }
  } catch (error) {
    console.error(`\nSorry, couldn't update your PATH automatically (${error.message}).`);
    console.error(`You can still run CH4C from:\n  ${dir}`);
  }
}

// ─── macOS helpers ────────────────────────────────────────────────────────────

function getMacPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

/**
 * Create a launchd plist for macOS.
 * Points ProgramArguments directly at node/the binary — no shell script wrapper,
 * which avoids "Operation not permitted" errors from launchd executing a shell script.
 * @param {string|null} dataDir
 * @returns {{ plistPath: string, logPath: string }}
 */
function createMacLauncherFiles(dataDir) {
  const exePath = process.execPath;
  const isPackaged = path.basename(exePath).toLowerCase().startsWith('ch4c');

  let workingDir, programArgs;
  if (isPackaged) {
    workingDir = path.dirname(exePath);
    programArgs = [exePath];
  } else {
    const mainScript = path.join(__dirname, 'main.js');
    workingDir = __dirname;
    programArgs = [exePath, mainScript];
  }
  if (dataDir) programArgs.push('-d', dataDir);

  const defaultDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'ch4c');
  const launcherDir = dataDir || defaultDataDir;
  if (!fs.existsSync(launcherDir)) {
    fs.mkdirSync(launcherDir, { recursive: true });
  }

  const logPath = path.join(launcherDir, 'ch4c.log');

  const plistPath = getMacPlistPath();
  const plistDir = path.dirname(plistPath);
  if (!fs.existsSync(plistDir)) {
    fs.mkdirSync(plistDir, { recursive: true });
  }

  // Build <string> entries for each argument
  const argEntries = programArgs.map(a => `        <string>${a}</string>`).join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${MAC_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argEntries}
    </array>
    <key>WorkingDirectory</key>
    <string>${workingDir}</string>
    <key>RunAtLoad</key>
    <false/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${logPath}</string>
    <key>StandardErrorPath</key>
    <string>${logPath}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, 'utf8');

  return { plistPath, logPath };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function install(args) {
  const dataDir = parseDataDir(args);

  if (process.platform === 'win32') {
    await installWindows(dataDir);

  } else if (process.platform === 'darwin') {
    const { plistPath, logPath } = createMacLauncherFiles(dataDir);

    // Unload existing agent if present
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
      // Ignore if not loaded
    }

    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
      console.log(`\nCH4C launch agent installed successfully.`);
      console.log(`  Label: ${MAC_LABEL}`);
      console.log(`  Trigger: At user login`);
      if (dataDir) console.log(`  Data directory: ${dataDir}`);
      console.log(`  Plist: ${plistPath}`);
      console.log(`  Log: ${logPath}`);
      console.log(`\nCH4C will start automatically when you log in.`);
    } catch (error) {
      console.error(`Failed to load launch agent: ${error.message}`);
      process.exit(1);
    }

  } else {
    console.error('Service installation is only supported on Windows and macOS.');
    process.exit(1);
  }
}

function uninstall(args) {
  if (process.platform === 'win32') {
    try {
      execSync(`sc stop ${SERVICE_ID}`, { stdio: 'pipe' });
    } catch (error) {
      // A stop failure usually just means the service was not running. An
      // access-denied error, though, means this needs to run elevated —
      // surface it now rather than letting it resurface on sc delete.
      if (error.message && error.message.includes('Access is denied')) {
        console.error(`\nAccess denied. Run this command as Administrator.`);
        process.exit(1);
      }
    }

    let removed = false;
    try {
      execSync(`sc delete ${SERVICE_ID}`, { stdio: 'pipe' });
      console.log(`\nCH4C Windows service removed successfully.`);
      removed = true;
    } catch (error) {
      if (error.message && error.message.includes('Access is denied')) {
        console.error(`\nAccess denied. Run this command as Administrator.`);
        process.exit(1);
      }
      console.log(`\nCH4C Windows service is not installed.`);
    }

    // Best-effort cleanup of the WinSW wrapper and launcher files.
    if (removed) {
      const serviceDir = getWindowsServiceDir(parseDataDir(args || []));
      const files = ['ch4c-service.exe', 'ch4c-service.xml', 'ch4c-launcher.exe', 'ch4c-launcher.cs'];
      for (const file of files) {
        try { fs.unlinkSync(path.join(serviceDir, file)); } catch { /* ignore */ }
      }
    }

  } else if (process.platform === 'darwin') {
    const plistPath = getMacPlistPath();

    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch {
      // Ignore if not loaded
    }

    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
      console.log(`\nCH4C launch agent removed successfully.`);
    } else {
      console.log(`\nCH4C launch agent is not installed.`);
    }

  } else {
    console.error('Service uninstall is only supported on Windows and macOS.');
    process.exit(1);
  }
}

function status() {
  if (process.platform === 'win32') {
    try {
      const result = execSync(`sc query ${SERVICE_ID}`, { encoding: 'utf8', stdio: 'pipe' });
      const isRunning = /STATE\s*:\s*\d+\s+RUNNING/i.test(result);
      console.log(`\nCH4C service status:`);
      console.log(`  Installed: Yes`);
      console.log(`  Running: ${isRunning ? 'Yes' : 'No'}`);
    } catch {
      console.log(`\nCH4C service status:`);
      console.log(`  Installed: No`);
    }

  } else if (process.platform === 'darwin') {
    const plistPath = getMacPlistPath();
    const installed = fs.existsSync(plistPath);

    let running = false;
    try {
      // launchctl list <label> exits 0 and prints a dict if loaded; non-zero if not
      const result = execSync(`launchctl list ${MAC_LABEL}`, { encoding: 'utf8', stdio: 'pipe' });
      // If a PID key is present and non-zero the process is running
      running = /"PID"\s*=\s*[1-9]/.test(result);
    } catch {
      // Not loaded
    }

    console.log(`\nCH4C service status:`);
    console.log(`  Installed: ${installed ? 'Yes' : 'No'}`);
    console.log(`  Running: ${running ? 'Yes' : 'No'}`);

  } else {
    console.error('Service status is only supported on Windows and macOS.');
    process.exit(1);
  }
}

function start() {
  if (process.platform === 'win32') {
    try {
      execSync(`sc start ${SERVICE_ID}`, { stdio: 'pipe' });
      console.log(`\nCH4C Windows service started.`);
    } catch (error) {
      if (error.message && error.message.includes('1056')) {
        console.log(`\nCH4C Windows service is already running.`);
      } else {
        console.error(`Failed to start CH4C service. Is it installed? Run: ch4c service install`);
        process.exit(1);
      }
    }

  } else if (process.platform === 'darwin') {
    try {
      execSync(`launchctl start ${MAC_LABEL}`, { stdio: 'pipe' });
      console.log(`\nCH4C launch agent started.`);
    } catch {
      console.error(`Failed to start CH4C. Is it installed? Run: ch4c service install`);
      process.exit(1);
    }

  } else {
    console.error('Service start is only supported on Windows and macOS.');
    process.exit(1);
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Read the CH4C port from config.json (default: 2442).
 */
function getCH4CPort() {
  const configPaths = [
    path.join(__dirname, 'data', 'config.json'),
    path.join(process.cwd(), 'data', 'config.json')
  ];
  for (const configPath of configPaths) {
    try {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.ch4cPort) return config.ch4cPort;
      }
    } catch {
      // Ignore parse errors, fall through to default
    }
  }
  return 2442;
}

/**
 * Request graceful shutdown via the CH4C HTTP API.
 * Returns true if the server acknowledged the shutdown.
 */
function requestGracefulShutdown(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/shutdown',
      method: 'POST',
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.success === true);
        } catch {
          resolve(false);
        }
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function stop() {
  const port = getCH4CPort();
  const graceful = await requestGracefulShutdown(port);

  if (process.platform === 'win32') {
    // A graceful request lets CH4C close Chrome cleanly, but the launcher
    // service would immediately restart it — so the service must be stopped.
    if (graceful) console.log(`\nCH4C is shutting down gracefully...`);
    try {
      execSync(`sc stop ${SERVICE_ID}`, { stdio: 'pipe' });
      console.log(`\nCH4C Windows service stopped.`);
    } catch {
      if (!graceful) console.log(`\nCH4C Windows service is not currently running.`);
    }
    return;
  }

  if (graceful) {
    console.log(`\nCH4C is shutting down gracefully...`);
    return;
  }

  if (process.platform === 'darwin') {
    try {
      execSync(`launchctl stop ${MAC_LABEL}`, { stdio: 'pipe' });
      console.log(`\nCH4C launch agent stopped.`);
    } catch {
      console.log(`\nCH4C is not currently running.`);
    }

  } else {
    console.error('Service stop is only supported on Windows and macOS.');
    process.exit(1);
  }
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

/**
 * Resolve CH4C's data directory — where ch4c.log is written.
 * Mirrors CH4C's own default (%APPDATA%\ch4c on Windows).
 * @param {string|null} dataDir - Explicit -d value, if any
 */
function getDataDir(dataDir) {
  if (dataDir) return dataDir;
  if (process.platform === 'win32') {
    // CH4C keeps using a legacy ./data folder next to the exe if one exists.
    const legacy = path.join(path.dirname(process.execPath), 'data');
    if (fs.existsSync(legacy)) return legacy;
    return getWindowsServiceDir(null);
  }
  return path.join(os.homedir(), 'Library', 'Application Support', 'ch4c');
}

/** Print the last `maxLines` lines of a text file. */
function printTail(file, maxLines) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  console.log(lines.slice(-maxLines).join('\n'));
}

/**
 * Tail CH4C's log live. The Windows service runs hidden with no console
 * window, so this prints the current log and then streams new output until
 * interrupted. Windows only.
 * @returns {boolean} true if now tailing (caller must not exit)
 */
function logs(args) {
  if (process.platform !== 'win32') {
    console.log(`\n"ch4c service logs" is a Windows-only feature.`);
    return false;
  }

  const dataDir = parseDataDir(args);
  const logFile = path.join(getDataDir(dataDir), 'ch4c.log');
  const serviceLog = path.join(getWindowsServiceDir(dataDir), 'ch4c-service.out.log');

  console.log(`\nCH4C log: ${logFile}`);
  console.log(`Service launcher log: ${serviceLog}`);

  let pos = 0;
  if (fs.existsSync(logFile)) {
    console.log('');
    const existing = fs.readFileSync(logFile);
    process.stdout.write(existing);
    pos = existing.length;
  } else {
    console.log(`\nCH4C has not logged yet — waiting for it to start...`);
    if (fs.existsSync(serviceLog)) {
      console.log(`\n--- service launcher log ---`);
      printTail(serviceLog, 40);
    }
  }

  console.log(`\n--- tailing live (press Ctrl+C to stop) ---`);
  fs.watchFile(logFile, { interval: 1000 }, (curr) => {
    if (curr.size < pos) pos = 0; // log was rotated on a CH4C restart
    if (curr.size > pos) {
      const stream = fs.createReadStream(logFile, { start: pos, end: curr.size - 1 });
      stream.on('data', (chunk) => process.stdout.write(chunk));
      pos = curr.size;
    }
  });
  return true;
}

// ─── Usage ────────────────────────────────────────────────────────────────────

function showUsage() {
  console.log(`
Usage: ch4c service <command> [options]

Commands:
  install [-d <path>]  Install CH4C as a service that starts automatically
                       Use -d to specify a custom data directory
  uninstall            Remove the CH4C service
  status               Check if the service is installed and running
  start                Start the CH4C service
  stop                 Stop the CH4C service
  logs [-d <path>]     Tail CH4C's log live (Windows; the service runs hidden)

Examples (Windows):
  ch4c service install
  ch4c service install -d <data-folder>
  ch4c service logs

Examples (macOS):
  ch4c service install
  ch4c service install -d ~/ch4c-data
  ch4c service logs
`);
}

async function handleServiceCommand(args) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'install':
      await install(args.slice(1));
      break;
    case 'uninstall':
      uninstall(args.slice(1));
      break;
    case 'status':
      status();
      break;
    case 'start':
      start();
      break;
    case 'stop':
      await stop();
      break;
    case 'logs':
      if (logs(args.slice(1))) return; // tailing — stay alive
      break;
    default:
      showUsage();
      break;
  }

  process.exit(0);
}

module.exports = { handleServiceCommand };
