import express from 'express'
import puppeteer from 'puppeteer-core'
import { Readable } from 'stream'
import * as Constants from "./constants.js"

// verify at your command line you can run:
// chromium-browser
var currentBrowser, dataDir
async function setCurrentBrowser() {
  if (!currentBrowser || !currentBrowser.isConnected()) {
    // if running on a headless machine, force a display
    process.env.DISPLAY = process.env.DISPLAY || ':0'
    currentBrowser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium-browser',
      userDataDir: dataDir,
      headless: false,
      defaultViewport: null,
      args: [
        '--no-first-run',
        '--disable-infobars',
        '--hide-crash-restore-bubble',
        '--disable-blink-features=AutomationControlled',
        '--hide-scrollbars',
        '--no-sandbox',
        //'--start-fullscreen',
        //'--kiosk',
        '--noerrdialogs',
      ],
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-extensions',
        '--disable-default-apps',
        //'--disable-component-update',
        //'--disable-component-extensions-with-background-pages',
        //'--enable-blink-features=IdleDetection',
      ],
    });

    currentBrowser.on('close', () => {
      currentBrowser = null
    })

    currentBrowser.pages().then(pages => {
      pages.forEach(page => page.close())
    })
  }
}

async function launchBrowser(videoUrl) {
  await setCurrentBrowser()
  var page = await currentBrowser.newPage()
  await page.goto(videoUrl)
  return page
}

async function fullScreenVideo(page) {
  await page.waitForSelector('video')
  await page.waitForFunction(`(function() {
    let video = document.querySelector('video')
    return video.readyState === 4
  })()`)
  await page.evaluate(`(function() {
      document.body.style.cursor = 'none'
      let video = document.querySelector('video')
      video.style.cursor = 'none'
      video.play()
      video.muted = false
      video.removeAttribute('muted')
      video.requestFullscreen()
  })()`)
}

function buildRecordingJson(name, duration) {
  const data = {
    "Name": name,
    "Time": Math.round(Date.now() / 1000),
    "Duration": duration * 60,
    "Channels": [Constants.ENCODER_CUSTOM_CHANNEL_NUMBER],
    "Airing": {
        "Source": "manual",
        "Channel": Constants.ENCODER_CUSTOM_CHANNEL_NUMBER,
        "Time": Math.round(Date.now() / 1000),
        "Duration": duration * 60,
        "Title": name,
    }
  }
  return JSON.stringify(data)
};

async function main() {
  const app = express()
  app.use(express.urlencoded({ extended: false }));

  dataDir = '/home/ellefeira/.config/chromium'

  app.get('/', async (req, res) => {
    res.send(Constants.START_PAGE_HTML.replaceAll('<<host>>', req.get('host')))
  })

  app.get('/stream/:name?', async (req, res) => {

    // figure out the target url
    const videoUrl = req.query.url || Constants.NAMED_URLS[req.params.name]
    console.log('got url: ', videoUrl)
    if (videoUrl == null) {
      console.log('failed to parse target URL: ', videoUrl)
      res.status(500).send('failed to parse target URL')
    }

    // feed the transcoder output back to Channels
    const encoderUrl = Constants.ENCODER_STREAM_URL
    const fetchResponse = await fetch(encoderUrl)
    Readable.fromWeb(fetchResponse.body).pipe(res)

    // load the target url
    try {
      var page = await launchBrowser(videoUrl)
    } catch (e) {
      console.log('failed to start browser page', e)
      res.status(500).send(`failed to start browser page: ${e}`)
      return
    }
    
    // if there is a video, full screen it
    try {
      await fullScreenVideo(page)
    } catch (e) {
      console.log('failed to find a video selector', e)
      res.status(200).send(`failed to find a video selector: ${e}`)
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
    const jsonData = buildRecordingJson(
      req.body.recording_name,
      req.body.recording_duration)
    
    const channelsPostUrl = `${Constants.CHANNELS_URL}:${Constants.CHANNELS_PORT}/dvr/jobs/new`
    /*
    fetch(channelsPostUrl, {
      method: 'POST',
      headers: {
        'Content-type': 'application/json',
      },
      body: jsonData,
    })
      .then((response) => response.json())
      .then((json) => console.log(json))
      .catch((error) => {
          console.error('error in execution', error);
      }); 
    */

    /*
    // load the desired URL - same as normal

    // close the browser when the recording is done + some buffer
    // https://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
    // await new Promise(r => setTimeout(r, 2 * 1000));
    console.log('waiting for recording to finish')
    await new Promise(r => setTimeout(r, duration * 60 * 1000));
    await page.close()
    console.log('finished instant recording')
    */

    res.send(`Channels JSON is: ${jsonData} and Channels URL is: ${channelsPostUrl}`)
  })

  const server = app.listen(Constants.CH4C_PORT, () => {
    console.log('Example app listening on port', Constants.CH4C_PORT)
  })
}

main()