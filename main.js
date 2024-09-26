import express from 'express'
import puppeteer from 'puppeteer-core'
import { existsSync } from 'node:fs'
import { Readable } from 'stream'
import { execSync } from "child_process"
import * as Constants from './constants.js'


var currentBrowser, chromeDataDir, chromePath
async function setCurrentBrowser() {
  if (!currentBrowser || !currentBrowser.isConnected()) {
    // if running on a headless machine, force a display
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
        '--no-sandbox',
        '--start-fullscreen',
        '--noerrdialogs',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],  // the last two disables are needed to look across iFrames
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
      currentBrowser = null
    })

    // clean up the current browser before we start loading our pages
    currentBrowser.pages().then(pages => {
      pages.forEach(page => page.close())
    })
  }
}

async function launchBrowser(videoUrl) {
  await setCurrentBrowser()
  var page = await currentBrowser.newPage()
  await page.goto(videoUrl, { waitUntil: 'networkidle2' })
  return page
}

async function fullScreenVideo(page) {
  var frameHandle, videoHandle
  
  // first try happy path: video loads within timeout on mainFrame
  await new Promise(r => setTimeout(r, 10 * 1000));
  frameHandle = page.mainFrame()
  videoHandle = await frameHandle.$('video')

  if (videoHandle == null) {
    // unhappy path: slower loading page and/or video not in mainframe
    // example: https://www.nationalgeographic.com/tv/watch-live

    // split this into a couple best effort tries

    console.log('starting unhappy find video')
    await new Promise(r => setTimeout(r, 20 * 1000));
    
    const framesToSearchForVideo = await page.frames()
    console.log('found frames', framesToSearchForVideo.length)
    for (const frame of framesToSearchForVideo) {
      videoHandle = await frame.$('video')
      if (videoHandle) {
        frameHandle = frame
        break
      }
    }
  }

  // hide the cursor in every page frame
  // approach 5: before fullscreen
  const frames = await page.frames()
  for (const frame of frames) {  
    await frame.addStyleTag({
      content: `
        *:hover{cursor:none!important} 
        *{cursor:none!important}
      `
    });
  }

  if (videoHandle) {
    console.log('found video')
    await frameHandle.evaluate((video) => {
      video.play()
      video.muted = false
      video.removeAttribute('muted')
      video.style.cursor = 'none!important'
      video.requestFullscreen()
    }, videoHandle)
    // test on Disney - need to wait a couple seconds after play before fullscreen
  } else {
    console.log('did not find video')
  }

  /*
  console.log('timeout before zap cursor')
  await new Promise(r => setTimeout(r, 5 * 1000));
  */

  /*
  // approach 1: CSS class tag
  console.log('inject')
  await frameHandle.addStyleTag({content: 'video.ch4c_hide_cursor{cursor:none!important}'})
  console.log('added style')
  await frameHandle.evaluate((video) => {
    video.classList.add('ch4c_hide_cursor')
  }, videoHandle)
  console.log('done inject')
  */

  /*
  // approach 2: set cursor in every frame
  const pageFrames = await page.frames()
  for (const frame of pageFrames) {
    console.log('zap2 cursor')
    await frame.evaluate(() => {
      document.body.style.cursor = 'none'
      document.documentElement.style.cursor = 'none'
    })
  }
  */

  /*
  // approach 3: CSS hover tag in one frame
  console.log('inject')
  await frameHandle.addStyleTag({content: '*:hover{cursor:none!important}'})
  console.log('done inject')
  */
  /*
  // approach 4: hover in every frame
  console.log('inject')
  const pageFrames = await page.frames()
  for (const frame of pageFrames) {
    console.log('zap2 cursor')
    await frame.addStyleTag({content: '*:hover{cursor:none!important}'})
  }
  console.log('done inject')
  */
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
    var validPath = Constants.CHROME_EXECUTABLE_DIRECTORIES[process.platform].find(isValidLinuxPath)
    if (validPath) {
      return execSync(validPath).toString().split('\n').shift()
    }else {
      return null
    }
  } else {
    return Constants.CHROME_EXECUTABLE_DIRECTORIES[process.platform].find(existsSync)
  }
}

function buildRecordingJson(name, duration) {
  var startTime = Math.round(Date.now() / 1000)
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
  var response
  const channelsPostUrl = `${Constants.CHANNELS_URL}:${Constants.CHANNELS_PORT}/dvr/jobs/new`
  try {
    response = await fetch(channelsPostUrl, {
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

async function main() {
  const app = express()
  app.use(express.urlencoded({ extended: false }));

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

  app.get('/stream', async (req, res) => {
    console.log('got url: ', req.query.url)
    if (req.query.url == null) {
      console.log('must specify a target URL')
      res.status(500).send('must specify a target URL')
      return
    }

    // feed the transcoder output back to Channels
    const encoderUrl = Constants.ENCODER_STREAM_URL
    const fetchResponse = await fetch(encoderUrl)
    Readable.fromWeb(fetchResponse.body).pipe(res)

    try {
      var page = await launchBrowser(req.query.url)
    } catch (e) {
      console.log('failed to start browser page', e)
      return
    }
    try {
      await fullScreenVideo(page)
    } catch (e) {
      console.log('failed to find a video selector', e)
    }

    res.on('close', async err => {
      await page.close()
      console.log('finished')
    })
  })

  app.get('/instant', async (_req, res) => {
    res.send(Constants.INSTANT_PAGE_HTML)
  })

  app.post('/instant', async (req, res) => {
    if (req.body.button_record) {
      var recordingStarted = await startRecording(
        req.body.recording_name || 'Manual recording',
        req.body.recording_duration)

      if (!recordingStarted) {
        console.log('failed to start recording')
        res.send('failed to start recording')
        return
      }
    }
      
    var page
    try {
      page = await launchBrowser(req.body.recording_url)
    } catch (e) {
      console.log('failed to start browser page', e)
      res.status(500).send(`failed to start browser page: ${e}`)
      return
    }

    if (req.body.button_record) {
      res.send(`Started recording on ${Constants.ENCODER_CUSTOM_CHANNEL_NUMBER}, you can close this page`)
    }
    if (req.body.button_tune) {
      res.send(`Tuned to URL on ${Constants.ENCODER_CUSTOM_CHANNEL_NUMBER}, you can close this page`)
    }

    try {
      await fullScreenVideo(page)
    } catch (e) {
      console.log('did not find a video selector')
    }

    // close the page after the set duration
    await new Promise(r => setTimeout(r, req.body.recording_duration * 60 * 1000));
    await page.close()
  })

  const server = app.listen(Constants.CH4C_PORT, () => {
    console.log('CH4C listening on port', Constants.CH4C_PORT)
  })
}

main()