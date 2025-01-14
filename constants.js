const os = require('os');
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const { URL } = require('url');

/**
 * Validate if a string is a valid URL
 * @param {string} url - URL to validate
 * @returns {boolean} - True if valid URL
 */
const isValidUrl = (url) => {
  try {
    new URL(url);
    return true;
  } catch (e) {
    return false;
  }
};

/**
 * Validate if a string is a valid channel number format (xx.xx)
 * @param {string} channel - Channel number to validate
 * @returns {boolean} - True if valid channel number format
 */
const isValidChannelNumber = (channel) => {
  return /^\d+\.\d+$/.test(channel);
};

const argv = yargs(hideBin(process.argv))
  .option('channels-url', {
    alias: 's',
    type: 'string',
    default: 'http://192.168.50.50',
    describe: 'Channels server URL',
    coerce: (value) => {
      if (!isValidUrl(value)) {
        throw new Error(`Invalid URL: ${value}`);
      }
      return value;
    }
  })
  .option('channels-port', {
    alias: 'p',
    type: 'string',
    default: '8089',
    describe: 'Channels server port',
    coerce: (value) => {
      const port = parseInt(value);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Port must be a number between 1 and 65535');
      }
      return value;
    }
  })
  .option('encoder-stream-url', {
    alias: 'e',
    type: 'string',
    default: 'http://192.168.50.71/live/stream0',
    describe: 'External Encoder stream URL',
    coerce: (value) => {
      if (!isValidUrl(value)) {
        throw new Error(`Invalid URL: ${value}`);
      }
      return value;
    }
  })
  .option('encoder-custom-channel-number', {
    alias: 'n',
    type: 'string',
    default: '24.42',
    describe: 'Custom channel number (format: xx.xx)',
    coerce: (value) => {
      if (!isValidChannelNumber(value)) {
        throw new Error('Custom channel number must be in format xx.xx');
      }
      return value;
    }
  })
  .option('ch4c-port', {
    alias: 'c',
    type: 'number',
    default: 2442,
    describe: 'CH4C port number',
    coerce: (value) => {
      const port = parseInt(value);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('Port must be a number between 1 and 65535');
      }
      return port;
    }
  })
  .help()
  .alias('help', 'h')
  .version('0.0.2')
  .alias('version', 'v')
  .strict()
  .parse();

const config = {
  CHANNELS_URL: argv['channels-url'],
  CHANNELS_PORT: argv['channels-port'],
  ENCODER_STREAM_URL: argv['encoder-stream-url'],
  ENCODER_CUSTOM_CHANNEL_NUMBER: argv['encoder-custom-channel-number'],
  CH4C_PORT: argv['ch4c-port']
};

console.log('Current configuration:');
console.log(JSON.stringify(config, null, 2));

//export default config;

const CHANNELS_URL = config.CHANNELS_URL;
const CHANNELS_PORT = config.CHANNELS_PORT;
const ENCODER_STREAM_URL = config.ENCODER_STREAM_URL;
const ENCODER_CUSTOM_CHANNEL_NUMBER = config.ENCODER_CUSTOM_CHANNEL_NUMBER;
const CH4C_PORT = config.CH4C_PORT;

// retries and wait durations for retrying to load and play video
const FIND_VIDEO_RETRIES = 6
const FIND_VIDEO_WAIT = 2        // seconds
const PLAY_VIDEO_RETRIES = 6
const PLAY_VIDEO_WAIT = 5        // seconds
const FULL_SCREEN_WAIT = 3        // seconds

// path to create recording jobs on Channels
const CHANNELS_POST_URL = `${CHANNELS_URL}:${CHANNELS_PORT}/dvr/jobs/new`

const START_PAGE_HTML = `
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

const INSTANT_PAGE_HTML = `
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
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome Beta', 'User Data'),
    path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome SxS', 'User Data'),
    path.join(os.homedir(), 'AppData', 'Local', 'Chromium', 'User Data'),
]
const CHROME_USERDATA_DIRECTORIES = {
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
const CHROME_EXECUTABLE_DIRECTORIES = {
    'darwin': macChromeExecutableDirectories,
    'win32': winChromeExecutableDirectories,
    'linux': linuxChromeExecutableDirectories,
}

module.exports = {
  CHANNELS_URL: config.CHANNELS_URL,
  CHANNELS_PORT: config.CHANNELS_PORT,
  ENCODER_STREAM_URL: config.ENCODER_STREAM_URL,
  ENCODER_CUSTOM_CHANNEL_NUMBER: config.ENCODER_CUSTOM_CHANNEL_NUMBER,
  CH4C_PORT: config.CH4C_PORT,
  FIND_VIDEO_RETRIES,
  FIND_VIDEO_WAIT,
  PLAY_VIDEO_RETRIES,
  PLAY_VIDEO_WAIT,
  FULL_SCREEN_WAIT,
  CHANNELS_POST_URL,
  START_PAGE_HTML,
  INSTANT_PAGE_HTML,
  CHROME_USERDATA_DIRECTORIES,
  CHROME_EXECUTABLE_DIRECTORIES
};