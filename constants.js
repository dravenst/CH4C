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
    demandOption: true,  // This makes the parameter required
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
  // Update the encoder option configuration
  .option('encoder', {
    alias: 'e',
    type: 'array',
    demandOption: true,
    describe: 'Encoder configurations in format "url[:channel:width_pos:height_pos:audio_device]" where channel is optional (format: xx.xx, default: 24.42), width_pos/height_pos are optional screen positions (default: 0:0), and audio_device is the optional audio output device name',
    coerce: (values) => {
      return values.map(value => {
        // Find the position of the first colon after http:// or https://
        const protocolEnd = value.indexOf('://');
        if (protocolEnd === -1) {
          throw new Error(`Invalid URL format: ${value}`);
        }
        
        const urlEnd = value.indexOf(':', protocolEnd + 3);
        let url, channel, width, height, audioDevice;
        
        if (urlEnd === -1) {
          // Only URL provided
          url = value;
          channel = '24.42';
          width = '0';
          height = '0';
          audioDevice = null;
        } else {
          // URL and additional parameters provided
          url = value.substring(0, urlEnd);
          const params = value.substring(urlEnd + 1).split(':');
          [channel = '24.42', width = '0', height = '0', audioDevice = null] = params;
        }
        
        if (!isValidUrl(url)) {
          throw new Error(`Invalid URL: ${url}`);
        }

        if (!isValidChannelNumber(channel)) {
          throw new Error(`Invalid channel number for URL ${url}: ${channel}`);
        }
        
        // Convert width and height to numbers and validate
        const browserWidthPos = parseInt(width);
        const browserHeightPos = parseInt(height);
        
        if (isNaN(browserWidthPos)) {
          throw new Error(`Invalid width position: ${width}`);
        }
        
        if (isNaN(browserHeightPos)) {
          throw new Error(`Invalid height position: ${height}`);
        }

        return {
          url,
          channel,
          width: browserWidthPos,
          height: browserHeightPos,
          audioDevice
        };
      });
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
  .usage('Usage: $0 [options]')
  .example('> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
  .example('\nSimple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71')
  .example('\n> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.72/live/stream1:24.43:1921:0:MACROSILICON"')
  .example('\nThis sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1921 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.')
  .example('\nWhen specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.  In Windows, to see encoder audio device names, look in Windows Sound Settings or use the powershell command: Get-AudioDevice -List')
  .help()
  .alias('help', 'h')
  .wrap(null)  // Don't wrap help text
  .version(false)  // Disable version number in help
  .alias('version', 'v')
  .strict()
  .parse();

const config = {
  CHANNELS_URL: argv['channels-url'],
  CHANNELS_PORT: argv['channels-port'],
  ENCODERS: argv['encoder'].map(encoder => ({
    url: encoder.url,
    channel: encoder.channel,
    width: encoder.width,
    height: encoder.height,
    audioDevice: encoder.audioDevice
  })),
  CH4C_PORT: argv['ch4c-port']
};

console.log('Current configuration:');
console.log(JSON.stringify(config, null, 2));

//export default config;

const CHANNELS_URL = config.CHANNELS_URL;
const CHANNELS_PORT = config.CHANNELS_PORT;
const ENCODERS = config.ENCODERS;
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

    #EXTINF:-1 channel-id="CH4C_Encoder" channel-number="${ENCODERS[0].channel}" tvc-guide-placeholders="3600",CH4C Encoder
    ${ENCODERS[0].url}
    
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
        <input type="submit" name="button_tune" value="Tune ${ENCODERS[0].channel} to URL" />
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
  ENCODERS: config.ENCODERS,
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