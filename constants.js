import os from 'os'
import path from 'path'

// update these to match your Channels instance and the
// streaming URL of your transcoder
const CHANNELS_URL = 'http://192.168.0.41'
const CHANNELS_PORT = '8089'
export const ENCODER_STREAM_URL = 'http://192.168.107.9/live/stream0'

// this is the custom channel number in Channels DVR that will be used
// for instant recordings. I used 24.42 because it's unique and
// spells CH4C on a telephone keypad. You shouldn't need to change this.
export const ENCODER_CUSTOM_CHANNEL_NUMBER = '24.42'
export const CH4C_PORT = 2442

// path to create recording jobs on Channels
export const CHANNELS_POST_URL = `${CHANNELS_URL}:${CHANNELS_PORT}/dvr/jobs/new`

export const START_PAGE_HTML = `
    <html>
    <title>Chrome HDMI for Channels</title>
    <h2>Chrome HDMI for Channels</h2>
    <p>Usage: <code>/stream?url=URL</code></p>
    <p>Create a custom channel in Channels DVR using the below as an example.<br>
    Be sure to choose "Prefer channel-number from M3U" and to replace<br>
    CH4C_IP_ADDRESS with the IP address of the server where you're running this code:
    </p>
    <pre>
    #EXTM3U

    #EXTINF:-1 channel-id="CH4C_Encoder" channel-number="${ENCODER_CUSTOM_CHANNEL_NUMBER}" tvc-guide-placeholders="3600",CH4C Encoder
    ${ENCODER_STREAM_URL}
    
    #EXTINF:-1 channel-id="CH4C_Weather" tvc-guide-placeholders="3600",Weatherscan
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream/?url=https://weatherscan.net/

    #EXTINF:-1 channel-id="CH4C_NFL_Network",NFL Network
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nfl.com/network/watch/nfl-network-live

    #EXTINF:-1 channel-id="CH4C_NatGeo",CH4CNatGeo
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nationalgeographic.com/tv/watch-live/

    #EXTINF:-1 channel-id="CH4C_Disney",CH4CDisney
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://disneynow.com/watch-live?brand=004
    </pre>
    <p>
    Also ensure that the values you've set in Constants.js are accurate:
    </p>
    <pre>
    CHANNELS_URL: ${CHANNELS_URL}<br>
    CHANNELS_PORT: ${CHANNELS_PORT}<br>
    ENCODER_STREAM_URL: ${ENCODER_STREAM_URL}
    </pre>
    </html>
`

export const INSTANT_PAGE_HTML = `
    <html>
    <title>Chrome HDMI for Channels - Instant Record</title>
    <h2>Chrome HDMI for Channels - Instant Record</h2>
    <form method="POST" action="/instant">
        <label>Recording Name</label>
        <input type="text" name="recording_name" id="recording_name" />
        <br/>
        <label>URL to Record</label>
        <input type="text" name="recording_url" id="recording_url" size="75" required />
        <br/>
        <label>Duration of Recording, Minutes</label>
        <input type="text" name="recording_duration" id="recording_duration" required />
        <br/>
        <input type="submit" name="button_record" value="Start Recording URL" />
        <input type="submit" name="button_tune" value="Tune ${ENCODER_CUSTOM_CHANNEL_NUMBER} to URL" />
      </form>
    </html>
`

// https://chromium.googlesource.com/chromium/src.git/+/HEAD/docs/user_data_dir.md
const linuxChromeUserDataDirectories = [
    path.join(os.homedir(), '.config', 'google-chrome'),
    path.join(os.homedir(), '.config', 'google-chrome-beta'),
    path.join(os.homedir(), '.config', 'google-chrome-unstable'),
    path.join(os.homedir(), '.config', 'chromium'),
]
const macChromeUserDataDirectories = [
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Beta'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'),
]
const winChromeUserDataDirectories = [
    path.join(os.homedir(), 'Google', 'Chrome', 'User Data'),
    path.join(os.homedir(), 'Google', 'Chrome Beta', 'User Data'),
    path.join(os.homedir(), 'Google', 'Chrome SxS', 'User Data'),
    path.join(os.homedir(), 'Chromium', 'User Data'),
]
export const CHROME_USERDATA_DIRECTORIES = {
    'darwin': macChromeUserDataDirectories,
    'win32': winChromeUserDataDirectories,
    'linux': linuxChromeUserDataDirectories,
}

// https://www.npmjs.com/package/chrome-paths
const linuxChromeExecutableDirectories = [
    'which chromium-browser',
    'which chromium',
    'which chrome',
]
const macChromeExecutableDirectories = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
]
const winChromeExecutableDirectories = [
    `C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe`,
    `C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Google\\Chrome SxS\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
]
export const CHROME_EXECUTABLE_DIRECTORIES = {
    'darwin': macChromeExecutableDirectories,
    'win32': winChromeExecutableDirectories,
    'linux': linuxChromeExecutableDirectories,
}