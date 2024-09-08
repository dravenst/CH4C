import express, { response } from 'express'
import puppeteer from 'puppeteer-core'
import { Readable } from 'stream'
import * as Constants from "./constants.js"

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
        // '--start-maximized',
        '--start-fullscreen',
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
      ],
    });

    currentBrowser.on('close', () => {
      currentBrowser = null
    })

    // clean up the current browser before we start loading our pages
    console.log('about to page close')
    currentBrowser.pages().then(pages => {
      pages.forEach(page => page.close())
      console.log('page close')
    })
  }
}

async function launchBrowser(videoUrl) {
  await setCurrentBrowser()
  var page = await currentBrowser.newPage()
  console.log('got page going to url')
  await page.goto(videoUrl, { waitUntil: 'networkidle2' })
  console.log('went to url')
  return page
}

async function fullScreenVideo(page) {
  await page.waitForSelector('video')
  await page.waitForFunction(`(function() {
    let video = document.querySelector('video')
    return video.readyState === 4
  })()`)
  await page.evaluate(`(function() {
      let video = document.querySelector('video')
      video.style.cursor = 'none'
      video.play()
      video.muted = false
      video.removeAttribute('muted')
      video.requestFullscreen()
  })()`)
  await page.evaluate(`(function() {
    document.body.style.cursor = 'none'
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
        "EpisodeTitle": "manual recording yup",
        "Summary": "Recorded on this day",
        "Image": "https://tmsimg.fancybits.co/assets/p9467679_st_h6_aa.jpg",
        "ProgramID": "asdfafd",
        "SeasonNumber": 0,
        "EpisodeNumber": 0,
        "OriginalDate": "2024-09-07",
        "Raw": "",
    }
  }
  return JSON.stringify(data)
};

/*
  {
    "id": "2310",
    "program_id": "asdfafd",
    "path": "/cdvr/TV/JPFTtry/JPFTtry manual recording yup 2024-09-07-2214.mpg",
    "channel": "24.42",
    "title": "JPFTtry",
    "episode_title": "manual recording yup",
    "summary": "Recorded on this day",
    "image_url": "https://tmsimg.fancybits.co/assets/p9467679_st_h6_aa.jpg",
    "thumbnail_url": "https://b7e2f5d58bd8.u.channelsdvr.net:8089/dvr/files/2310/preview.jpg",
    "playback_time": 0,
    "watched": false,
    "favorited": false,
    "delayed": false,
    "cancelled": false,
    "corrupted": false,
    "completed": false,
    "processed": false,
    "locked": false,
    "verified": false,
    "created_at": 1725772443000,
    "updated_at": 1725772443017
  },
  {
    "id": "2308",
    "show_id": "200944",
    "program_id": "EP000167471505",
    "path": "/cdvr/TV/48 Hours/48 Hours S37E32 The Case of the Black Swa 2024-09-07-2200.mpg",
    "channel": "5.1",
    "season_number": 37,
    "episode_number": 32,
    "title": "48 Hours",
    "episode_title": "The Case of the Black Swan",
    "summary": "New details in the trial of Ashley Benefield, who claims she shot her husband in self-defense.",
    "full_summary": "New details in the murder trial of former ballerina Ashley Benefield, who claims her husband tried to poison her while she was pregnant and that she shot him in self-defense.",
    "image_url": "https://tmsimg.fancybits.co/assets/p200944_b_h9_ae.jpg?w=720&h=540",
    "thumbnail_url": "https://b7e2f5d58bd8.u.channelsdvr.net:8089/dvr/files/2308/preview.jpg",
    "playback_time": 0,
    "original_air_date": "2024-09-07",
    "genres": [
      "Newsmagazine",
      "Crime",
      "Law"
    ],
    "tags": [
      "CC",
      "DD 5.1",
      "HD 1080i",
      "HDTV",
      "New",
      "Stereo"
    ],
    "categories": [
      "Episode",
      "Series"
    ],
    "cast": [
      "Erin Moriarty",
      "Peter Van Sant",
      "Natalie Morales"
    ],
    "watched": false,
    "favorited": false,
    "delayed": false,
    "cancelled": false,
    "corrupted": false,
    "completed": false,
    "processed": false,
    "locked": false,
    "verified": false,
    "created_at": 1725771600000,
    "updated_at": 1725771600494
  },
*/

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
    console.log('done start recording', response)
    return response.ok
  }
}

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
      return
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
      //res.status(500).send(`failed to start browser page: ${e}`)
      return
    }
    
    // if there is a video, full screen it
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
      
    // load the target url
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

    // if there is a video, full screen it
    try {
      await fullScreenVideo(page)
    } catch (e) {
      console.log('did not find a video selector')
    }

    console.log('about to wait')
    await new Promise(r => setTimeout(r, req.body.recording_duration * 60 * 1000));
    console.log('done waiting')
    await page.close()
    console.log('finished instant')
  })

  const server = app.listen(Constants.CH4C_PORT, () => {
    console.log('CH4C listening on port', Constants.CH4C_PORT)
  })
}

main()