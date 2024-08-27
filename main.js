import express from 'express'
import { Readable } from 'stream'
import puppeteer from 'puppeteer-core'

// verify at your command line you can run:
// chromium-browser
// i got an error about Missing X server until I ran this at terminal:
// export DISPLAY=:0
var currentBrowser, dataDir
const getCurrentBrowser = async () => {
  if (!currentBrowser || !currentBrowser.isConnected()) {
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
        '--disable-component-update',
        '--disable-component-extensions-with-background-pages',
        '--enable-blink-features=IdleDetection',
        '--mute-audio',
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

async function main() {
  const app = express()
  const port = 3000

  dataDir = '/home/ellefeira/.config/chromium'

  app.get('/', async (_req, res) => {
    // get the encoder stream
    const myUrl = 'http://192.168.107.9/live/stream0'
    const fetchResponse = await fetch(myUrl)

    // send the pipe of the stream to the request
    Readable.fromWeb(fetchResponse.body).pipe(res)
  })

  // : means query paramter
  // ? means optional
  app.get('/go', async (_req, res) => {
    var browser, page
    try {
      console.log('starting up')
      browser = await getCurrentBrowser()
      console.log('browser')
      page = await browser.newPage()
      console.log('have page')
      await page.goto('https://www.nfl.com/plus/games/colts-at-bengals-2024-pre-3?mcpid=1888004')
      console.log('did goto page')
      // document.querySelector("video").requestFullscreen()
      await page.evaluate(`(function() {
        document.body.style.cursor = 'none'
      })()`)
      console.log('full screened')
    } catch (e) {
      console.log('failed to start browser page', e)
      res.status(500).send(`failed to start browser page: ${e}`)
      return
    }
  })

  const server = app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
  })
}

main()