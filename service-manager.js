'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const TASK_NAME = 'CH4C';
const MAC_LABEL = 'com.ch4c';

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
 * Create a launcher batch file that the scheduled task will run.
 * This avoids nested quote issues with schtasks /TR.
 * @param {string|null} dataDir - Optional data directory to pass via -d flag
 * @returns {{ launcherPath: string, workingDir: string }}
 */
function createLauncherScript(dataDir) {
  const exePath = process.execPath;
  const isPackaged = path.basename(exePath).toLowerCase().startsWith('ch4c');
  const dataDirFlag = dataDir ? ` -d "${dataDir}"` : '';

  let workingDir, runCommand;
  if (isPackaged) {
    workingDir = path.dirname(exePath);
    runCommand = `"${exePath}"${dataDirFlag}`;
  } else {
    const mainScript = path.join(__dirname, 'main.js');
    workingDir = __dirname;
    runCommand = `"${exePath}" "${mainScript}"${dataDirFlag}`;
  }

  const launcherDir = dataDir || path.join(workingDir, 'data');
  if (!fs.existsSync(launcherDir)) {
    fs.mkdirSync(launcherDir, { recursive: true });
  }

  const launcherPath = path.join(launcherDir, 'ch4c-launcher.cmd');
  const script = `@echo off\r\ntimeout /t 30 /nobreak >nul\r\ncd /d "${workingDir}"\r\n${runCommand}\r\n`;
  fs.writeFileSync(launcherPath, script);

  return { launcherPath, workingDir };
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

function install(args) {
  const dataDir = parseDataDir(args);

  if (process.platform === 'win32') {
    const { launcherPath } = createLauncherScript(dataDir);

    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
    } catch {
      // Ignore if task doesn't exist
    }

    const createCmd = `schtasks /Create /TN "${TASK_NAME}" /TR "\\"${launcherPath}\\"" /SC ONLOGON /F`;
    try {
      execSync(createCmd, { stdio: 'pipe' });
      console.log(`\nCH4C scheduled task installed successfully.`);
      console.log(`  Task name: ${TASK_NAME}`);
      console.log(`  Trigger: At user logon (with 30 second delay)`);
      if (dataDir) console.log(`  Data directory: ${dataDir}`);
      console.log(`  Launcher: ${launcherPath}`);
      console.log(`\nCH4C will start automatically when you log in.`);
    } catch (error) {
      if (error.message && error.message.includes('Access is denied')) {
        console.error(`\nAccess denied. Run this command as Administrator.`);
      } else {
        console.error(`Failed to create scheduled task: ${error.message}`);
      }
      process.exit(1);
    }

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

function uninstall() {
  if (process.platform === 'win32') {
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
      console.log(`\nCH4C scheduled task removed successfully.`);
    } catch (error) {
      if (error.message && error.message.includes('Access is denied')) {
        console.error(`\nAccess denied. Run this command as Administrator.`);
        process.exit(1);
      }
      console.log(`\nCH4C scheduled task is not installed.`);
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
      const result = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO CSV /NH`, { encoding: 'utf8', stdio: 'pipe' });
      const isRunning = result.includes('Running');
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
      execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe' });
      console.log(`\nCH4C scheduled task started.`);
    } catch {
      console.error(`Failed to start CH4C task. Is it installed? Run: ch4c service install`);
      process.exit(1);
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

  if (graceful) {
    console.log(`\nCH4C is shutting down gracefully...`);
    return;
  }

  if (process.platform === 'win32') {
    try {
      execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe' });
      console.log(`\nCH4C scheduled task stopped.`);
    } catch {
      console.log(`\nCH4C task is not currently running.`);
    }

  } else if (process.platform === 'darwin') {
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

// ─── Usage ────────────────────────────────────────────────────────────────────

function showUsage() {
  console.log(`
Usage: ch4c service <command> [options]

Commands:
  install [-d <path>]  Install CH4C as a service that starts at login
                       Use -d to specify a custom data directory
  uninstall            Remove the CH4C service
  status               Check if the service is installed and running
  start                Start the CH4C service
  stop                 Stop the CH4C service

Examples (Windows):
  ch4c service install
  ch4c service install -d C:\\ch4c-data

Examples (macOS):
  ch4c service install
  ch4c service install -d ~/ch4c-data
`);
}

async function handleServiceCommand(args) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'install':
      install(args.slice(1));
      break;
    case 'uninstall':
      uninstall();
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
    default:
      showUsage();
      break;
  }

  process.exit(0);
}

module.exports = { handleServiceCommand };
