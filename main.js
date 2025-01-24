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
        await delay(2000);
        closingStates.delete(encoderUrl);
        activeBrowsers.delete(encoderUrl);
        logTS(`Cleanup completed for encoder ${encoderUrl}`);
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

// use the specified audio source for each encoder
async function setupBrowserAudio(page, encoderConfig) { 
  // Wait for video elements to be present and ready
  await page.waitForFunction(() => {
    const videos = document.getElementsByTagName('video');
    return videos.length > 0 && Array.from(videos).some(v => v.readyState >= 2);
  }, { timeout: 60000 });  // set to 60s to allow time to enter web credentials if needed

  // If we have an audio device specified, try to set it after page load
  if (encoderConfig.audioDevice) {
    logTS(`Attempting to set audio device: ${encoderConfig.audioDevice}`);
    
    // Wait for browser to recognize audio devices
    await page.waitForFunction(() => {
      return navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function';
    }, { timeout: 10000 });

    try {
      const deviceSet = await page.evaluate(async (deviceName) => {
        // Function to check if audio can be set
        async function canSetAudio() {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioDevices = devices.filter(d => d.kind === 'audiooutput');
          return audioDevices.some(d => d.label.includes(deviceName));
        }

        // Function to set audio device with verification
        async function setAndVerifyAudioDevice() {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const targetDevice = devices
            .filter(d => d.kind === 'audiooutput')
            .find(d => d.label.includes(deviceName));
          
          if (!targetDevice) {
            console.log("Error no audiooutput devices found!")
            return false;
          } 

          const videos = document.getElementsByTagName('video');
          let success = false;

          for (const video of videos) {
            if (video.setSinkId) {
              try {
                await video.setSinkId(targetDevice.deviceId);
                // Verify the setting took effect
                const currentSinkId = video.sinkId;
                if (currentSinkId === targetDevice.deviceId) {
                  success = true;
                }
              } catch (e) {
                console.log('Error setting sink:', e);
              }
            }
          }
          return success;
        }

        // Initial check for audio capability
        if (!await canSetAudio()) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (!await canSetAudio()) return false;
        }

        // Attempt to set audio with verification
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
      logTS(`Error in audio device configuration: ${error.message}`);
    }
  }

  // Additional verification after setup
  const audioStatus = await page.evaluate(() => {
    const videos = document.getElementsByTagName('video');
    return Array.from(videos).map(v => ({
      readyState: v.readyState,
      sinkId: v.sinkId,
      hasAudio: v.mozHasAudio || Boolean(v.webkitAudioDecodedByteCount) || Boolean(v.audioTracks && v.audioTracks.length)
    }));
  });

  logTS('Final audio status:', audioStatus);
};

// setup and launch browser
async function launchBrowser(targetUrl, encoderConfig) {
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
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-session-crashed-bubble',
      '--noerrdialogs',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--start-fullscreen',  // full screen browser
      '--allow-running-insecure-content',
      '--autoplay-policy=no-user-gesture-required',
      `--window-position=${encoderConfig.width},${encoderConfig.height}`,
      '--new-window', // new browser window for each encoder
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-background-media-suspend',
      '--disable-backgrounding-occluded-windows',
//      '--enable-hardware-overlays=single-fullscreen,single-video',
//      '--disable-features=UseOzonePlatform',
    ];

    // Add audio configuration if device specified
    if (encoderConfig.audioDevice) {
      logTS(`Configuring audio device: ${encoderConfig.audioDevice}`);
      launchArgs.push(
        '--use-fake-ui-for-media-stream',
        `--audio-output-device=${encoderConfig.audioDevice}`,  // doesn't do anything
      );
      logTS(`Added audio configuration flags`);
    }

    // Couldn't find a way to redirect sound for Google so mute it
    if (targetUrl.includes("photos.app.goo.gl")) {
      launchArgs.push(
        '--mute-audio',
      );
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
    const page = await browser.newPage();

    logTS(`loading page for encoder ${encoderConfig.url}`);

    const navigationTimeout = 30000;  // 30 seconds timeout for navigation

    // Position window before navigating
    await page.evaluate((width, height) => {
      window.moveTo(width, height);
    }, encoderConfig.width, encoderConfig.height);
    await delay(1000);

    if (targetUrl) {
      if ((targetUrl.includes("watch.sling.com")) || (targetUrl.includes("photos.app.goo.gl"))) {
        // First wait for initial page load
        await page.goto(targetUrl, {
          waitUntil: 'load', // Wait for page elements to load only
          timeout: 30000
        });
      }
      else {
        await Promise.race([
          page.goto(targetUrl, { 
            waitUntil: 'networkidle2', // Wait for page elements to load and network activity to decrease
            timeout: navigationTimeout 
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Navigation timeout')), navigationTimeout)
          )
        ]);
      }

      logTS(`page fully loaded for encoder ${encoderConfig.url}`);
      return page;
    }
    else {
      throw new Error('targetUrl not defined');
    }
  } catch (error) {
    logTS(`Error launching browser for encoder ${encoderConfig.url}:`);
    logTS(error.stack || error.message || error);
    if (browsers.has(encoderConfig.url)) {
      browsers.delete(encoderConfig.url);
    }
    throw error;
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

async function main() {
  const app = express()
  app.use(express.urlencoded({ extended: false }));

  // Store the parsed arguments in app.locals
  app.locals.config = Constants;

  // Create a single cleanup manager instance for the application
  app.locals.cleanupManager = createCleanupManager();

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

     // Get the first available encoder config
    const availableEncoder = Constants.ENCODERS.find(encoder => 
      !browsers.has(encoder.url) && cleanupManager.canStartBrowser(encoder.url)
    );
  
    if (!availableEncoder) {
      logTS('No available encoders, rejecting request');
      res.status(503).send('All encoders are currently in use');
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
      console.log('response stream error for', availableEncoder.url, err);
      await cleanupManager.cleanup(availableEncoder.url, res);
    });
  
    try {
      page = await launchBrowser(targetUrl, availableEncoder);  // Pass the encoder config
  
      if (!cleanupManager.getState().isClosing) {
        const fetchResponse = await fetch(availableEncoder.url);
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
      console.log('failed to start browser or stream: ', targetUrl, e);
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
    
    // Get the first available encoder config
    const availableEncoder = Constants.ENCODERS.find(encoder => 
      cleanupManager.canStartBrowser(encoder.url)
    );

    if (!availableEncoder) {
      logTS('No available encoders, rejecting request');
      res.status(503).send('Server is busy, please try again later');
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
      page = await launchBrowser(req.body.recording_url, availableEncoder);  // Pass the encoder config
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