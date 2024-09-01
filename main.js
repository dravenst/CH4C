import express from 'express'
import puppeteer from 'puppeteer-core'
import { Readable } from 'stream'
import * as Constants from "./constants.js"

// verify at your command line you can run:
// chromium-browser
var currentBrowser, dataDir
const getCurrentBrowser = async () => {
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

  return currentBrowser
}
/*
async function launchBrowser(videoUrl) {
  try {
      browser = await getCurrentBrowser()
      page = await browser.newPage()
      await page.goto(videoUrl)
      // break wait for video into a fail safe
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
    } catch (e) {
      console.log('failed to start browser page', e)
      res.status(500).send(`failed to start browser page: ${e}`)
      return
    }
}
*/
async function main() {
  const app = express()
  const port = 3000

  dataDir = '/home/ellefeira/.config/chromium'

  // send back the transcoder stream - testing only
  // delete when ready
  app.get('/', async (_req, res) => {
    const encoderUrl = Constants.ENCODER_STREAM_URL //'http://192.168.107.9/live/stream0'
    const fetchResponse = await fetch(encoderUrl)
    Readable.fromWeb(fetchResponse.body).pipe(res)
  })

  // : means query paramter
  // ? means optional
  // call this path from the custom channel in Channels
  // passing in either a name or a URL
  // the custom URL form can also call this, just include
  // a flag that indicates don't pipe back and send JSON
  app.get('/go', async (_req, res) => {

    // feed the transcoder output back to Channels
    const encoderUrl = Constants.ENCODER_STREAM_URL //'http://192.168.107.9/live/stream0'
    const fetchResponse = await fetch(encoderUrl)
    Readable.fromWeb(fetchResponse.body).pipe(res)

    // get the desired URL - make that a function
    const videoUrl = 'https://www.nfl.com/plus/games/colts-at-bengals-2024-pre-3?mcpid=1888004'
    var browser, page

    res.on('close', async err => {
      //await Readable.fromWeb(fetchResponse.body).destroy()
      await page.close()
      console.log('finished')
    })

    // try the below as a function
    // await launchBrowser(videoUrl);

    try {
      browser = await getCurrentBrowser()
      page = await browser.newPage()
      await page.goto(videoUrl)
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
    } catch (e) {
      console.log('failed to start browser page', e)
      res.status(500).send(`failed to start browser page: ${e}`)
      return
    }

  })

  app.get('/stream/:name?', async (req, res) => {
    var u = req.query.url || Constants.NAMED_URLS[req.params.name]
    console.log('got url: ', u)
    if (u == null) {
      console.log('failed to parse target URL', u)
      res.status(500).send('failed to parse target URL')
    }
  })
  /*
  app.get('/instant', async (_req, res) => {

    // send JSON so Channels starts recording the transcoder
    await sendJSON

    // get the desired URL
    //var u = req.query.url
    const videoUrl = 'https://www.nfl.com/plus/games/colts-at-bengals-2024-pre-3?mcpid=1888004'
    var browser, page

    // load the desired URL
    await launchBrowser(videoUrl);

    // close the browser when the recording is done + some buffer
    // https://stackoverflow.com/questions/951021/what-is-the-javascript-version-of-sleep
    await new Promise(r => setTimeout(r, 2000));
    await page.close()
    console.log('finished instant recording')
    
  })
  */

  const server = app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
  })
}

main()