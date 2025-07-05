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
  
  process.on('SIGINT', async () => {
    logTS('Caught interrupt signal');
    for (const [encoderUrl] of activeBrowsers) {
      await closeBrowser(encoderUrl);
    }
    process.exit();
  });
  
  process.on('SIGTERM', async () => {
    logTS('Caught termination signal');
    for (const [encoderUrl] of activeBrowsers) {
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
      
      logTS(`Starting cleanup for encoder ${encoderUrl}`);
      closingStates.set(encoderUrl, true);
      
      try {
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
        // activeBrowsers.delete(encoderUrl); // REMOVED from here: conditional delete below

        // Re-initialize the browser in the pool
        const encoderConfig = Constants.ENCODERS.find(e => e.url === encoderUrl);
        if (encoderConfig) {
          logTS(`Attempting to re-initialize browser for ${encoderUrl} in pool after cleanup.`);
          const repoolSuccess = await launchBrowser("about:blank", encoderConfig, true, false);

          if (repoolSuccess) {
            logTS(`Successfully re-initialized and minimized browser for ${encoderUrl} in pool.`);
            activeBrowsers.delete(encoderUrl); // Make encoder available ONLY on successful re-pool
          } else {
            logTS(`CRITICAL: Failed to re-initialize browser for ${encoderUrl} in pool. Encoder will remain marked as 'active' to prevent reuse.`);
            // By not deleting from activeBrowsers, it remains "in use" and won't be selected by canStartBrowser().
          }
        } else {
          logTS(`Could not find encoderConfig for ${encoderUrl} to re-initialize browser. Encoder slot ${encoderUrl} will remain active.`);
          // Not deleting from activeBrowsers as a precaution if config is missing
        }
        logTS(`Cleanup process completed for encoder ${encoderUrl}`);
      }
    },
    canStartBrowser: (encoderUrl) => !closingStates.get(encoderUrl) && !activeBrowsers.has(encoderUrl),
    setBrowserActive: (encoderUrl) => { 
      activeBrowsers.set(encoderUrl, true);
      logTS(`Browser set active for encoder ${encoderUrl}`);
    },
    getState: () => ({ 
      closingStates: Array.from(closingStates.entries()),
      activeBrowsers: Array.from(activeBrowsers.keys()) 
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
      '--test-type', // To hide "Chrome is being controlled..." infobar
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--allow-running-insecure-content',
      '--autoplay-policy=no-user-gesture-required',
      `--window-position=${encoderConfig.width},${encoderConfig.height}`,
//      '--window-size=1920,1080', // Added fixed window size
      '--new-window', // Ensures a new window for each encoder/stream
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-background-media-suspend',
      '--disable-backgrounding-occluded-windows',
    ];

    if (applyStartFullScreenArg) {
      launchArgs.push('--start-fullscreen');
    }

    // The --window-size logic is intentionally left out/commented as per the revert requirement
    // The --window-size logic based on detectedScreenWidth/Height is removed.
    // Fixed --window-size=1920,1080 is added directly to launchArgs array above.

    // Ensure '--start-minimized' is NOT added to launchArgs (CDP is used for minimization)

    // Add audio configuration if device specified
    if (encoderConfig.audioDevice) {
      logTS(`Configuring audio device: ${encoderConfig.audioDevice}`);
      launchArgs.push(
        '--use-fake-ui-for-media-stream',
        `--audio-output-device=${encoderConfig.audioDevice}`
      );
      logTS(`Added audio configuration flags`);
    }

    // Couldn't find a way to redirect sound for Google so mute it
    if (targetUrl.includes("photos.app.goo.gl")) {
      launchArgs.push('--mute-audio');
      logTS('Mute sound for google photos');
    }

    logTS('Launch arguments:', launchArgs);

    const browser = await puppeteer.launch({
      executablePath: chromePath,
      userDataDir: uniqueUserDataDir,
      headless: false,
      defaultViewport: null,
      args: launchArgs,
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-update',
        '--disable-component-extensions-with-background-pages',
        '--enable-blink-features=IdleDetection',
      ]
    });

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

    const navigationTimeout = 30000;  // 30 seconds timeout for navigation

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
          if (browser && browser.isConnected()) { // Safely attempt to close
            try { await browser.close(); } catch (closeErr) { logTS(`Error closing browser during about:blank nav failure: ${closeErr.message}`); }
          }
          browsers.delete(encoderConfig.url); // Ensure it's removed from the map
          return false; // Specific failure for pooling
        }
        throw error; // Re-throw for non-pooling goto errors to be caught by outer catch
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
          await delay(500); // Add 500ms delay to allow window state to settle
        } catch (cdpError) {
          logTS(`Error minimizing window via CDP for ${encoderConfig.url}:`, cdpError.message);
          // Decide if we should throw here or just log. For now, just log.
        }
      }
      return true; // Successfully launched and set up
    }
    else {
      // This case should ideally not be reached if targetUrl is always expected.
      // If it can be null/undefined for some valid reason not related to pooling, 
      // this might need adjustment. For now, treat as error for pooling.
      logTS(`targetUrl is not defined for encoder ${encoderConfig.url}. This is unexpected.`);
      return false; // Or throw new Error('targetUrl not defined');
    }
  } catch (error) {
    logTS(`Error launching browser for encoder ${encoderConfig.url}:`);
    logTS(error.stack || error.message || error);
    if (browsers.has(encoderConfig.url)) {
      browsers.delete(encoderConfig.url); 
    }
    return false; // General launch failure
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

async function initializeBrowserPool() {
  logTS('Initializing browser pool...');
  for (const encoderConfig of Constants.ENCODERS) {
    try {
      logTS(`Initializing browser for encoder: ${encoderConfig.url}`);
      await launchBrowser("about:blank", encoderConfig, true, false); // Removed screenWidth, screenHeight
      logTS(`Successfully initialized browser for encoder: ${encoderConfig.url}`);
    } catch (error) {
      logTS(`Error initializing browser for encoder ${encoderConfig.url}:`, error.message);
      // Continue to initialize other browsers even if one fails
    }
  }
  logTS('Browser pool initialization complete.');
}

async function main() {
  const app = express()
  app.use(express.urlencoded({ extended: false }));

  // Store the parsed arguments in app.locals
  app.locals.config = Constants;

  // Create a single cleanup manager instance for the application
  // This is done after screen dimensions are detected.
  // app.locals.cleanupManager = createCleanupManager(); // Will be set after screen detection

  chromeDataDir = Constants.CHROME_USERDATA_DIRECTORIES[process.platform].find(existsSync)
  if (!chromeDataDir) {
    console.log('cannot find Chrome User Data Directory')
    return
  }
  chromePath = getExecutablePath()
  if (!chromePath) {
    console.log('cannot find Chrome Executable Directory')
    return
  }

  // Screen dimension detection logic removed.
  // Fallback to default or encoder-specific config for dimensions.
  // The createCleanupManager and initializeBrowserPool will need to be updated
  // if they expect these exact variable names, or be adapted to not require them.
  // For now, we assume they might use defaults or other config sources if these are not passed.
  // This step only removes the detection block. Subsequent steps will adjust consumers.
  //app.locals.cleanupManager = createCleanupManager(); // Will be set after screen detection

  chromeDataDir = Constants.CHROME_USERDATA_DIRECTORIES[process.platform].find(existsSync)
  if (!chromeDataDir) {
    console.log('cannot find Chrome User Data Directory')
    return
  }
  chromePath = getExecutablePath()
  if (!chromePath) {
    console.log('cannot find Chrome Executable Directory')
    return
  }

  // Screen dimension detection logic is removed.

  app.locals.cleanupManager = createCleanupManager();

  // Initialize the browser pool
  try {
    await initializeBrowserPool(); 
  } catch (error) {
    logTS('Catastrophic error during browser pool initialization:', error);
    // Depending on the severity, you might want to exit the process
    // process.exit(1); 
    // For now, just log and continue, as individual errors are handled in initializeBrowserPool
  }

  app.get('/', async (req, res) => {
    res.send(Constants.START_PAGE_HTML.replaceAll('<<host>>', req.get('host')))
  })

  app.use((req, res, next) => {
    logTS(`${req.method} ${req.url}`);
    next(); // Pass control to the next middleware function
  });

  app.get('/stream', async (req, res) => {
    let page;
    let targetUrl;
    
    const cleanupManager = req.app.locals.cleanupManager;
    const config = req.app.locals.config;

    // Get the first available encoder config from the pool
    const availableEncoder = Constants.ENCODERS.find(encoder =>
      browsers.has(encoder.url) && // Ensure it was successfully pooled
      cleanupManager.canStartBrowser(encoder.url) // Checks not closing AND not active
    );
  
    if (!availableEncoder) {
      logTS('No available pooled encoders, rejecting request');
      res.status(503).send('All encoders are currently in use or not initialized');
      return;
    }
  
    targetUrl = getFullUrl(req);
    if (!targetUrl) {
      if (!res.headersSent) {
        res.status(500).send('must specify a target URL');
      }
      return;
    }
    logTS(`streaming to ${targetUrl} using encoder ${availableEncoder.url}`);
  
    cleanupManager.setBrowserActive(availableEncoder.url);
  
    res.on('close', async err => {
      logTS('response stream closed for',availableEncoder.url);
      await cleanupManager.cleanup(availableEncoder.url, res);
    });
  
    res.on('error', async err => {
      logTS('response stream error for', availableEncoder.url, err);
      await cleanupManager.cleanup(availableEncoder.url, res);
    });
  
    try {
      const browser = browsers.get(availableEncoder.url);
      if (!browser) {
        // This should ideally not happen if availableEncoder logic is correct
        logTS(`Error: Browser instance not found for available encoder ${availableEncoder.url}`);
        if (!res.headersSent) {
          res.status(500).send('Internal server error: encoder browser not found');
        }
        await cleanupManager.cleanup(availableEncoder.url, res); // Attempt cleanup
        return;
      }

      const pages = await browser.pages();
      page = pages.length > 0 ? pages[0] : null;

      if (!page) {
        logTS(`Error: No page found for browser ${availableEncoder.url}. Attempting to open a new one.`);
        // Try to open a new page if one doesn't exist (e.g. if it was closed accidentally)
        page = await browser.newPage();
        if (!page) {
           logTS(`Error: Failed to open new page for browser ${availableEncoder.url}`);
           if (!res.headersSent) {
             res.status(500).send('Internal server error: failed to get browser page');
           }
           await cleanupManager.cleanup(availableEncoder.url, res);
           return;
        }
      }
      
      await page.bringToFront();

      try {
        logTS(`Attempting CDP fullscreen for encoder ${availableEncoder.url} before navigation`);
        const session = await page.createCDPSession(); // Use updated method
        const {windowId} = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'fullscreen'}});
        await session.detach();
        logTS(`Successfully set window to fullscreen via CDP for encoder ${availableEncoder.url}`);
      } catch (cdpError) {
        logTS(`Error setting window to fullscreen via CDP for ${availableEncoder.url}: ${cdpError.message}`);
        // Continue execution, as navigation and site-specific fullscreen might still work
      }

      // Navigate the page to the target URL
      if (targetUrl) {
        const navigationTimeout = 30000;
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
        logTS(`Page navigated to ${targetUrl} for encoder ${availableEncoder.url}`);

      } else {
        // This case should ideally be caught by getFullUrl, but as a safeguard:
        logTS('Error: targetUrl is not defined before navigation attempt.');
        if (!res.headersSent) {
          res.status(500).send('Internal server error: target URL not defined.');
        }
        await cleanupManager.cleanup(availableEncoder.url, res);
        return;
      }
  
      if (!cleanupManager.getState().isClosing) {
        const fetchResponse = await fetchWithRetry(availableEncoder.url, { 
          timeout: 30000 // 30 second timeout
        });
        if (!fetchResponse.ok) {
          throw new Error(`Encoder stream HTTP error: ${fetchResponse.status}`);
        }
        if (res && !res.headersSent) {
          const stream = Readable.from(fetchResponse.body);
            
          stream.pipe(res, {
            end: true
          }).on('error', (error) => {
            console.error('Stream error:', error);
            cleanupManager.cleanup(availableEncoder.url, res);
          });
        }
      
        // Setup Browser Audio here (doesn't work for Google photos)
        if (!targetUrl.includes("photos.app.goo.gl")) {
          await setupBrowserAudio(page, availableEncoder);
        }
    
        try {
          // Handle Sling specific page
          if (targetUrl.includes("watch.sling.com")) {
            logTS("Handling Sling video");
            await fullScreenVideoSling(page);
          }
          else if (targetUrl.includes("peacocktv.com")) {  
            await fullScreenVideoPeacock(page);
          }
          else if (targetUrl.includes("spectrum.net")) {  
            await fullScreenVideoSpectrum(page);
          }
          // Handle Google Photo Album specific page
          else if (targetUrl.includes("photos.app.goo.gl")) {
            logTS("Handling Google Photos");
            await fullScreenVideoGooglePhotos(page);
          }
          // default handling for other services
          else {
            logTS("Handling default video");
            await fullScreenVideo(page);
          }
        } catch (e) {
          console.log('failed to go full screen', e);
        }
      }
    } catch (e) {
      console.log('failed to start browser or stream, check encoder ip address: ', targetUrl, e);
      if (!res.headersSent) {
        res.status(500).send(`failed to start browser or stream: ${e}`);
      }
      await cleanupManager.cleanup(availableEncoder.url, res);
      return;
    }
  });

  app.get('/instant', async (_req, res) => {
    res.send(Constants.INSTANT_PAGE_HTML)
  })

  app.post('/instant', async (req, res) => {
    const cleanupManager = req.app.locals.cleanupManager;
    
    // Get the first available encoder config from the pool
    const availableEncoder = Constants.ENCODERS.find(encoder =>
      browsers.has(encoder.url) && // Ensure it was successfully pooled
      cleanupManager.canStartBrowser(encoder.url) // Checks not closing AND not active
    );

    if (!availableEncoder) {
      logTS('No available pooled encoders, rejecting request for /instant');
      res.status(503).send('All encoders are currently in use or not initialized');
      return;
    }
        
    if (req.body.button_record) {
      const recordingStarted = await startRecording(
        req.body.recording_name || 'Manual recording',
        req.body.recording_duration,
        availableEncoder.channel  // Use the encoder's channel
      );
  
      if (!recordingStarted) {
        console.log('failed to start recording');
        res.send('failed to start recording');
        return;
      }
    }

    let page;
    cleanupManager.setBrowserActive(availableEncoder.url);

    try {
      const browser = browsers.get(availableEncoder.url);
      if (!browser) {
        logTS(`Error: Browser instance not found for available encoder ${availableEncoder.url} in /instant`);
        if (!res.headersSent) {
          res.status(500).send('Internal server error: encoder browser not found');
        }
        await cleanupManager.cleanup(availableEncoder.url, res);
        return;
      }

      const pages = await browser.pages();
      page = pages.length > 0 ? pages[0] : null;

      if (!page) {
        logTS(`Error: No page found for browser ${availableEncoder.url} in /instant. Attempting to open a new one.`);
        page = await browser.newPage();
        if (!page) {
            logTS(`Error: Failed to open new page for browser ${availableEncoder.url} in /instant`);
            if (!res.headersSent) {
                res.status(500).send('Internal server error: failed to get browser page');
            }
            await cleanupManager.cleanup(availableEncoder.url, res);
            return;
        }
      }

      await page.bringToFront();

      try {
        logTS(`Attempting CDP fullscreen for encoder ${availableEncoder.url} in /instant before navigation`);
        const session = await page.createCDPSession(); // Use updated method
        const {windowId} = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'fullscreen'}});
        await session.detach();
        logTS(`Successfully set window to fullscreen via CDP for encoder ${availableEncoder.url} in /instant`);
      } catch (cdpError) {
        logTS(`Error setting window to fullscreen via CDP for ${availableEncoder.url} in /instant: ${cdpError.message}`);
        // Continue execution, as navigation and site-specific fullscreen might still work
      }
      
      const targetUrl = req.body.recording_url;
      if (targetUrl) {
        const navigationTimeout = 30000;
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
        logTS(`Page navigated to ${targetUrl} for encoder ${availableEncoder.url} in /instant`);

      } else {
        logTS('Error: recording_url is not defined in /instant.');
        if (!res.headersSent) {
            res.status(400).send('Bad request: recording_url is required.');
        }
        await cleanupManager.cleanup(availableEncoder.url, res);
        return;
      }

    } catch (e) {
      console.log('failed to start browser page, ensure not already running', e);
      if (!res.headersSent) {
        res.status(500).send(`failed to start browser, ensure not already running: ${e}`);
        await cleanupManager.cleanup(availableEncoder.url, res);
      }
      return;
    }

    if (req.body.button_record) {
      res.send(`Started recording on ${availableEncoder.channel}, you can close this page`);
    }
    if (req.body.button_tune) {
      res.send(`Tuned to URL on ${availableEncoder.channel}, you can close this page`);
    }

    try {
      // Setup Browser Audio here (doesn't work for Google photos)
      if (!req.body.recording_url.includes("photos.app.goo.gl")) {
        await setupBrowserAudio(page, availableEncoder);
      }

      // Handle Sling specific page
      if (req.body.recording_url.includes("watch.sling.com")) {  // Changed from req.query.url
        await fullScreenVideoSling(page);
      }
      else if (req.body.recording_url.includes("peacocktv.com")) {  
        await fullScreenVideoPeacock(page);
      }
      else if (req.body.recording_url.includes("spectrum.net")) {  
        await fullScreenVideoSpectrum(page);
      }
      // Handle Google Photo Album specific page
      else if (req.body.recording_url.includes("photos.app.goo.gl")) {  // Changed from req.query.url
        await fullScreenVideoGooglePhotos(page);
      }
      // default handling for page
      else {
        await fullScreenVideo(page);
      }
    } catch (e) {
      console.log('did not find a video selector for: ', req.body.recording_url, e);  // Changed from req.query.url
    }

    // close the browser after the recording period ends
    await new Promise(r => setTimeout(r, req.body.recording_duration * 60 * 1000));
    try {
      await cleanupManager.cleanup(availableEncoder.url, res);  // Pass the encoder url
    } catch (e) {
      console.log('error closing browser after recording', e);
    }
  });

  const server = app.listen(Constants.CH4C_PORT, () => {
    logTS('CH4C listening on port ', Constants.CH4C_PORT)
  })
}

// Only run the main function if this is the main module
if (require.main === module) {
  main().catch(err => {
    console.error('Error starting server:', err);
    process.exit(1);
  });
}

module.exports = { main }; // Export for potential programmatic usage