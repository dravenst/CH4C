const express = require('express');
const puppeteer = require('puppeteer-core');
const { existsSync } = require('fs');
const { Readable } = require('stream');
const { execSync } = require('child_process');
const Constants = require('./constants.js');
const fetch = require('node-fetch');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { exec } = require('child_process');

const {
  EncoderHealthMonitor,
  BrowserRecoveryManager,
  StreamMonitor,
  validateEncoderConnection,
  setupBrowserCrashHandlers,
  safeStreamOperation,
  initializeBrowserPoolWithValidation
} = require('./error-handling');

const { AudioDeviceManager } = require('./audio-device-manager');

let chromeDataDir, chromePath;
let browsers = new Map(); // key: encoderUrl, value: {browser, page}


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// log function with timestamp
function logTS(message , ...args) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}]`, message, ...args);
}

/**
 * Check if a port is already in use
 */
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true); // Port is in use
      } else if (err.code === 'EACCES') {
        resolve(true); // Permission denied, treat as in use
      } else {
        // Log other errors but assume port is free
        logTS(`Port check error: ${err.code}`);
        resolve(false);
      }
    });
    
    server.once('listening', () => {
      // Successfully bound to the port, so it's free
      server.close(() => {
        resolve(false); // Port is free
      });
    });
    
    // Try to bind to all interfaces (0.0.0.0) on the specified port
    server.listen(port, '0.0.0.0', () => {
      // This callback is called when server starts listening
    });
  });
}

/**
 * Alternative port check using netstat
 */
async function isPortInUseNetstat(port) {
  if (process.platform !== 'win32') {
    return false; // Fallback for non-Windows
  }
  
  return new Promise((resolve) => {
    exec(`netstat -an | findstr :${port}`, (error, stdout) => {
      if (error || !stdout) {
        resolve(false); // No output means port not in use
        return;
      }
      
      // Check if port is in LISTENING state
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes(`:${port}`) && (line.includes('LISTENING') || line.includes('ESTABLISHED'))) {
          resolve(true); // Port is in use
          return;
        }
      }
      
      resolve(false); // Port not actively in use
    });
  });
}

/**
 * Find which process is using a port (Windows) - improved version
 */
async function findProcessUsingPort(port) {
  if (process.platform !== 'win32') {
    return null;
  }
  
  return new Promise((resolve) => {
    // Use netstat -anob to get process names directly (requires admin) or -ano (no admin)
    exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      
      // Parse the output to find PID
      const lines = stdout.split('\n');
      for (const line of lines) {
        // Look for lines with our port that are LISTENING
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          
          if (!pid || pid === '0') {
            resolve({ pid: 'System', name: 'System Process' });
            return;
          }
          
          // Get process name from PID using tasklist
          exec(`tasklist /FI "PID eq ${pid}" /FO CSV`, (err, processInfo) => {
            if (!err && processInfo) {
              const lines = processInfo.split('\n');
              if (lines.length > 1) {
                // Parse CSV output
                const dataLine = lines[1];
                const match = dataLine.match(/"([^"]+)"/);
                if (match) {
                  resolve({
                    pid: pid,
                    name: match[1]
                  });
                  return;
                }
              }
            }
            resolve({ pid: pid, name: 'Unknown Process' });
          });
          return;
        }
      }
      resolve(null);
    });
  });
}


/**
 * Check if Chrome processes are actually running with our profiles
 */
async function checkForRunningChromeWithProfiles() {
  if (process.platform !== 'win32') {
    return [];
  }
  
  const runningProfiles = [];
  
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    
    // Use WMIC to find Chrome processes and their command lines
    exec('wmic process where "name=\'chrome.exe\'" get ProcessId,CommandLine /format:csv', (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      
      // Check each encoder profile
      for (let i = 0; i < Constants.ENCODERS.length; i++) {
        const profileDir = path.join(chromeDataDir, `encoder_${i}`);
        const profileDirEscaped = profileDir.replace(/\\/g, '\\\\');
        
        // Check if any Chrome process is using this profile
        if (stdout.includes(profileDir) || stdout.includes(profileDirEscaped)) {
          runningProfiles.push({
            encoder: Constants.ENCODERS[i].url,
            profileDir: profileDir
          });
        }
      }
      
      resolve(runningProfiles);
    });
  });
}

/**
 * Clean up stale lock files if no Chrome is actually using them
 */
async function cleanStaleLocks(profileDir) {
  const lockFiles = ['Singleton', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  let cleaned = false;
  
  for (const lockFile of lockFiles) {
    const lockPath = path.join(profileDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        logTS(`Removed stale lock file: ${lockFile}`);
        cleaned = true;
      } catch (e) {
        // Can't delete - might be in use
      }
    }
  }
  
  return cleaned;
}

/**
 * Test if Chrome can launch with a profile
 */
async function testChromeLaunch(profileDir, chromePath) {
  const puppeteer = require('puppeteer-core');
  
  try {
    logTS(`Testing Chrome launch with profile: ${profileDir}`);
    
    // First, check if there are actual Chrome processes using this profile
    const runningWithProfile = await checkForRunningChromeWithProfiles();
    const isActuallyRunning = runningWithProfile.some(p => p.profileDir === profileDir);
    
    if (isActuallyRunning) {
      return { 
        success: false, 
        reason: 'Chrome process is actively using this profile',
        actuallyRunning: true
      };
    }
    
    // Try to launch
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      userDataDir: profileDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      timeout: 5000
    });
    
    // If we got here, Chrome launched successfully
    await browser.close();
    return { success: true };
    
  } catch (error) {
    // If it failed but no Chrome is actually using it, try cleaning stale locks
    if (error.message.includes('Failed to launch') || error.message.includes('existing browser session')) {
      const runningWithProfile = await checkForRunningChromeWithProfiles();
      const isActuallyRunning = runningWithProfile.some(p => p.profileDir === profileDir);
      
      if (!isActuallyRunning) {
        // No Chrome is actually using it, try to clean stale locks
        logTS(`No Chrome process found using ${profileDir}, cleaning stale locks...`);
        const cleaned = await cleanStaleLocks(profileDir);
        
        if (cleaned) {
          // Try to launch again after cleaning
          try {
            const browser2 = await puppeteer.launch({
              executablePath: chromePath,
              userDataDir: profileDir,
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
              timeout: 5000
            });
            await browser2.close();
            logTS(`Successfully launched after cleaning stale locks`);
            return { success: true };
          } catch (e2) {
            return { 
              success: false, 
              reason: 'Profile appears corrupted or locked',
              actuallyRunning: false
            };
          }
        }
      }
      
      return { 
        success: false, 
        reason: isActuallyRunning ? 'Chrome is using this profile' : 'Profile may be corrupted',
        actuallyRunning: isActuallyRunning
      };
    }
    
    return { 
      success: false, 
      reason: error.message,
      actuallyRunning: false
    };
  }
}

/**
 * Check if the application is running with Administrator privileges
 */
function isRunningAsAdmin() {
  if (process.platform === 'win32') {
    try {
      // Try to run a command that requires admin privileges
      require('child_process').execSync('net session', { stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
  }
  // On non-Windows platforms, check if running as root
  return process.getuid && process.getuid() === 0;
}

async function closeBrowser(encoderUrl) {
  logTS(`Attempting to close browser for encoder ${encoderUrl}`);
  if (browsers.has(encoderUrl)) {
    try {
      const browser = browsers.get(encoderUrl);
      if (browser && browser.isConnected()) {
        await browser.close();
        logTS(`Browser closed for encoder ${encoderUrl}`);
      }
    } catch (e) {
      logTS(`Error closing browser for ${encoderUrl}:`, e);
    } finally {
      browsers.delete(encoderUrl);
    }
  }
}

// Attempts to close browser in a safe fashion
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
                    launchBrowser
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

async function setupBrowserAudio(page, encoderConfig) { 
  logTS("waiting for video to load")  
  
  await page.evaluate(() => {

    // looks for videos in the base document or iframes
    window.checkForVideos = () => {
      const videos = [...document.getElementsByTagName('video')];
      const iframeVideos = [...document.getElementsByTagName('iframe')].reduce((acc, iframe) => {
        try {
          const frameVideos = iframe.contentDocument?.getElementsByTagName('video');
          return frameVideos && frameVideos.length ? [...acc, ...frameVideos] : acc;
        } catch(e) {
          return acc;
        }
      }, []);
      return [...videos, ...iframeVideos];
    };
  });
 
  // calls checkforvideos constantly until either at least one video is ready or the 60s timer expires
  await page.waitForFunction(() => {
    const videos = window.checkForVideos();
    return videos.length > 0 && videos.some(v => v.readyState >= 2);
  }, { timeout: 60000 });
 
  let videoLength = await page.evaluate(() => window.checkForVideos().length);
  logTS(`Found ${videoLength} videos`);
   
  if (encoderConfig.audioDevice) {
    logTS(`Attempting to set audio device: ${encoderConfig.audioDevice}`);
    
    await page.waitForFunction(() => {
      return navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function';
    }, { timeout: 10000 });
 
    logTS("done waiting for browser to find media")
    
    try {
      const deviceSet = await page.evaluate(async (audioDevice) => {
        async function canSetAudio() {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioDevices = devices.filter(d => d.kind === 'audiooutput');
          return audioDevices.some(d => d.label.includes(audioDevice));
        }
      
        async function setAndVerifyAudioDevice() {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const targetDevice = devices
            .filter(d => d.kind === 'audiooutput')
            .find(d => d.label.includes(audioDevice));
          
          if (!targetDevice) {
            console.log("Error no audiooutput devices found!")
            return false;
          } 
 
          const allVideos = window.checkForVideos();
          let success = false;
 
          for (const video of allVideos) {
            if (video.setSinkId) {
              try {
                await video.setSinkId(targetDevice.deviceId);
                if (video.sinkId === targetDevice.deviceId) {
                  success = true;
                }
              } catch (e) {
                console.log('Error setting sink:', e);
              }
            }
          }
          return success;
        }
 
        if (!await canSetAudio()) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (!await canSetAudio()) return false;
        }
 
        let attempts = 0;
        while (attempts < 5) {
          if (await setAndVerifyAudioDevice()) {
            return true;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
          attempts++;
        }
        
        return false;
      }, encoderConfig.audioDevice);
 
      if (deviceSet) {
        logTS(`Successfully configured and verified audio device: ${encoderConfig.audioDevice}`);
      } else {
        logTS(`Failed to set audio device after verification attempts`);
      }
    } catch (error) {
      logTS(`Error in audio device configuration: ${error.message}`, error);
    }
  }
 
  const audioStatus = await page.evaluate(() => {
    const videos = window.checkForVideos();
    return videos.map(v => ({
      readyState: v.readyState,
      sinkId: v.sinkId,
      hasAudio: v.mozHasAudio || Boolean(v.webkitAudioDecodedByteCount) || Boolean(v.audioTracks && v.audioTracks.length)
    }));
  });
 
  logTS('Final audio status:', audioStatus);
}

// setup and launch browser
async function launchBrowser(targetUrl, encoderConfig, startMinimized, applyStartFullScreenArg = true) {
  logTS(`starting browser for encoder ${encoderConfig.url} at position ${encoderConfig.width},${encoderConfig.height}`);
  
  if (browsers.has(encoderConfig.url)) {
    logTS(`Browser already exists for encoder ${encoderConfig.url}`);
    return null;
  }

  try {
    // Create unique user data directory for this encoder
    const encoderIndex = Constants.ENCODERS.findIndex(e => e.url === encoderConfig.url);
    const uniqueUserDataDir = path.join(chromeDataDir, `encoder_${encoderIndex}`);

    // Just ensure the directory exists, don't clean it
    if (!fs.existsSync(uniqueUserDataDir)) {
      fs.mkdirSync(uniqueUserDataDir, { recursive: true });
      logTS(`Created new user data directory: ${uniqueUserDataDir}`);
    }

    logTS(`Using user data directory: ${uniqueUserDataDir}`);

    // Prepare base launch arguments
    const launchArgs = [
      '--no-first-run',
      '--hide-crash-restore-bubble',
      '--test-type',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--allow-running-insecure-content',
      '--autoplay-policy=no-user-gesture-required',
      `--window-position=${encoderConfig.width},${encoderConfig.height}`,
      '--new-window',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-background-media-suspend',
      '--disable-backgrounding-occluded-windows',
    ];

    if (applyStartFullScreenArg) {
      launchArgs.push('--start-fullscreen');
    }

    // Add audio configuration if device specified
    // Validate audio device before adding to launch args
    if (encoderConfig.audioDevice) {
      const audioManager = new AudioDeviceManager();
      const result = await audioManager.validateDevice(encoderConfig.audioDevice);
      
      if (result.valid) {
        launchArgs.push(
          '--use-fake-ui-for-media-stream',
          `--audio-output-device=${result.deviceName}`
        );
      } else {
        logTS(`Warning: Audio device "${encoderConfig.audioDevice}" not found`);
                launchArgs.push(
          '--use-fake-ui-for-media-stream',
          `--audio-output-device=${encoderConfig.audioDevice}`
        );
      }
    }
    // Couldn't find a way to redirect sound for Google so mute it
    if (targetUrl && targetUrl.includes("photos.app.goo.gl")) {
      launchArgs.push('--mute-audio');
      logTS('Mute sound for google photos');
    }

    logTS('Launch arguments:', launchArgs);

    // Add better error handling to the launch
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: chromePath,
        userDataDir: uniqueUserDataDir,
        headless: false,
        defaultViewport: null,
        args: launchArgs,
        timeout: 30000,
        ignoreDefaultArgs: [
          '--enable-automation',
          '--disable-extensions',
          '--disable-default-apps',
          '--disable-component-update',
          '--disable-component-extensions-with-background-pages',
          '--enable-blink-features=IdleDetection',
        ],
        // Add dumpio to see browser console output for debugging
        dumpio: false  // Set to true temporarily to see browser output
      });
    } catch (launchError) {
      logTS(`Browser launch failed with error: ${launchError.message}`);
      
      // Check for specific error conditions
      if (launchError.message.includes('Failed to launch')) {
        logTS('Detailed launch error analysis:');
        
        // Check if Chrome exists
        if (!fs.existsSync(chromePath)) {
          logTS(`ERROR: Chrome not found at ${chromePath}`);
          throw new Error(`Chrome executable not found at: ${chromePath}`);
        } else {
          logTS(`Chrome found at ${chromePath}`);
        }
        
        // Check if we can execute Chrome
        try {
          const { execSync } = require('child_process');
          const version = execSync(`"${chromePath}" --version`, { encoding: 'utf8' });
          logTS(`Chrome version: ${version.trim()}`);
        } catch (e) {
          logTS(`Cannot execute Chrome: ${e.message}`);
        }
        
        // Check user data directory permissions
        try {
          const testFile = path.join(uniqueUserDataDir, 'test.txt');
          fs.writeFileSync(testFile, 'test');
          fs.unlinkSync(testFile);
          logTS('User data directory is writable');
        } catch (e) {
          logTS(`ERROR: Cannot write to user data directory: ${e.message}`);
          throw new Error(`Cannot write to user data directory: ${uniqueUserDataDir}`);
        }
        
        // Check if the issue might be admin-related
        if (process.platform === 'win32') {
          try {
            // Simple check - try to write to Windows directory
            const systemDir = process.env.WINDIR || 'C:\\Windows';
            const testFile = path.join(systemDir, 'ch4c_test.tmp');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            
            // If we got here, we're running as admin
            logTS('ERROR: Running as Administrator detected!');
            throw new Error('Chrome cannot launch properly when running as Administrator. Please run as a regular user.');
          } catch (adminCheckError) {
            // If we can't write to system dir, we're NOT admin (which is good)
            if (!adminCheckError.message.includes('Administrator')) {
              logTS('Not running as Administrator (good)');
            } else {
              throw adminCheckError;
            }
          }
        }
        
        // Check for locked Chrome profile
        const lockFile = path.join(uniqueUserDataDir, 'Singleton');
        if (fs.existsSync(lockFile)) {
          logTS('WARNING: Chrome profile lock file exists. Another Chrome instance may be using this profile.');
          logTS('Attempting to remove lock file...');
          try {
            fs.unlinkSync(lockFile);
            logTS('Lock file removed');
          } catch (e) {
            logTS(`Could not remove lock file: ${e.message}`);
          }
        }
      }
      
      // Re-throw with more context
      throw new Error(`Browser launch failed: ${launchError.message}`);
    }

    // Add error event listener
    browser.on('error', (err) => {
      logTS(`Browser error for encoder ${encoderConfig.url}:`, err);
    });

    if (!browser || !browser.isConnected()) {
      throw new Error('Browser failed to launch or is not connected');
    }

    browsers.set(encoderConfig.url, browser);
    let page;
    const pages = await browser.pages();
    if (pages && pages.length > 0) {
      logTS(`Using existing page for encoder ${encoderConfig.url}`);
      page = pages[0];
    } else {
      logTS(`No existing page found, creating new page for encoder ${encoderConfig.url}`);
      page = await browser.newPage();
    }

    logTS(`loading page for encoder ${encoderConfig.url}`);

    const navigationTimeout = 30000;

    // Position window before navigating
    await page.evaluate((width, height) => {
      window.moveTo(width, height);
    }, encoderConfig.width, encoderConfig.height);
    await delay(1000);

    // Navigate the page
    if (targetUrl) {
      try {
        if (targetUrl === "about:blank") {
          await page.goto(targetUrl, { waitUntil: 'load', timeout: 5000 });
        } else {
          // Existing navigation logic for actual content URLs
          if ((targetUrl.includes("watch.sling.com")) || (targetUrl.includes("photos.app.goo.gl"))) {
            await page.goto(targetUrl, {
              waitUntil: 'load',
              timeout: 30000
            });
          } else {
            await Promise.race([
              page.goto(targetUrl, { 
                waitUntil: 'networkidle2',
                timeout: navigationTimeout 
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Navigation timeout')), navigationTimeout)
              )
            ]);
          }
        }
      } catch (error) {
        if (targetUrl === "about:blank") {
          logTS(`Error navigating to about:blank for pooling ${encoderConfig.url}: ${error.message}`);
          if (browser && browser.isConnected()) {
            try { 
              await browser.close(); 
            } catch (closeErr) { 
              logTS(`Error closing browser during about:blank nav failure: ${closeErr.message}`); 
            }
          }
          browsers.delete(encoderConfig.url);
          return false;
        }
        throw error;
      }

      logTS(`page fully loaded for encoder ${encoderConfig.url}`);

      if (startMinimized) {
        logTS(`Attempting CDP minimization for encoder ${encoderConfig.url}`);
        try {
          const session = await page.createCDPSession();
          const {windowId} = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'minimized'}});
          await session.detach();
          logTS(`Successfully minimized window via CDP for encoder ${encoderConfig.url}`);
          await delay(500);
        } catch (cdpError) {
          logTS(`Error minimizing window via CDP for ${encoderConfig.url}:`, cdpError.message);
        }
      }
      return true;
    } else {
      logTS(`targetUrl is not defined for encoder ${encoderConfig.url}. This is unexpected.`);
      return false;
    }
  } catch (error) {
    logTS(`Error launching browser for encoder ${encoderConfig.url}:`);
    logTS(`Error type: ${error.constructor.name}`);
    logTS(`Error message: ${error.message}`);
    if (error.stack) {
      logTS(`Stack trace:\n${error.stack}`);
    }
    
    // Clean up any partial browser instance
    if (browsers.has(encoderConfig.url)) {
      const browser = browsers.get(encoderConfig.url);
      if (browser && browser.isConnected()) {
        try {
          await browser.close();
        } catch (closeErr) {
          logTS(`Error closing failed browser: ${closeErr.message}`);
        }
      }
      browsers.delete(encoderConfig.url); 
    }
    return false;
  }
}

async function hideCursor(page) {
  try {
    await Promise.race([
      frame.addStyleTag({
        content: `
          *:hover{cursor:none!important} 
          *{cursor:none!important}
        `
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout adding style tag')), 1000)) 
    ]);

    // NFL Network requires mouse wiggle to hide cursor
    const mouse = page.mouse
    await mouse.move(Math.floor(Math.random() * 101) + 300, 500);

  } catch (error) {
    // Sometimes it times out for the cursor hiding
    //console.log('timeout adding style tag');
  }
}

async function GetProperty(element, property) {
  return await (await element.getProperty(property)).jsonValue();
}

async function fullScreenVideo(page) {
  let frameHandle, videoHandle

  // try every few seconds to look for the video
  // necessary since some pages take time to load the actual video
  videoSearch: for (let step = 0; step < Constants.FIND_VIDEO_RETRIES; step++) {
    // call this every loop since the page might be changing
    // e.g. during the "authorized to view with Xfinity" splash screen
    try {
      const frames = await page.frames( { timeout: 1000 })
      for (const frame of frames) {
        try {
          videoHandle = await frame.waitForSelector('video', { timeout: 1000 });
        } catch (error) {
        }
        if (videoHandle) {
          frameHandle = frame;
          logTS('found video frame')
          break videoSearch
        }
      }
    } catch (error) {
      console.log('error looking for video', error)
      videoHandle=null
    }
    // Don't think this timeout is necessary?
    //await new Promise(r => setTimeout(r, Constants.FIND_VIDEO_WAIT * 1000));
  }

  if (videoHandle) {
    // confirm video is actually playing
    for (let step = 0; step < Constants.PLAY_VIDEO_RETRIES; step++) {
      const currentTime = await GetProperty(videoHandle, 'currentTime')
      const readyState = await GetProperty(videoHandle, 'readyState')
      const paused = await GetProperty(videoHandle, 'paused')
      const ended = await GetProperty(videoHandle, 'ended')

      if (!!(currentTime > 0 && readyState > 2 && !paused && !ended)) break
      logTS("calling play/click");
      // alternate between calling play and click (Disney)
      if (step % 2 === 0) {
        await frameHandle.evaluate((video) => {
          video.play()
        }, videoHandle)
      } else {
        await videoHandle.click()
      }
      // not sure we need this?
      // await new Promise(r => setTimeout(r, Constants.PLAY_VIDEO_WAIT * 1000))
    }

    // redundant with last one?
    //await hideCursor(page)

    logTS("going full screen and unmuting");
    await frameHandle.evaluate((video) => {
      video.muted = false
      video.removeAttribute('muted')
      video.style.cursor = 'none!important'
      video.requestFullscreen()
    }, videoHandle)

    // Don't think this is needed?
    //await new Promise(r => setTimeout(r, Constants.FULL_SCREEN_WAIT * 1000))
  } else {
    console.log('did not find video')
  }
  logTS("hiding cursor");
  // some sites respond better to hiding cursor after full screen
  await hideCursor(page)
}

async function fullScreenVideoSling(page) {
  logTS("URL contains watch.sling.com, going fullscreen");

  // Click the full screen button
  const fullScreenButton = await page.waitForSelector('div.player-button.active.videoPlayerFullScreenToggle', { visible: true });
  logTS("button available, now clicking");
  await fullScreenButton.click(); //click for fullscreen

  // Find Mute button and then use volume slider
  const muteButton = await page.waitForSelector('div.player-button.active.volumeControls', { visible: true });
  await muteButton.click(); //click unmute
  // Simulate pressing the right arrow key 10 times to max volume
  for (let i = 0; i < 10; i++) {
    await delay(100);
    await page.keyboard.press('ArrowRight');
  }
  logTS("finished change to fullscreen and max volume");
}

async function fullScreenVideoPeacock(page) {
  logTS("URL contains peacocktv.com, going fullscreen");

  // look for the mute button no the first screen
  await page.waitForSelector('[data-testid="playback-volume-muted-icon"]', { visible: true });
  await delay(200);
  await page.keyboard.press('m'); // Press 'm' to unmute

  logTS("finished unmuting volume");
}

async function fullScreenVideoSpectrum(page) {
  logTS("URL contains spectrum.net, going fullscreen");

  await delay(1030);
  await page.evaluate(() => {
    const element = document.documentElement;
    if (element.requestFullscreen) {
      element.requestFullscreen();
    } else if (element.mozRequestFullScreen) {
      element.mozRequestFullScreen();
    } else if (element.webkitRequestFullscreen) {
      element.webkitRequestFullscreen();
    } else if (element.msRequestFullscreen) {
      element.msRequestFullscreen();
    }
  });

  logTS("finished change to fullscreen");
}

async function fullScreenVideoGooglePhotos(page) {
  logTS("URL contains Google Photos");

  // Simulate pressing the tab key key 10 times to get to the More Options button
  for (let i = 0; i < 8; i++) {
    await delay(200);
    await page.keyboard.press('Tab');
  }   

  // Press Enter twice to start Slideshow
  await page.keyboard.press('Enter');
  await delay(200);
  await page.keyboard.press('Enter');

  logTS("changed to fullscreen and max volume");
}


function isValidLinuxPath(path) {
  try {
    return execSync(path)
  } catch (e) {
    return false
  }
}

function getExecutablePath() {
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN
  }

  if (process.platform === 'linux') {
    const validPath = Constants.CHROME_EXECUTABLE_DIRECTORIES[process.platform].find(isValidLinuxPath)
    if (validPath) {
      return execSync(validPath).toString().split('\n').shift()
    } else {
      return null
    }
  } else {
    return Constants.CHROME_EXECUTABLE_DIRECTORIES[process.platform].find(existsSync)
  }
}

function buildRecordingJson(name, duration, encoderChannel) {
  const startTime = Math.round(Date.now() / 1000)
  const data = {
    "Name": name,
    "Time": startTime,
    "Duration": duration * 60,
    "Channels": [encoderChannel],  // Use the specific encoder's channel
    "Airing": {
      "Source": "manual",
      "Channel": encoderChannel,  // Use the specific encoder's channel
      "Time": startTime,
      "Duration": duration * 60,
      "Title": `Title: ${name}`,
      "EpisodeTitle": name,
      "Summary": `Manual recording: ${name}`,
      "SeriesID": "MANUAL",
      "ProgramID": `MAN${startTime}`,
    }
  }
  return JSON.stringify(data)
}

async function startRecording(name, duration, encoderChannel) {
  let response
  try {
    response = await fetch(Constants.CHANNELS_POST_URL, {
      method: 'POST',
      headers: {
        'Content-type': 'application/json',
      },
      body: buildRecordingJson(name, duration, encoderChannel),
    })
  } catch (error) {
    console.log('Unable to schedule recording', error)
  } finally {
    return response.ok
  }
}

// returns updated url with all paramas in a string
function getFullUrl (req) {
  if (!req || !req.query || !req.query.url) {
    console.log('must specify a target URL')
    return null
  }
  //Create URL object to validate and format the URL
  const urlObj = new URL(req.query.url);
  
  // Add any additional query parameters
  Object.entries(req.query).forEach(([key, value]) => {
    if (key !== 'url') {
      urlObj.searchParams.append(key, value);
    }
  });
  
  // Get the fully formatted URL
  return urlObj.toString();
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error.code === 'ECONNRESET' && retries < maxRetries - 1) {
        const delay = Math.pow(2, retries) * 1000; // Exponential backoff
        logTS(`Connection reset, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
}

