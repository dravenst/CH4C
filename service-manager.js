'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const TASK_NAME = 'CH4C';

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

  // Determine where to write the launcher script
  const launcherDir = dataDir || path.join(workingDir, 'data');
  if (!fs.existsSync(launcherDir)) {
    fs.mkdirSync(launcherDir, { recursive: true });
  }

  const launcherPath = path.join(launcherDir, 'ch4c-launcher.cmd');
  const script = `@echo off\r\ntimeout /t 30 /nobreak >nul\r\ncd /d "${workingDir}"\r\n${runCommand}\r\n`;
  fs.writeFileSync(launcherPath, script);

  return { launcherPath, workingDir };
}

function install(args) {
  if (process.platform !== 'win32') {
    console.error('Service installation is only supported on Windows.');
    process.exit(1);
  }

  const dataDir = parseDataDir(args);
  const { launcherPath } = createLauncherScript(dataDir);

  // Delete existing task if present
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
  } catch {
    // Ignore if task doesn't exist
  }

  // Create scheduled task - no /RL HIGHEST (Chrome doesn't like elevated privileges)
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
}

function uninstall() {
  if (process.platform !== 'win32') {
    console.error('Service uninstall is only supported on Windows.');
    process.exit(1);
  }

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
}

function status() {
  if (process.platform !== 'win32') {
    console.error('Service status is only supported on Windows.');
    process.exit(1);
  }

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
}

function start() {
  if (process.platform !== 'win32') {
    console.error('Service start is only supported on Windows.');
    process.exit(1);
  }

  try {
    execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe' });
    console.log(`\nCH4C scheduled task started.`);
  } catch (error) {
    console.error(`Failed to start CH4C task. Is it installed? Run: ch4c service install`);
    process.exit(1);
  }
}

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
  if (process.platform !== 'win32') {
    console.error('Service stop is only supported on Windows.');
    process.exit(1);
  }

  // Try graceful shutdown via HTTP API first
  const port = getCH4CPort();
  const graceful = await requestGracefulShutdown(port);

  if (graceful) {
    console.log(`\nCH4C is shutting down gracefully...`);
  } else {
    // Fall back to killing the scheduled task
    try {
      execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe' });
      console.log(`\nCH4C scheduled task stopped.`);
    } catch {
      console.log(`\nCH4C task is not currently running.`);
    }
  }
}

function showUsage() {
  console.log(`
Usage: ch4c service <command> [options]

Commands:
  install [-d <path>]  Install CH4C as a Windows scheduled task (starts at user logon)
                       Use -d to specify a custom data directory
  uninstall            Remove the CH4C scheduled task
  status               Check if the scheduled task is installed and running
  start                Start the CH4C scheduled task
  stop                 Stop the CH4C scheduled task

Examples:
  ch4c service install
  ch4c service install -d C:\\ch4c-data
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
