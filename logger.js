// Shared logging module for CH4C
// Provides centralized logging with buffer for web-based log viewer

const fs = require('fs');
const path = require('path');

const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
let logStream = null;

/**
 * Call once at startup with the data directory path.
 * Rotates ch4c.log → ch4c.prev.log, then opens a fresh ch4c.log for writing.
 */
function initLogger(dataDir) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });

    const currentLog = path.join(dataDir, 'ch4c.log');
    const prevLog = path.join(dataDir, 'ch4c.prev.log');

    if (fs.existsSync(currentLog)) {
      fs.renameSync(currentLog, prevLog);
    }

    logStream = fs.createWriteStream(currentLog, { flags: 'a' });
    logStream.on('error', (err) => {
      console.error(`Log file write error: ${err.message}`);
      logStream = null;
    });
  } catch (err) {
    console.error(`Failed to initialize log file: ${err.message}`);
  }
}

/**
 * Log function with timestamp - writes to console, in-memory buffer, and log file.
 */
function logTS(message, ...args) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}]`, message, ...args);

  const formattedMessage = args.length > 0
    ? `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`
    : String(message);

  logBuffer.push({ timestamp, message: formattedMessage });

  while (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }

  if (logStream) {
    logStream.write(`[${timestamp}] ${formattedMessage}\n`);
  }
}

/**
 * Get the current log buffer
 */
function getLogBuffer() {
  return logBuffer;
}

module.exports = {
  logTS,
  getLogBuffer,
  initLogger
};