// Modified main() function with enhanced error handling
async function main() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  // Check for admin mode FIRST, before any other initialization
  if (isRunningAsAdmin()) {
    const errorMsg = `
╔══════════════════════════════════════════════════════════════════════╗
║                    ⚠️  ADMINISTRATOR MODE DETECTED ⚠️                  ║
╠══════════════════════════════════════════════════════════════════════╣
║ CH4C is running with Administrator privileges.                       ║
║ This will cause Chrome browser launch to fail.                       ║
║                                                                       ║
║ Please restart CH4C as a regular user (not as Administrator).       ║
╚══════════════════════════════════════════════════════════════════════╝
`;
    console.error(errorMsg);
    logTS('Exiting due to Administrator mode...');
    process.exit(1);
  }

  // Initialize error handling systems
  const healthMonitor = new EncoderHealthMonitor();
  const recoveryManager = new BrowserRecoveryManager();
  const streamMonitor = new StreamMonitor();

  // Store in app locals for access in routes
  app.locals.config = Constants;
  app.locals.healthMonitor = healthMonitor;
  app.locals.recoveryManager = recoveryManager;
  app.locals.streamMonitor = streamMonitor;

  // Chrome setup (existing code)
  chromeDataDir = Constants.CHROME_USERDATA_DIRECTORIES[process.platform].find(existsSync);
  if (!chromeDataDir) {
    console.log('cannot find Chrome User Data Directory');
    return;
  }
  chromePath = getExecutablePath();
  if (!chromePath) {
    console.log('cannot find Chrome Executable Directory');
    return;
  }

   // CHECK 1: Check if the port is already in use - try both methods
  logTS(`Checking if port ${Constants.CH4C_PORT} is available...`);
  
  // Try socket-based check first
  let portInUse = await isPortInUse(Constants.CH4C_PORT);
  
  // Double-check with netstat on Windows
  if (!portInUse && process.platform === 'win32') {
    portInUse = await isPortInUseNetstat(Constants.CH4C_PORT);
  }
  
  if (portInUse) {
    const processInfo = await findProcessUsingPort(Constants.CH4C_PORT);
    
    console.error(`
╔══════════════════════════════════════════════════════════════════════╗
║                    ⚠️  PORT ALREADY IN USE ⚠️                         ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                       ║
║  Port ${String(Constants.CH4C_PORT).padEnd(5)} is already being used by another process.          ║
${processInfo ? 
`║  Process: ${processInfo.name.padEnd(59)} ║
║  PID: ${processInfo.pid.padEnd(64)} ║` : 
`║  Could not determine which process is using the port.                ║`}
║                                                                       ║
║  This usually means CH4C is already running.                         ║
║                                                                       ║
║  SOLUTIONS:                                                          ║
║  1. Stop the other CH4C instance                                    ║
║  2. Use a different port with -c option (e.g., -c 2443)            ║
${processInfo && processInfo.pid !== 'Unknown' ? 
`║  3. Force stop: taskkill /F /PID ${processInfo.pid.padEnd(36)} ║` : 
`║  3. Check Task Manager for Node.js or CH4C processes               ║`}
║                                                                       ║
╚══════════════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  // CHECK 2: Check for actually running Chrome processes first
  logTS('Checking for Chrome processes using encoder profiles...');
  const runningProfiles = await checkForRunningChromeWithProfiles();

  if (runningProfiles.length > 0) {
    console.error(`
╔══════════════════════════════════════════════════════════════════════╗
║           ⚠️  CHROME IS USING ENCODER PROFILES ⚠️                     ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                       ║
║  Active Chrome processes are using these encoder profiles:           ║`);
    
    runningProfiles.forEach((profile, index) => {
      console.error(`║  ${(index + 1)}. ${profile.encoder.padEnd(63)} ║`);
    });
    
    console.error(`║                                                                       ║
║  SOLUTIONS:                                                          ║
║  1. Close all Chrome windows                                        ║
║  2. Force close Chrome: taskkill /F /IM chrome.exe                  ║
║  3. Check Task Manager for chrome.exe processes                     ║
║                                                                       ║
╚══════════════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  // CHECK 3: Test if Chrome profiles are actually available
  logTS('Testing Chrome profile availability...');
  const profileProblems = [];
  const staleProfiles = [];
  
  for (let i = 0; i < Constants.ENCODERS.length; i++) {
    const encoder = Constants.ENCODERS[i];
    const profileDir = path.join(chromeDataDir, `encoder_${i}`);
    
    // First, ensure the directory exists
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
      logTS(`Created profile directory: ${profileDir}`);
    }
    
    // Test if we can actually launch Chrome with this profile
    const testResult = await testChromeLaunch(profileDir, chromePath);
    if (!testResult.success) {
      if (testResult.actuallyRunning) {
        profileProblems.push({
          encoder: encoder.url,
          profileDir,
          reason: testResult.reason
        });
      } else {
        // Just stale locks or corruption, we already tried to clean
        staleProfiles.push({
          encoder: encoder.url,
          profileDir,
          reason: testResult.reason
        });
      }
    } else {
      logTS(`✓ Profile available for ${encoder.url}`);
    }
  }
  
  // Only show error if there are real problems (actual Chrome processes)
  if (profileProblems.length > 0) {
    console.error(`
╔══════════════════════════════════════════════════════════════════════╗
║              ⚠️  CHROME PROFILES IN USE ⚠️                            ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                       ║
║  Chrome is actively using these encoder profiles:                    ║`);
    
    profileProblems.forEach((issue, index) => {
      console.error(`║  ${(index + 1)}. ${issue.encoder.padEnd(63)} ║`);
    });
    
    console.error(`║                                                                       ║
║  Please close Chrome and try again.                                 ║
║                                                                       ║
╚══════════════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }
  
  // For stale profiles, just log a warning but continue
  if (staleProfiles.length > 0) {
    logTS('Note: Some profiles had stale locks that were cleaned automatically.');
    staleProfiles.forEach(profile => {
      logTS(`  - ${profile.encoder}: ${profile.reason}`);
    });
  }

  logTS('Port and Chrome profiles are available. Starting CH4C...');

  const cleanupManager = createCleanupManager();
  app.locals.cleanupManager = cleanupManager;
  
  global.cleanupManager = cleanupManager;
  global.recoveryManager = recoveryManager;
  global.setupBrowserCrashHandlers = setupBrowserCrashHandlers;

  // Start health monitoring
  await healthMonitor.startMonitoring(Constants.ENCODERS);
  streamMonitor.startPeriodicCheck();

  // Initialize browser pool with validation
  const initResults = await initializeBrowserPoolWithValidation(
  Constants,        // Add Constants parameter
  healthMonitor, 
  recoveryManager,
  launchBrowser,    // Add launchBrowser function parameter
  browsers          // Add browsers Map parameter
  );

  // Check if we have at least one working encoder
  const workingEncoders = initResults.filter(r => r.success);
  if (workingEncoders.length === 0) {
    logTS('FATAL: No encoders could be initialized. Exiting.');
    process.exit(1);
  }

  app.get('/', async (req, res) => {
    res.send(Constants.START_PAGE_HTML.replaceAll('<<host>>', req.get('host')))
  });

  // Modified /stream endpoint with enhanced error handling
  app.get('/stream', async (req, res) => {
    let page;
    let targetUrl;
    
    const cleanupManager = req.app.locals.cleanupManager;
    const healthMonitor = req.app.locals.healthMonitor;
    const streamMonitor = req.app.locals.streamMonitor;
    const recoveryManager = req.app.locals.recoveryManager;

    // Get the first available AND healthy encoder
    const availableEncoder = Constants.ENCODERS.find(encoder =>
      browsers.has(encoder.url) &&
      cleanupManager.canStartBrowser(encoder.url) &&
      healthMonitor.isEncoderHealthy(encoder.url) // Added health check
    );

    if (!availableEncoder) {
      // Try to find any encoder that might be recoverable
      const recoverableEncoder = Constants.ENCODERS.find(encoder =>
        !healthMonitor.isEncoderHealthy(encoder.url) &&
        cleanupManager.canStartBrowser(encoder.url)
      );

      if (recoverableEncoder) {
        logTS(`Attempting to recover encoder ${recoverableEncoder.url} for use`);
        const recovered = await recoveryManager.attemptBrowserRecovery(
          recoverableEncoder.url,
          recoverableEncoder,
          browsers,
          launchBrowser  // Add launchBrowser parameter
        );
        
        if (recovered) {
          logTS(`Successfully recovered encoder ${recoverableEncoder.url}`);
          // Retry with recovered encoder
          return app._router.handle(req, res);
        }
      }

      logTS('No available or recoverable encoders, rejecting request');
      res.status(503).send('All encoders are currently unavailable');
      return;
    }

    targetUrl = getFullUrl(req);
    if (!targetUrl) {
      if (!res.headersSent) {
        res.status(400).send('must specify a target URL');
      }
      return;
    }

    logTS(`streaming to ${targetUrl} using encoder ${availableEncoder.url}`);
    cleanupManager.setBrowserActive(availableEncoder.url);
    streamMonitor.startMonitoring(availableEncoder.url);

    // Enhanced cleanup on stream close
    res.on('close', async err => {
      logTS('response stream closed for', availableEncoder.url);
      streamMonitor.stopMonitoring(availableEncoder.url);
      await cleanupManager.cleanup(availableEncoder.url, res);
    });

    res.on('error', async err => {
      logTS('response stream error for', availableEncoder.url, err);
      streamMonitor.recordError(availableEncoder.url);
      streamMonitor.stopMonitoring(availableEncoder.url);
      await cleanupManager.cleanup(availableEncoder.url, res);
    });

    try {
      // Wrap browser operations in safe error handling
      await safeStreamOperation(async () => {
        const browser = browsers.get(availableEncoder.url);
        if (!browser || !browser.isConnected()) {
          throw new Error('Browser not connected');
        }

        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();

        if (!page) {
          throw new Error('Failed to get browser page');
        }

        await page.bringToFront();

        // Set fullscreen with error handling
        try {
          const session = await page.createCDPSession();
          const {windowId} = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'fullscreen'}});
          await session.detach();
        } catch (cdpError) {
          logTS(`CDP fullscreen error (non-fatal): ${cdpError.message}`);
        }

        // Navigate with timeout and retry logic
        const navigationTimeout = 30000;
        const maxNavRetries = 2;
        let navSuccess = false;

        for (let navAttempt = 1; navAttempt <= maxNavRetries && !navSuccess; navAttempt++) {
          try {
            if (targetUrl.includes("watch.sling.com") || targetUrl.includes("photos.app.goo.gl")) {
              await page.goto(targetUrl, {
                waitUntil: 'load',
                timeout: navigationTimeout
              });
            } else {
              await page.goto(targetUrl, {
                waitUntil: 'networkidle2',
                timeout: navigationTimeout
              });
            }
            navSuccess = true;
            logTS(`Page navigated successfully to ${targetUrl}`);
          } catch (navError) {
            logTS(`Navigation attempt ${navAttempt} failed: ${navError.message}`);
            if (navAttempt < maxNavRetries) {
              await delay(3000);
            } else {
              throw navError;
            }
          }
        }

        // Stream setup with connection validation
        if (!cleanupManager.getState().isClosing) {
          // Validate encoder connection before streaming
          const isValid = await validateEncoderConnection(availableEncoder.url, 2, 1000);
          if (!isValid) {
            throw new Error('Encoder connection validation failed');
          }

          const fetchResponse = await fetchWithRetry(availableEncoder.url, {
            timeout: 30000
          });

          if (!fetchResponse.ok) {
            throw new Error(`Encoder stream HTTP error: ${fetchResponse.status}`);
          }

          if (res && !res.headersSent) {
            const stream = Readable.from(fetchResponse.body);
            
            // Monitor stream for activity
            stream.on('data', () => {
              streamMonitor.updateActivity(availableEncoder.url);
            });

            stream.pipe(res, { end: true })
              .on('error', (error) => {
                logTS(`Stream pipe error: ${error.message}`);
                streamMonitor.recordError(availableEncoder.url);
                cleanupManager.cleanup(availableEncoder.url, res);
              });
          }

          // Setup audio and fullscreen (existing code)
          if (!targetUrl.includes("photos.app.goo.gl")) {
            await setupBrowserAudio(page, availableEncoder);
          }

          // Handle site-specific fullscreen
          await handleSiteSpecificFullscreen(targetUrl, page);
        }
      }, availableEncoder.url, async () => {
        // Fallback action - attempt recovery
        logTS(`Attempting recovery for ${availableEncoder.url}`);
        const recovered = await recoveryManager.attemptBrowserRecovery(
          availableEncoder.url,
          availableEncoder,
          browsers,
          launchBrowser  // Add launchBrowser parameter
        );
        if (!recovered) {
          throw new Error('Recovery failed');
        }
      });

    } catch (error) {
      logTS(`Stream setup failed for ${availableEncoder.url}: ${error.message}`);
      streamMonitor.stopMonitoring(availableEncoder.url);
      
      if (!res.headersSent) {
        res.status(500).send(`Streaming error: ${error.message}`);
      }
      
      await cleanupManager.cleanup(availableEncoder.url, res);
    }
  });

  // Add health status endpoint
  app.get('/health', (req, res) => {
    const healthMonitor = req.app.locals.healthMonitor;
    const cleanupManager = req.app.locals.cleanupManager;
    const streamMonitor = req.app.locals.streamMonitor;

    const status = {
      encoders: Constants.ENCODERS.map(encoder => ({
        url: encoder.url,
        channel: encoder.channel,
        isHealthy: healthMonitor.isEncoderHealthy(encoder.url),
        hasBrowser: browsers.has(encoder.url),
        isAvailable: cleanupManager.canStartBrowser(encoder.url),
        healthStatus: healthMonitor.healthStatus.get(encoder.url)
      })),
      activeStreams: Array.from(streamMonitor.activeStreams.entries()).map(([url, data]) => ({
        url,
        ...data,
        uptime: Date.now() - data.startTime
      })),
      cleanupState: cleanupManager.getState()
    };

    res.json(status);
  });

  app.get('/audio-devices', async (req, res) => {
    const audioManager = new AudioDeviceManager();
    const devices = await audioManager.getAudioDevices();
    res.json(devices);
  });

  // Existing endpoints (/, /instant) remain the same but with similar error handling additions

  const server = app.listen(Constants.CH4C_PORT, () => {
    logTS('CH4C listening on port', Constants.CH4C_PORT);
    logTS(`Health status available at http://localhost:${Constants.CH4C_PORT}/health`);
    logTS(`Audio Device list available at http://localhost:${Constants.CH4C_PORT}/audio-devices`);
  });

  // Handle server startup errors
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n❌ ERROR: Port ${Constants.CH4C_PORT} is already in use.`);
      console.error('Another instance of CH4C may already be running.\n');
    } else {
      console.error(`\n❌ ERROR: Failed to start server: ${error.message}\n`);
    }
    process.exit(1);
  });

  // Graceful shutdown with cleanup
  process.on('SIGINT', async () => {
    logTS('Shutting down gracefully...');
    
    // Stop monitoring
    healthMonitor.healthStatus.clear();
    streamMonitor.activeStreams.clear();
    
    // Close all browsers
    for (const [encoderUrl, browser] of browsers) {
      try {
        if (browser && browser.isConnected()) {
          await browser.close();
        }
      } catch (e) {
        logTS(`Error closing browser during shutdown: ${e.message}`);
      }
    }
    
    server.close(() => {
      logTS('Server closed');
      process.exit(0);
    });
  });
}

// Helper function to consolidate site-specific fullscreen logic
async function handleSiteSpecificFullscreen(targetUrl, page) {
  try {
    if (targetUrl.includes("watch.sling.com")) {
      logTS("Handling Sling video");
      await fullScreenVideoSling(page);
    } else if (targetUrl.includes("peacocktv.com")) {
      await fullScreenVideoPeacock(page);
    } else if (targetUrl.includes("spectrum.net")) {
      await fullScreenVideoSpectrum(page);
    } else if (targetUrl.includes("photos.app.goo.gl")) {
      logTS("Handling Google Photos");
      await fullScreenVideoGooglePhotos(page);
    } else {
      logTS("Handling default video");
      await fullScreenVideo(page);
    }
  } catch (e) {
    logTS(`Fullscreen setup failed (non-fatal): ${e.message}`);
    // Don't throw - fullscreen failure shouldn't stop the stream
  }
}

// Only run the main function if this is the main module
if (require.main === module) {
  main().catch(err => {
    console.error('Error starting server:', err);
    process.exit(1);
  });
}

module.exports = { main }; // Export for potential programmatic usage