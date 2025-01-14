const express = require('express');
const puppeteer = require('puppeteer-core');
const { existsSync } = require('fs');
const { Readable } = require('stream');
const { execSync } = require('child_process');
const Constants = require('./constants.js');
const fetch = require('node-fetch');
const { URL } = require('url');

let currentBrowser, chromeDataDir, chromePath;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logTS(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

async function closeBrowser() {
  if (currentBrowser && currentBrowser.isConnected()) {
    try {
      await currentBrowser.close();
      logTS('browser closed');
    } catch (e) {
      console.log('error closing browser', e);
    } finally {
      currentBrowser = null;
    }
  }
}

// Attempts to close browser in a safe fashion to prevent it from restarting by using the getState (true=closingInProgress)
const createCleanupManager = () => {
  let isClosing = false;
  let isBrowserActive = false;
  
  // Add process handlers for cleanup
  process.on('SIGINT', async () => {
    logTS('Caught interrupt signal');
    await closeBrowser();
    process.exit();
  });
  
  process.on('SIGTERM', async () => {
    logTS('Caught termination signal');
    await closeBrowser();
    process.exit();
  });

  return {
    cleanup: async (res) => {
      if (isClosing) {
        logTS('Cleanup already in progress, skipping');
        return;
      }
      isClosing = true;
      logTS('Starting cleanup');
      try {
        await closeBrowser();
        if (res && !res.headersSent) {
          res.status(499).send();
          console.log('Response ended with status 499');
        }
      } finally {
        await delay(2000); // Add a delay to avoid undesirable stream restarts
        isClosing = false;
        isBrowserActive = false;
        logTS('Cleanup completed');
      }
    },
    // Check if we can start a new browser session
    canStartBrowser: () => !isClosing && !isBrowserActive,
    // Mark browser as active
    setBrowserActive: () => { isBrowserActive = true; },
    // Get current state
    getState: () => ({ isClosing, isBrowserActive })
  };
};

async function setCurrentBrowser() {
  if (!currentBrowser || !currentBrowser.isConnected()) {
    process.env.DISPLAY = process.env.DISPLAY || ':0'

    currentBrowser = await puppeteer.launch({
      executablePath: chromePath,
      userDataDir: chromeDataDir,
      headless: false,
      defaultViewport: null,
      args: [
        '--no-first-run',
        '--disable-infobars',
        '--hide-crash-restore-bubble',
        '--disable-blink-features=AutomationControlled',
        '--hide-scrollbars',
//        '--no-sandbox', //not sure if this is needed?
        '--start-fullscreen',
        '--noerrdialogs',
//        '--disable-web-security',    // is this required?
        '--disable-features=IsolateOrigins,site-per-process', // last two disables required for hiding cursors across iFrames
        '--hide-crash-restore-bubble', // Hide the yellow notification bar
        '--disable-notifications', // Mimic real user behavior
        '--enable-audio-output', // Ensure audio output is enabled
        '--allow-running-insecure-content',  // Sling has both https and http
        '--autoplay-policy=no-user-gesture-required',
        '--log-level=2', // error level only
        '--enable-accelerated-video-decode',
        '--enable-accelerated-video-encode', 
        '--enable-gpu-rasterization', 
      ],  
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-update',
        '--disable-component-extensions-with-background-pages',
        '--enable-blink-features=IdleDetection',
      ],
    });

    currentBrowser.on('close', () => {
      logTS('browser closed')
      currentBrowser = null
    })
    
    currentBrowser.on('disconnected', () => {
      logTS('browser disconnected');
      currentBrowser = null
    });
  }
}

