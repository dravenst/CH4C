// error-handling.js
const fetch = require('node-fetch');
const { execSync } = require('child_process');
const os = require('os');

// Helper function - add this since it's used by the error handling code
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// log function with timestamp
function logTS(message , ...args) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}]`, message, ...args);
}

/**
 * Force kill all Chrome processes associated with a specific user data directory
 * This is needed when Chrome crashes but leaves zombie processes holding locks
 * @param {string} userDataDir - The user data directory path
 */
async function killChromeProcessesForUserData(userDataDir) {
  if (os.platform() !== 'win32') {
    // For Linux/Mac, we could use pgrep/pkill but this is mainly for Windows
    logTS('Chrome process killing only implemented for Windows');
    return;
  }

  try {
    // Normalize the path for comparison
    const normalizedPath = userDataDir.toLowerCase().replace(/\//g, '\\');

    // Get all Chrome processes with their command lines
    const output = execSync('wmic process where "name=\'chrome.exe\'" get commandline,processid', {
      encoding: 'utf8',
      timeout: 5000
    });

    const lines = output.split('\n');
    const pidsToKill = [];

    for (const line of lines) {
      const lowerLine = line.toLowerCase();
      if (lowerLine.includes(normalizedPath)) {
        // Extract PID from the end of the line
        const match = line.trim().match(/(\d+)\s*$/);
        if (match) {
          pidsToKill.push(match[1]);
        }
      }
    }

    if (pidsToKill.length > 0) {
      logTS(`Found ${pidsToKill.length} Chrome processes using ${userDataDir}, killing them...`);
      for (const pid of pidsToKill) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 });
          logTS(`Killed Chrome process ${pid}`);
        } catch (killErr) {
          logTS(`Failed to kill Chrome process ${pid}: ${killErr.message}`);
        }
      }
      // Wait a bit for processes to fully terminate
      await delay(1000);
    } else {
      logTS(`No lingering Chrome processes found for ${userDataDir}`);
    }
  } catch (error) {
    logTS(`Error checking for Chrome processes: ${error.message}`);
  }
}

/**
 * Health check system for encoders
 */
class EncoderHealthMonitor {
  constructor() {
    this.healthStatus = new Map();
    this.maxFailures = 3;
    this.checkInterval = 60000;
    this.retryDelay = 5000;
  }

  async checkEncoderHealth(encoderUrl, timeout = 3000) {
    try {
      // Use a more conservative approach for health checks
      const response = await fetch(encoderUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(timeout),
        headers: {
          'Accept': '*/*',
          'Range': 'bytes=0-1' // Request minimal data
        }
      });
      
      const isHealthy = response.status >= 200 && response.status < 500;
      this.updateHealth(encoderUrl, isHealthy);
      return isHealthy;
      
    } catch (error) {
      // Only consider it healthy if it's a streaming timeout, not a connection failure
      if (error.code === 'ECONNREFUSED' || 
          error.code === 'EHOSTUNREACH' || 
          error.code === 'ENETUNREACH' ||
          error.code === 'ENOTFOUND' ||
          error.code === 'ETIMEDOUT' ||
          error.code === 'ESOCKETTIMEDOUT') {
        // These are definite failures
        logTS(`Health check failed for ${encoderUrl}: ${error.code || error.message}`);
        this.updateHealth(encoderUrl, false);
        return false;
      }
      
      // For abort errors, try a TCP connection test
      if (error.name === 'AbortError') {
        const net = require('net');
        try {
          const url = new URL(encoderUrl);
          const port = url.port || (url.protocol === 'https:' ? 443 : 80);
          
          const isReachable = await new Promise((resolve) => {
            const socket = new net.Socket();
            const timer = setTimeout(() => {
              socket.destroy();
              resolve(false);
            }, 1000);
            
            socket.on('connect', () => {
              clearTimeout(timer);
              socket.destroy();
              resolve(true);
            });
            
            socket.on('error', () => {
              clearTimeout(timer);
              resolve(false);
            });
            
            socket.connect(port, url.hostname);
          });
          
          this.updateHealth(encoderUrl, isReachable);
          if (!isReachable) {
            logTS(`Health check failed - cannot connect to ${encoderUrl}`);
          }
          return isReachable;
        } catch (e) {
          logTS(`Health check error for ${encoderUrl}: ${e.message}`);
          this.updateHealth(encoderUrl, false);
          return false;
        }
      }
      
      logTS(`Health check uncertain for ${encoderUrl}: ${error.message}`);
      this.updateHealth(encoderUrl, false);
      return false;
    }
  }

  updateHealth(encoderUrl, isHealthy) {
    const current = this.healthStatus.get(encoderUrl) || { 
      isHealthy: true, 
      lastCheck: Date.now(), 
      failureCount: 0 
    };
    
    this.healthStatus.set(encoderUrl, {
      isHealthy,
      lastCheck: Date.now(),
      failureCount: isHealthy ? 0 : current.failureCount + 1
    });
  }

  isEncoderHealthy(encoderUrl) {
    const status = this.healthStatus.get(encoderUrl);
    if (!status) return true;
    
    if (status.failureCount >= this.maxFailures) {
      return false;
    }
    
    const isStale = Date.now() - status.lastCheck > this.checkInterval * 3;
    return !isStale && status.isHealthy;
  }

  async startMonitoring(encoders) {
    for (const encoder of encoders) {
      await this.checkEncoderHealth(encoder.url);
    }
    
    setInterval(async () => {
      for (const encoder of encoders) {
        await this.checkEncoderHealth(encoder.url);
      }
    }, this.checkInterval);
  }
}

/**
 * Enhanced browser recovery system
 */
class BrowserRecoveryManager {
  constructor() {
    this.recoveryAttempts = new Map(); // encoderUrl -> attempt count
    this.maxRecoveryAttempts = 3;
    this.recoveryBackoff = [1000, 5000, 15000]; // Progressive backoff
  }

  async attemptBrowserRecovery(encoderUrl, encoderConfig, browsers, launchBrowserFunc, Constants) {
    const attempts = this.recoveryAttempts.get(encoderUrl) || 0;

    if (attempts >= this.maxRecoveryAttempts) {
      logTS(`Max recovery attempts reached for ${encoderUrl}. Marking as failed.`);
      return false;
    }

    const backoffDelay = this.recoveryBackoff[attempts] || 30000;
    logTS(`Attempting browser recovery for ${encoderUrl} (attempt ${attempts + 1}/${this.maxRecoveryAttempts})`);

    // Close any existing browser instance
    if (browsers.has(encoderUrl)) {
      try {
        const browser = browsers.get(encoderUrl);
        if (browser && browser.isConnected()) {
          await browser.close();
        }
      } catch (e) {
        logTS(`Error closing browser during recovery: ${e.message}`);
      }
      browsers.delete(encoderUrl);
    }

    // Kill any lingering Chrome processes for this encoder
    if (Constants && Constants.ENCODERS) {
      try {
        const path = require('path');
        const encoderIndex = Constants.ENCODERS.findIndex(e => e.url === encoderConfig.url);
        if (encoderIndex !== -1) {
          const chromeDataDir = Constants.CHROME_USERDATA_DIRECTORIES[os.platform()][0].replace('User Data', '').trim();
          const uniqueUserDataDir = path.join(chromeDataDir, 'User Data', `encoder_${encoderIndex}`);
          logTS(`Checking for lingering Chrome processes for ${uniqueUserDataDir}`);
          await killChromeProcessesForUserData(uniqueUserDataDir);
        }
      } catch (e) {
        logTS(`Error killing Chrome processes: ${e.message}`);
      }
    }

    // Wait with backoff
    await delay(backoffDelay);

    // Attempt to relaunch with retry logic
    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount < maxRetries) {
      try {
        const success = await launchBrowserFunc("about:blank", encoderConfig, true, false);
        if (success) {
          logTS(`Successfully recovered browser for ${encoderUrl}`);
          this.recoveryAttempts.set(encoderUrl, 0); // Reset on success
          return true;
        }
        break; // If success is false, don't retry
      } catch (error) {
        retryCount++;
        logTS(`Recovery attempt ${retryCount} failed for ${encoderUrl}: ${error.message}`);

        // For certain errors, add additional delay and cleanup
        if (error.message.includes('Failed to launch') || error.message.includes('Target closed')) {
          if (retryCount < maxRetries) {
            logTS(`Waiting additional ${5000 * retryCount}ms before retry...`);
            await delay(5000 * retryCount);

            // Try to clean up any stale processes or locks
            if (browsers.has(encoderUrl)) {
              browsers.delete(encoderUrl);
            }
          }
        } else {
          break; // For other errors, don't retry
        }
      }
    }

    this.recoveryAttempts.set(encoderUrl, attempts + 1);
    return false;
  }

  resetAttempts(encoderUrl) {
    this.recoveryAttempts.delete(encoderUrl);
  }
}

/**
 * Enhanced connection validation with retry logic
 */
async function validateEncoderConnection(encoderUrl, maxRetries = 3, retryDelay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logTS(`Validating encoder connection ${encoderUrl} (attempt ${attempt}/${maxRetries})`);
      
      // First, try a quick connection with a short timeout to see if the host exists
      try {
        const quickResponse = await fetch(encoderUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(3000), // 3 second timeout
          headers: {
            'Accept': '*/*',
            'Range': 'bytes=0-1' // Request only first 2 bytes to minimize data transfer
          }
        });
        
        // If we get here, the encoder responded
        if (quickResponse.status >= 200 && quickResponse.status < 500) {
          logTS(`Encoder ${encoderUrl} is reachable (status: ${quickResponse.status})`);
          return true;
        } else if (quickResponse.status >= 500) {
          logTS(`Encoder ${encoderUrl} returned server error ${quickResponse.status}`);
          // Server errors might be temporary, continue retrying
        }
      } catch (error) {
        // Analyze the error type to determine if encoder exists
        if (error.code === 'ECONNREFUSED') {
          // Host exists but refusing connections
          logTS(`Connection refused by encoder ${encoderUrl} - host exists but port may be wrong`);
          return false; // Don't retry, configuration issue
        } else if (error.code === 'EHOSTUNREACH' || error.code === 'ENETUNREACH') {
          // Network routing issue
          logTS(`Host unreachable for encoder ${encoderUrl} - network routing issue`);
          return false; // Don't retry, network issue
        } else if (error.code === 'ENOTFOUND') {
          // DNS resolution failed
          logTS(`Host not found for encoder ${encoderUrl} - DNS resolution failed`);
          return false; // Don't retry, wrong hostname
        } else if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT') {
          // Connection timeout - host might not exist or be very slow
          logTS(`Connection timeout for encoder ${encoderUrl} - host may not exist`);
          
          // Try a different validation method - check if we can at least resolve the host
          try {
            const url = new URL(encoderUrl);
            const dns = require('dns').promises;
            await dns.lookup(url.hostname);
            
            // If DNS resolves but connection times out, might be a firewall issue
            logTS(`Host ${url.hostname} resolves but connection times out - possible firewall/network issue`);
            // Continue to retry in this case
          } catch (dnsError) {
            logTS(`Cannot resolve host for ${encoderUrl} - host does not exist`);
            return false; // Host doesn't exist, don't retry
          }
        } else if (error.name === 'AbortError') {
          // Our timeout fired - but we need to distinguish between slow response and no response
          logTS(`Request aborted due to timeout for ${encoderUrl}`);
          
          // Try one more time with just a TCP connection test
          const net = require('net');
          const url = new URL(encoderUrl);
          const port = url.port || (url.protocol === 'https:' ? 443 : 80);
          
          const canConnect = await new Promise((resolve) => {
            const socket = new net.Socket();
            const timeout = setTimeout(() => {
              socket.destroy();
              resolve(false);
            }, 2000);
            
            socket.on('connect', () => {
              clearTimeout(timeout);
              socket.destroy();
              resolve(true);
            });
            
            socket.on('error', () => {
              clearTimeout(timeout);
              resolve(false);
            });
            
            socket.connect(port, url.hostname);
          });
          
          if (canConnect) {
            logTS(`TCP connection successful to ${encoderUrl} - encoder is reachable`);
            return true;
          } else {
            logTS(`Cannot establish TCP connection to ${encoderUrl}`);
            // Continue to next retry
          }
        } else {
          // Unknown error
          logTS(`Unknown error connecting to encoder ${encoderUrl}: ${error.message}`);
        }
      }
      
    } catch (error) {
      logTS(`Unexpected error validating encoder ${encoderUrl}: ${error.message}`);
    }
    
    if (attempt < maxRetries) {
      logTS(`Retrying in ${retryDelay}ms...`);
      await delay(retryDelay);
      retryDelay *= 2; // Exponential backoff
    }
  }
  
  logTS(`Failed to validate encoder ${encoderUrl} after ${maxRetries} attempts`);
  return false;
}

/**
 * Enhanced browser crash detection and handling
 */
// Update your createCleanupManager function in main.js:

const createCleanupManager = () => {
  let closingStates = new Map(); // Track closing state per encoder
  let activeBrowsers = new Map(); // Track active browser instances by encoder URL
  let recoveryInProgress = new Map(); // Track recovery operations to prevent duplicates
  let intentionalClose = new Map(); // Track intentional browser closes
  
  process.on('SIGINT', async () => {
    logTS('Caught interrupt signal');
    for (const [encoderUrl] of activeBrowsers) {
      intentionalClose.set(encoderUrl, true); // Mark as intentional
      await closeBrowser(encoderUrl);
    }
    process.exit();
  });
  
  process.on('SIGTERM', async () => {
    logTS('Caught termination signal');
    for (const [encoderUrl] of activeBrowsers) {
      intentionalClose.set(encoderUrl, true); // Mark as intentional
      await closeBrowser(encoderUrl);
    }
    process.exit();
  });

  return {
    cleanup: async (encoderUrl, res) => {
      if (closingStates.get(encoderUrl)) {
        logTS(`Cleanup already in progress for encoder ${encoderUrl}`);
        return;
      }
      
      // Check if recovery is already in progress from the disconnection handler
      if (recoveryInProgress.get(encoderUrl)) {
        logTS(`Recovery already in progress for encoder ${encoderUrl}, skipping cleanup recovery`);
        activeBrowsers.delete(encoderUrl); // Mark as available
        return;
      }
      
      logTS(`Starting cleanup for encoder ${encoderUrl}`);
      closingStates.set(encoderUrl, true);
      recoveryInProgress.set(encoderUrl, true); // Mark recovery as in progress
      intentionalClose.set(encoderUrl, true); // Mark this as an intentional close
      
      try {
        // Close the browser
        await closeBrowser(encoderUrl);
        
        if (res && !res.headersSent) {
          res.status(499).send();
          logTS(`Send http status 499 for encoder ${encoderUrl}`);
        }
      } catch (e) {
        logTS(`Error during cleanup for ${encoderUrl}:`, e);
      } finally {
        await delay(2000); // Original delay
        closingStates.delete(encoderUrl); // Encoder is no longer in a "closing" state
        intentionalClose.delete(encoderUrl); // Clear the intentional close flag

        // Re-initialize the browser in the pool
        const encoderConfig = Constants.ENCODERS.find(e => e.url === encoderUrl);
        if (encoderConfig) {
          logTS(`Attempting to re-initialize browser for ${encoderUrl} in pool after cleanup.`);
          
          // Clear the browser from the map first to ensure launchBrowser doesn't think it exists
          browsers.delete(encoderUrl);
          
          try {
            const repoolSuccess = await launchBrowser("about:blank", encoderConfig, true, false);

            if (repoolSuccess) {
              logTS(`Successfully re-initialized and minimized browser for ${encoderUrl} in pool.`);
              
              // Re-attach crash handlers if browser was successfully created
              if (browsers.has(encoderUrl)) {
                const newBrowser = browsers.get(encoderUrl);
                // Only re-attach handlers if we have the recovery manager
                if (global.recoveryManager) {
                  setupBrowserCrashHandlers(
                    newBrowser,
                    encoderUrl,
                    global.recoveryManager,
                    encoderConfig,
                    browsers,
                    launchBrowser,
                    global.Constants
                  );
                }
              }
              
              activeBrowsers.delete(encoderUrl); // Make encoder available
            } else {
              logTS(`Failed to re-initialize browser for ${encoderUrl} in pool.`);
              // Don't delete from activeBrowsers to prevent reuse of broken encoder
            }
          } catch (error) {
            logTS(`Error re-initializing browser for ${encoderUrl}: ${error.message}`);
            // Don't delete from activeBrowsers to prevent reuse
          }
        } else {
          logTS(`Could not find encoderConfig for ${encoderUrl} to re-initialize browser.`);
        }
        
        recoveryInProgress.delete(encoderUrl); // Clear recovery flag
        logTS(`Cleanup process completed for encoder ${encoderUrl}`);
      }
    },
    canStartBrowser: (encoderUrl) => !closingStates.get(encoderUrl) && !activeBrowsers.has(encoderUrl) && !recoveryInProgress.get(encoderUrl),
    setBrowserActive: (encoderUrl) => { 
      activeBrowsers.set(encoderUrl, true);
      logTS(`Browser set active for encoder ${encoderUrl}`);
    },
    isRecoveryInProgress: (encoderUrl) => recoveryInProgress.get(encoderUrl),
    setRecoveryInProgress: (encoderUrl, value) => {
      if (value) {
        recoveryInProgress.set(encoderUrl, true);
      } else {
        recoveryInProgress.delete(encoderUrl);
      }
    },
    isIntentionalClose: (encoderUrl) => intentionalClose.get(encoderUrl),
    getState: () => ({ 
      closingStates: Array.from(closingStates.entries()),
      activeBrowsers: Array.from(activeBrowsers.keys()),
      recoveryInProgress: Array.from(recoveryInProgress.keys()),
      intentionalClose: Array.from(intentionalClose.keys())
    })
  };
};

// Also update setupBrowserCrashHandlers in error-handling.js to check for intentional closes:

function setupBrowserCrashHandlers(browser, encoderUrl, recoveryManager, encoderConfig, browsers, launchBrowserFunc, Constants) {
  // Monitor for disconnection
  browser.on('disconnected', async () => {
    try {
      logTS(`Browser disconnected for encoder ${encoderUrl}`);

      // Check if this is an intentional close
      if (global.cleanupManager && global.cleanupManager.isIntentionalClose && global.cleanupManager.isIntentionalClose(encoderUrl)) {
        logTS(`Browser disconnection for ${encoderUrl} is intentional (part of cleanup), skipping recovery`);
        return;
      }

      // Check if this is part of an intentional cleanup (check if browser still exists in map)
      if (!browsers.has(encoderUrl)) {
        logTS(`Browser disconnection for ${encoderUrl} appears to be intentional (not in browsers map), skipping recovery`);
        return;
      }

      // Check if cleanup manager is already handling recovery
      if (global.cleanupManager && global.cleanupManager.isRecoveryInProgress && global.cleanupManager.isRecoveryInProgress(encoderUrl)) {
        logTS(`Recovery already being handled by cleanup manager for ${encoderUrl}, skipping disconnection recovery`);
        return;
      }

      logTS(`CRITICAL: Unexpected browser disconnection for encoder ${encoderUrl}, attempting recovery`);
      browsers.delete(encoderUrl);

      // Mark recovery as in progress if cleanup manager is available
      if (global.cleanupManager && global.cleanupManager.setRecoveryInProgress) {
        global.cleanupManager.setRecoveryInProgress(encoderUrl, true);
      }

      // Attempt automatic recovery
      const recovered = await recoveryManager.attemptBrowserRecovery(
        encoderUrl,
        encoderConfig,
        browsers,
        launchBrowserFunc,
        Constants
      );

      if (recovered) {
        logTS(`Successfully recovered browser for ${encoderUrl} after disconnection`);
        // Re-attach handlers to the new browser
        if (browsers.has(encoderUrl)) {
          const newBrowser = browsers.get(encoderUrl);
          setupBrowserCrashHandlers(newBrowser, encoderUrl, recoveryManager, encoderConfig, browsers, launchBrowserFunc, Constants);
        }
      } else {
        logTS(`Failed to recover browser for ${encoderUrl}. Encoder is now offline.`);
      }

      // Clear recovery flag
      if (global.cleanupManager && global.cleanupManager.setRecoveryInProgress) {
        global.cleanupManager.setRecoveryInProgress(encoderUrl, false);
      }
    } catch (error) {
      logTS(`ERROR in browser disconnection handler for ${encoderUrl}: ${error.message}`);
      logTS(`Stack: ${error.stack}`);

      // Clear recovery flag even on error
      if (global.cleanupManager && global.cleanupManager.setRecoveryInProgress) {
        global.cleanupManager.setRecoveryInProgress(encoderUrl, false);
      }

      // Mark encoder as offline
      browsers.delete(encoderUrl);
    }
  });
  
  // Rest of the function remains the same...
  browser.on('targetcreated', async (target) => {
    try {
      if (target.type() === 'page') {
        const page = await target.page().catch(err => {
          logTS(`Could not get page from target for ${encoderUrl}: ${err.message}`);
          return null;
        });
        
        if (page) {
          page.on('error', (error) => {
            logTS(`Page error for ${encoderUrl}: ${error.message}`);
          });
          
          page.on('pageerror', (error) => {
            logTS(`Page JavaScript error for ${encoderUrl}: ${error.message}`);
          });
          
          page.on('crash', async () => {
            try {
              logTS(`Page crashed for ${encoderUrl}`);
              await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
              logTS(`Successfully reloaded crashed page for ${encoderUrl}`);
            } catch (e) {
              logTS(`Failed to reload crashed page for ${encoderUrl}: ${e.message}`);
            }
          });
        }
      } else if (target.type() === 'other' || target.type() === 'webworker' || target.type() === 'service_worker') {
        logTS(`New ${target.type()} target created for ${encoderUrl}`);
      }
    } catch (err) {
      logTS(`Error setting up handlers for target in ${encoderUrl}: ${err.message}`);
    }
  });
  
  browser.on('targetdestroyed', (target) => {
    if (target.type() === 'page') {
      logTS(`Page target destroyed for ${encoderUrl}`);
    }
  });
  
  browser.on('targetchanged', (target) => {
    if (target.type() === 'page') {
      const url = target.url();
      if (url && url !== 'about:blank') {
        logTS(`Page target changed for ${encoderUrl}: ${url.substring(0, 100)}`);
      }
    }
  });
}

/**
 * Enhanced stream monitoring with automatic recovery
 */
class StreamMonitor {
  constructor() {
    this.activeStreams = new Map(); // encoderUrl -> { startTime, lastActivity, errorCount }
    this.monitorInterval = 10000; // Check every 10 seconds
    this.maxInactivity = 60000; // 60 seconds without activity
    this.maxErrorCount = 5;
  }

  startMonitoring(encoderUrl) {
    this.activeStreams.set(encoderUrl, {
      startTime: Date.now(),
      lastActivity: Date.now(),
      errorCount: 0
    });
  }

  updateActivity(encoderUrl) {
    const stream = this.activeStreams.get(encoderUrl);
    if (stream) {
      stream.lastActivity = Date.now();
      stream.errorCount = 0; // Reset error count on successful activity
    }
  }

  recordError(encoderUrl) {
    const stream = this.activeStreams.get(encoderUrl);
    if (stream) {
      stream.errorCount++;
      logTS(`Stream error count for ${encoderUrl}: ${stream.errorCount}`);
    }
  }

  stopMonitoring(encoderUrl) {
    this.activeStreams.delete(encoderUrl);
  }

  async checkStreamHealth() {
    for (const [encoderUrl, stream] of this.activeStreams) {
      const inactivityDuration = Date.now() - stream.lastActivity;
      
      if (inactivityDuration > this.maxInactivity) {
        logTS(`Stream inactive for ${encoderUrl}: ${inactivityDuration}ms`);
        // Trigger recovery or alert
      }
      
      if (stream.errorCount >= this.maxErrorCount) {
        logTS(`Too many errors for stream ${encoderUrl}`);
        // Trigger recovery or alert
      }
    }
  }

  startPeriodicCheck() {
    setInterval(() => this.checkStreamHealth(), this.monitorInterval);
  }
}

/**
 * Enhanced error wrapper for streaming operations
 */
async function safeStreamOperation(operation, encoderUrl, fallbackAction) {
  const maxRetries = 3;
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      logTS(`Stream operation failed for ${encoderUrl} (attempt ${attempt}/${maxRetries}): ${error.message}`);
      
      // Classify error types for appropriate handling
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
        logTS(`Network error detected, attempting reconnection...`);
        await delay(2000 * attempt); // Progressive delay
      } else if (error.message.includes('Navigation timeout')) {
        logTS(`Navigation timeout, may need to increase timeout or check network`);
      } else if (error.message.includes('Target closed')) {
        logTS(`Browser target closed unexpectedly`);
        if (fallbackAction) {
          return await fallbackAction();
        }
      }
      
      if (attempt === maxRetries) {
        throw lastError;
      }
    }
  }
}

/**
 * Enhanced initialization with validation
 * @param {Object} Constants - Constants object from main file
 * @param {EncoderHealthMonitor} healthMonitor - Health monitor instance
 * @param {BrowserRecoveryManager} recoveryManager - Recovery manager instance
 * @param {Function} launchBrowserFunc - Function to launch browser
 * @param {Map} browsers - Map of browsers
 */
async function initializeBrowserPoolWithValidation(Constants, healthMonitor, recoveryManager, launchBrowserFunc, browsers) {
  logTS('Initializing browser pool with validation...');
  const initResults = [];
  
  for (const encoderConfig of Constants.ENCODERS) {
    try {
      // First validate encoder is reachable
      const isReachable = await validateEncoderConnection(encoderConfig.url);
      
      if (!isReachable) {
        logTS(`WARNING: Encoder ${encoderConfig.url} is not reachable. Skipping initialization.`);
        initResults.push({ 
          encoder: encoderConfig.url, 
          success: false, 
          reason: 'Encoder not reachable' 
        });
        continue;
      }
      
      logTS(`Initializing browser for encoder: ${encoderConfig.url}`);
      const success = await launchBrowserFunc("about:blank", encoderConfig, true, false);
      
      if (success && browsers.has(encoderConfig.url)) {
        const browser = browsers.get(encoderConfig.url);
        setupBrowserCrashHandlers(browser, encoderConfig.url, recoveryManager, encoderConfig, browsers, launchBrowserFunc, Constants);
        
        initResults.push({ 
          encoder: encoderConfig.url, 
          success: true 
        });
        logTS(`Successfully initialized browser for encoder: ${encoderConfig.url}`);
      } else {
        initResults.push({ 
          encoder: encoderConfig.url, 
          success: false, 
          reason: 'Browser launch returned false' 
        });
        logTS(`Failed to initialize browser for encoder: ${encoderConfig.url}`);
      }
    } catch (error) {
      logTS(`Error initializing browser for encoder ${encoderConfig.url}: ${error.message}`);
      initResults.push({ 
        encoder: encoderConfig.url, 
        success: false, 
        reason: error.message 
      });
    }
  }
  
  // Report initialization summary
  const successCount = initResults.filter(r => r.success).length;
  const failureCount = initResults.filter(r => !r.success).length;
  
  logTS(`Browser pool initialization complete: ${successCount} succeeded, ${failureCount} failed`);
  
  if (failureCount > 0) {
    logTS('Failed encoders:');
    initResults.filter(r => !r.success).forEach(r => {
      logTS(`  - ${r.encoder}: ${r.reason}`);
    });
  }
  
  return initResults;
}

// Export the new components
module.exports = {
  EncoderHealthMonitor,
  BrowserRecoveryManager,
  StreamMonitor,
  validateEncoderConnection,
  setupBrowserCrashHandlers,
  safeStreamOperation,
  initializeBrowserPoolWithValidation
};