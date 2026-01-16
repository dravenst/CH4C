// Shared logging module for CH4C
// Provides centralized logging with buffer for web-based log viewer

const LOG_BUFFER_SIZE = 500;
const logBuffer = [];

/**
 * Log function with timestamp - writes to console and buffer
 * @param {string} message - The message to log
 * @param {...any} args - Additional arguments to log
 */
function logTS(message, ...args) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}]`, message, ...args);

  // Add to log buffer for web viewer
  const formattedMessage = args.length > 0
    ? `${message} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`
    : String(message);

  logBuffer.push({
    timestamp,
    message: formattedMessage
  });

  // Trim buffer if exceeds max size
  while (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.shift();
  }
}

/**
 * Get the current log buffer
 * @returns {Array} Array of log entries with timestamp and message
 */
function getLogBuffer() {
  return logBuffer;
}

module.exports = {
  logTS,
  getLogBuffer
};