async function launchBrowser(videoUrl) {
  logTS("starting browser");
  await setCurrentBrowser();
  if (currentBrowser && currentBrowser.isConnected()) {
    const page = await currentBrowser.newPage();
    const navigationTimeout = 30000;

    logTS("loading page")
    if (videoUrl) {
      // For Sling and Photos, we can't use networkidle2 for page load
      if ((videoUrl.includes("watch.sling.com")) || (videoUrl.includes("photos.app.goo.gl"))) {
        await page.goto(videoUrl, {
          waitUntil: 'load',
          timeout: navigationTimeout
        });
      }
      else {
        try {
          await Promise.race([
            page.goto(videoUrl, { 
              waitUntil: 'networkidle2',
              timeout: navigationTimeout 
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Navigation timeout')), navigationTimeout)
            )
          ]);
        } catch (error) {
          logTS('Navigation timeout, continuing anyway');
        }
      }
      logTS("page fully loaded");
      return page;
    }
    else {
       throw new Error('videoUrl not defined')
    }
  }
  throw new Error('browser not connected')
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
    await delay(200);
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

function buildRecordingJson(name, duration) {
  const startTime = Math.round(Date.now() / 1000)
  const data = {
    "Name": name,
    "Time": startTime,
    "Duration": duration * 60,
    "Channels": [Constants.ENCODER_CUSTOM_CHANNEL_NUMBER],
    "Airing": {
      "Source": "manual",
      "Channel": Constants.ENCODER_CUSTOM_CHANNEL_NUMBER,
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

async function startRecording(name, duration) {
  let response
  try {
    response = await fetch(Constants.CHANNELS_POST_URL, {
      method: 'POST',
      headers: {
        'Content-type': 'application/json',
      },
      body: buildRecordingJson(name, duration),
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
  
  // First, attempt to kill any existing Chrome processes to ensure they're not running
  try {
    if (process.platform === 'linux') {
      execSync('pkill -f chrome');
    } else if (process.platform === 'darwin') {
      execSync('pkill -f Google\\ Chrome');
    } else if (process.platform === 'win32') {
      execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' });
    }
    console.log('Cleaned up existing Chrome processes');
    // Wait a moment for processes to fully close
    await delay(2000);
  } catch (e) {
    // It's okay if there were no processes to kill
    console.log('No existing Chrome processes found');
  }

  const app = express()
  app.use(express.urlencoded({ extended: false }));

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
    let page
    let targetUrl
  
    // Use a single cleanup manager instance for the application
    const cleanupManager = req.app.locals.cleanupManager;

    // Check if we can handle a new request
    if (!cleanupManager.canStartBrowser()) {
      logTS('Browser is busy or cleanup in progress, rejecting request');
      res.status(503).send('Server is busy, please try again later');
      return;
    }

    targetUrl = getFullUrl(req);
    if (!targetUrl) {
      if (!res.headersSent) {
        res.status(500).send('must specify a target URL')}  
    }
    logTS('streaming to ' + targetUrl);

    // Mark browser as active before starting
    cleanupManager.setBrowserActive();

    // For graceful termination of the stream with channels app
    res.on('close', async err => {
      logTS('response stream closed')
      await cleanupManager.cleanup(res);
    })

    // For error case
    res.on('error', async err => {
      console.log('response stream error', err)
      await cleanupManager.cleanup(res);
    })
    
    try {
      page = await launchBrowser(targetUrl);

      if (!cleanupManager.getState().isClosing) {  
        const fetchResponse = await fetch(Constants.ENCODER_STREAM_URL);
        if (!fetchResponse.ok) {
            throw new Error(`Encoder stream HTTP error: ${fetchResponse.status}`);
        }
        if (res && !res.headersSent) {
          const stream = Readable.from(fetchResponse.body);
            
          stream.pipe(res, {
              end: true
          }).on('error', (error) => {
              console.error('Stream error:', error);
              cleanupManager.cleanup(res);
          });
        }
      }      
      if (!cleanupManager.getState().isClosing) {
        try {
          // Handle Sling specific page
          if (req.query.url.includes("watch.sling.com")){
            await fullScreenVideoSling(page);
          }
          // Handle Google Photo Album specific page
          else if (req.query.url.includes("photos.app.goo.gl")){
            await fullScreenVideoGooglePhotos(page);
          }
          // default handling for other services
          else {
            await fullScreenVideo(page)
          }
        } catch (e) {
          console.log('failed to go full screen', e)
        }
      }    
    } catch (e) {
      console.log('failed to start browser or stream: ', targetUrl, e)
      if (!res.headersSent) {
        res.status(500).send(`failed to start browser or stream: ${e}`)
      }
      await cleanupManager.cleanup(res);
      return;
    }
    
  })

  app.get('/instant', async (_req, res) => {
    res.send(Constants.INSTANT_PAGE_HTML)
  })

  app.post('/instant', async (req, res) => {
    const cleanupManager = req.app.locals.cleanupManager;
    
    if (!cleanupManager.canStartBrowser()) {
      logTS('Browser is busy or cleanup in progress, rejecting request');
      res.status(503).send('Server is busy, please try again later');
      return;
    }
        
    if (req.body.button_record) {
      const recordingStarted = await startRecording(
        req.body.recording_name || 'Manual recording',
        req.body.recording_duration)

      if (!recordingStarted) {
        console.log('failed to start recording')
        res.send('failed to start recording')
        return
      }
    }

    let page
    cleanupManager.setBrowserActive();

    try {
      page = await launchBrowser(req.body.recording_url)
    } catch (e) {
      console.log('failed to start browser page, ensure not already running', e)
      if (!res.headersSent) {
        res.status(500).send(`failed to start browser, ensure not already running: ${e}`)
        await cleanupManager.cleanup(res);
      }
      return
    }

    if (req.body.button_record) {
      res.send(`Started recording on ${Constants.ENCODER_CUSTOM_CHANNEL_NUMBER}, you can close this page`)
    }
    if (req.body.button_tune) {
      res.send(`Tuned to URL on ${Constants.ENCODER_CUSTOM_CHANNEL_NUMBER}, you can close this page`)
    }

    try {
      // Handle Sling specific page
      if (req.query.url.includes("watch.sling.com")){
        await fullScreenVideoSling(page);
      }
      // Handle Google Photo Album specific page
      else if (req.query.url.includes("photos.app.goo.gl")){
        await fullScreenVideoGooglePhotos(page);
      }
      // default handling for page
      else {
        await fullScreenVideo(page)
      }
    } catch (e) {
      console.log('did not find a video selector for: ', req.query.url, e)
    }

    // close the browser after the recording period ends
    await new Promise(r => setTimeout(r, req.body.recording_duration * 60 * 1000));
    try {
      await cleanupManager.cleanup(res);
    }catch (e) {
      console.log('error closing browser after recording', e)
    }
  })

  const server = app.listen(Constants.CH4C_PORT, () => {
    logTS('CH4C listening on port', Constants.CH4C_PORT)
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