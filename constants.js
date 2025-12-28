const os = require('os');
const path = require('path');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const { URL } = require('url');
const { AudioDeviceManager } = require('./audio-device-manager');

/**
 * Show available audio devices synchronously (blocking)
 * This works in both regular Node.js and bundled executables
 */
async function showAudioDevices() {
  console.log('\nAvailable Audio Output Devices:');
  try {
    const audioManager = new AudioDeviceManager();
    const devices = await audioManager.getAudioDevices();
    devices.forEach((device, index) => {
      console.log(`  ${index + 1}. ${device}`);
    });
  } catch (error) {
    console.log('  Error retrieving audio devices:', error.message);
  }
}

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

/**
 * Get audio devices list as a formatted string for help display
 */
const getAudioDevicesHelpText = async () => {
  try {
    const audioManager = new AudioDeviceManager();
    const devices = await audioManager.getAudioDevices();

    if (devices && devices.length > 0) {
      let helpText = '\n\nAvailable Audio Output Devices:\n';
      devices.forEach((device, index) => {
        const deviceName = device.name || device.label || 'Unknown Device';
        helpText += `  ${index + 1}. ${deviceName}`;
        if (device.isDefault) {
          helpText += ' (Default)';
        }
        helpText += '\n';
      });
      return helpText;
    } else {
      return '\n\nNo audio output devices found.\n';
    }
  } catch (error) {
    return `\n\nError retrieving audio devices: ${error.message}\n`;
  }
};

// Remove the special help handling - let it go through the normal yargs flow
const rawArgs = hideBin(process.argv);

const argv = yargs(rawArgs)
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
  .option('data-dir', {
    alias: 'd',
    type: 'string',
    default: 'data',
    describe: 'Directory location for storing channel data.'
  })
  .option('enable-pause-monitor', {
    alias: 'm',
    type: 'boolean',
    default: true,
    describe: 'Enable automatic video pause detection and resume'
  })
  .option('pause-monitor-interval', {
    alias: 'i',
    type: 'number',
    default: 10,
    describe: 'Interval in seconds to check for paused video',
    coerce: (value) => {
      const interval = parseInt(value);
      if (isNaN(interval) || interval < 1 || interval > 300) {
        throw new Error('Pause monitor interval must be between 1 and 300 seconds');
      }
      return interval;
    }
  })
  .usage('Usage: $0 [options]')
  .example('> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
  .example('\nSimple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71')
  .example('\n> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.71/live/stream1:24.43:1921:0:MACROSILICON"')
  .example('\nThis sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1921 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.')
  .example('\nWhen specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.')
  .help(false)  // Disable built-in help to handle it in fail()
  .alias('help', 'h')
  .wrap(null)  // Don't wrap help text
  .version(false)  // Disable version number in help
  .alias('version', 'v')
  .strict()
  .exitProcess(false)  // Prevent yargs from calling process.exit()
  .fail((msg, err, yargs) => {
    // Show standard error message
    if (msg) console.error(msg);
    if (err) console.error('Error:', err.message);
    console.error('\n');

    // Show help
    yargs.showHelp();

    // Show audio devices and exit when done
    (async () => {
      await showAudioDevices();
      process.exit(1);
    })();
  })
  .parse();

// If help was requested explicitly, handle it here
// Note: yargs .help(false) disables built-in help, so we need to check for it manually
if (argv.help) {
  // Create a temporary yargs instance for showing help
  const helpYargs = yargs()
    .option('channels-url', { alias: 's', type: 'string', demandOption: true, describe: 'Channels server URL' })
    .option('channels-port', { alias: 'p', type: 'string', default: '8089', describe: 'Channels server port' })
    .option('encoder', { alias: 'e', type: 'array', demandOption: true, describe: 'Encoder configurations in format "url[:channel:width_pos:height_pos:audio_device]" where channel is optional (format: xx.xx, default: 24.42), width_pos/height_pos are optional screen positions (default: 0:0), and audio_device is the optional audio output device name' })
    .option('ch4c-port', { alias: 'c', type: 'number', default: 2442, describe: 'CH4C port number' })
    .option('data-dir', { alias: 'd', type: 'string', default: 'data', describe: 'Directory for storing channel data. Can be relative or absolute path (default: data)' })
    .option('enable-pause-monitor', { alias: 'm', type: 'boolean', default: true, describe: 'Enable automatic video pause detection and resume' })
    .option('pause-monitor-interval', { alias: 'i', type: 'number', default: 10, describe: 'Interval in seconds to check for paused video' })
    .usage('Usage: $0 [options]')
    .example('> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
    .example('\nSimple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71')
    .example('\n> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.72/live/stream1:24.43:1921:0:MACROSILICON"')
    .example('\nThis sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1921 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.')
    .example('\nWhen specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.')
    .help()
    .wrap(null)
    .version(false);

  // Show help
  helpYargs.showHelp();

  // Show audio devices and exit when done
  (async () => {
    await showAudioDevices();
    process.exit(0);
  })();

  // Export empty config and return to prevent further initialization
  module.exports = {};
  return;
}

// Safely extract config, handling case where argv might be incomplete due to errors
const config = {
  CHANNELS_URL: argv['channels-url'],
  CHANNELS_PORT: argv['channels-port'],
  ENCODERS: (argv['encoder'] || []).map(encoder => ({
    url: encoder.url,
    channel: encoder.channel,
    width: encoder.width,
    height: encoder.height,
    audioDevice: encoder.audioDevice
  })),
  CH4C_PORT: argv['ch4c-port'],
  DATA_DIR: argv['data-dir'],
  ENABLE_PAUSE_MONITOR: argv['enable-pause-monitor'],
  PAUSE_MONITOR_INTERVAL: argv['pause-monitor-interval']
};

console.log('Current configuration:');
console.log(JSON.stringify(config, null, 2));

//export default config;

const CHANNELS_URL = config.CHANNELS_URL;
const CHANNELS_PORT = config.CHANNELS_PORT;
const ENCODERS = config.ENCODERS;
const CH4C_PORT = config.CH4C_PORT;
const DATA_DIR = config.DATA_DIR;

// retries and wait durations for retrying to load and play video
const FIND_VIDEO_RETRIES = 6
const FIND_VIDEO_WAIT = 2        // seconds
const PLAY_VIDEO_RETRIES = 6
const PLAY_VIDEO_WAIT = 5        // seconds
const FULL_SCREEN_WAIT = 3        // seconds

// pause monitor settings - use values from command line arguments
const ENABLE_PAUSE_MONITOR = config.ENABLE_PAUSE_MONITOR
const PAUSE_MONITOR_INTERVAL = config.PAUSE_MONITOR_INTERVAL

// path to create recording jobs on Channels
const CHANNELS_POST_URL = `${CHANNELS_URL}:${CHANNELS_PORT}/dvr/jobs/new`

const START_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CH4C - Chrome HDMI for Channels</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 1000px;
            width: 100%;
            margin: 0 auto;
            padding: 40px;
        }

        .header {
            text-align: center;
            margin-bottom: 32px;
        }

        .header h1 {
            color: #2d3748;
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 8px;
        }

        .header p {
            color: #718096;
            font-size: 14px;
        }

        .quick-links {
            display: flex;
            gap: 12px;
            margin-bottom: 32px;
            flex-wrap: wrap;
        }

        .quick-link {
            flex: 1;
            min-width: 150px;
            padding: 16px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 8px;
            text-align: center;
            font-weight: 600;
            transition: all 0.3s ease;
        }

        .quick-link:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.4);
        }

        .section {
            margin-bottom: 32px;
        }

        .section-title {
            color: #2d3748;
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 16px;
            padding-bottom: 8px;
            border-bottom: 2px solid #e2e8f0;
        }

        .status-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }

        .status-card {
            padding: 16px;
            background: #f7fafc;
            border-radius: 8px;
            border-left: 4px solid #cbd5e0;
        }

        .status-card.healthy {
            border-left-color: #48bb78;
            background: #f0fff4;
        }

        .status-card.unhealthy {
            border-left-color: #f56565;
            background: #fff5f5;
        }

        .status-card h3 {
            color: #2d3748;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 8px;
        }

        .status-card p {
            color: #4a5568;
            font-size: 13px;
            margin: 4px 0;
        }

        .status-badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            margin-top: 8px;
        }

        .status-badge.healthy {
            background: #48bb78;
            color: white;
        }

        .status-badge.unhealthy {
            background: #f56565;
            color: white;
        }

        .audio-device {
            padding: 12px;
            background: #f7fafc;
            border-radius: 6px;
            margin-bottom: 8px;
            font-size: 13px;
            color: #2d3748;
            font-family: 'Monaco', 'Courier New', monospace;
        }

        .code-block {
            background: #2d3748;
            color: #e2e8f0;
            padding: 20px;
            border-radius: 8px;
            overflow-x: auto;
            font-size: 13px;
            line-height: 1.6;
            font-family: 'Monaco', 'Courier New', monospace;
            white-space: pre-wrap;
        }

        .info-box {
            background: #edf2f7;
            border-left: 4px solid #667eea;
            padding: 16px;
            border-radius: 4px;
            margin-top: 16px;
        }

        .info-box p {
            color: #4a5568;
            font-size: 13px;
            line-height: 1.6;
            margin: 8px 0;
        }

        .info-box strong {
            color: #2d3748;
        }

        .info-box code {
            background: white;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 12px;
            color: #667eea;
        }

        @media (max-width: 768px) {
            .container {
                padding: 24px;
            }

            .header h1 {
                font-size: 24px;
            }

            .quick-links {
                flex-direction: column;
            }

            .status-grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Chrome HDMI for Channels</h1>
            <p>Web Streaming via External HDMI Encoders</p>
        </div>

        <div class="quick-links">
            <a href="/instant" class="quick-link">📺 Instant Recording</a>
            <a href="/m3u-manager" class="quick-link">📋 M3U Manager</a>
            <a href="https://github.com/dravenst/CH4C#readme" target="_blank" class="quick-link">📖 Documentation</a>
        </div>

        <div class="section">
            <h2 class="section-title">Encoder Status</h2>
            <div class="status-grid" id="encoder-status">
                <div class="status-card">
                    <p style="color: #718096;">Loading encoder status...</p>
                </div>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">Available Audio Devices</h2>
            <div id="audio-devices">
                <p style="color: #718096;">Loading audio devices...</p>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">Command Line Reference</h2>

            <div class="info-box">
                <p><strong>Usage:</strong> <code>node main.js [options]</code></p>
            </div>

            <div class="code-block">Options:
  -s, --channels-url            Channels server URL
                                [string] [required]

  -p, --channels-port           Channels server port
                                [string] [default: "8089"]

  -e, --encoder                 Encoder configurations in format
                                "url[:channel:width_pos:height_pos:audio_device]"
                                where channel is optional (format: xx.xx, default: 24.42),
                                width_pos/height_pos are optional screen positions (default: 0:0),
                                and audio_device is the optional audio output device name
                                [array] [required]

  -c, --ch4c-port               CH4C port number
                                [number] [default: 2442]

  -m, --enable-pause-monitor    Enable automatic video pause detection and resume
                                [boolean] [default: true]

  -i, --pause-monitor-interval  Interval in seconds to check for paused video
                                [number] [default: 10]</div>

            <div class="info-box" style="margin-top: 24px;">
                <p><strong>Simple setup with single encoder:</strong></p>
                <p>Replace <code>CHANNELS_DVR_IP</code> with your Channels DVR server IP and <code>ENCODER_IP_ADDRESS</code> with your encoder's IP address.</p>
            </div>
            <div class="code-block">node main.js -s "http://CHANNELS_DVR_IP" -e "http://ENCODER_IP_ADDRESS/live/stream0"</div>

            <div class="info-box" style="margin-top: 16px;">
                <p><strong>Multiple encoders with audio devices and screen positioning:</strong></p>
                <p>Replace the IP addresses and audio device names (<code>Encoder</code>, <code>MACROSILICON</code>) with your actual values. The <code>1921</code> position moves the second encoder window to screen 2 in a dual monitor setup.</p>
            </div>
            <div class="code-block">node main.js -s "http://CHANNELS_DVR_IP" \\
  -e "http://ENCODER_IP_ADDRESS/live/stream0:24.42:0:0:Encoder" \\
  -e "http://ENCODER_IP_ADDRESS/live/stream1:24.43:1921:0:MACROSILICON"</div>
        </div>

        <div class="section">
            <h2 class="section-title">Sample M3U Configuration</h2>
            <div class="info-box">
                <p>Create a custom channel source in Channels DVR using an M3U playlist.</p>
                <p><strong>CH4C Server:</strong> <code id="ch4c-ip-display">Detecting...</code>:<code>${CH4C_PORT}</code></p>
                <p><strong>Encoder:</strong> <code>${ENCODERS[0]?.url || 'Not configured'}</code> (Channel ${ENCODERS[0]?.channel || '24.42'})</p>
                <p style="margin-top: 8px; font-size: 12px; color: #718096;">The CH4C server address is auto-detected. If incorrect, replace it in the M3U below.</p>
                <p style="margin-top: 8px;"><strong>More examples:</strong> <a href="https://github.com/dravenst/CH4C/blob/main/assets/samples.m3u" target="_blank" style="color: #667eea; text-decoration: underline;">View additional M3U samples on GitHub</a></p>
            </div>
            <div class="code-block" id="m3u-config">#EXTM3U

#EXTINF:-1 channel-id="CH4C_Encoder" channel-number="${ENCODERS[0]?.channel || '24.42'}" tvc-guide-placeholders="3600",CH4C Encoder
${ENCODERS[0]?.url || 'http://ENCODER_IP_ADDRESS/live/stream0'}

#EXTINF:-1 channel-id="CH4C_Weather" channel-number="24.1" tvc-guide-placeholders="3600",Weatherscan
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://weatherscan.net/

#EXTINF:-1 channel-id="CH4C_NFL_Network" channel-number="24.2",NFL Network
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nfl.com/network/watch/nfl-network-live

#EXTINF:-1 channel-id="CH4C_NatGeo" channel-number="24.3",National Geographic
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nationalgeographic.com/tv/watch-live/

#EXTINF:-1 channel-id="CH4C_Disney" channel-number="24.4",Disney Channel
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://disneynow.com/watch-live?brand=004

#EXTINF:-1 channel-id="CH4C_NBC" channel-number="24.5",NBC Live
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nbc.com/live

#EXTINF:-1 channel-id="Hallmark",Hallmark
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream/?url=https://www.peacocktv.com/deeplink?deeplinkData=%7B%22serviceKey%22%3A%224846937553519166117%22%2C%22type%22%3A%22LINEAR_CHANNEL%22%2C%22action%22%3A%22PLAY%22%7D

#EXTINF:-1 channel-id="BTN" tvc-guide-stationid="403557" channel-number="6199",BTN
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://watch.sling.com/1/channel/0984387944df47b58a687d60babc2c43/watch

#EXTINF:-1 channel-id="CH4C_Spectrum" channel-number="24.8",Spectrum
http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.spectrum.net/livetv</div>
        </div>
    </div>

    <script>
        // Fetch and display encoder health status
        async function loadEncoderStatus() {
            try {
                const response = await fetch('/health');
                const data = await response.json();

                const container = document.getElementById('encoder-status');
                container.innerHTML = '';

                if (data.encoders && data.encoders.length > 0) {
                    data.encoders.forEach(encoder => {
                        const isHealthy = encoder.isHealthy && encoder.hasBrowser && encoder.isAvailable;
                        const card = document.createElement('div');
                        card.className = 'status-card ' + (isHealthy ? 'healthy' : 'unhealthy');

                        let statusText = isHealthy ? 'Healthy & Available' : 'Unavailable';
                        if (!encoder.hasBrowser) statusText = 'No Browser';
                        else if (!encoder.isAvailable) statusText = 'In Use';
                        else if (!encoder.isHealthy) statusText = 'Unhealthy';

                        card.innerHTML = \`
                            <h3>Channel \${encoder.channel}</h3>
                            <p><strong>URL:</strong> \${encoder.url}</p>
                            <p><strong>Audio Device:</strong> \${encoder.audioDevice || 'Not configured'}</p>
                            <span class="status-badge \${isHealthy ? 'healthy' : 'unhealthy'}">\${statusText}</span>
                        \`;
                        container.appendChild(card);
                    });

                    // Show active streams if any
                    if (data.activeStreams && data.activeStreams.length > 0) {
                        const activeSection = document.createElement('div');
                        activeSection.style.gridColumn = '1 / -1';
                        activeSection.style.marginTop = '16px';
                        activeSection.innerHTML = '<h3 style="color: #2d3748; font-size: 16px; margin-bottom: 12px;">Active Streams:</h3>';

                        data.activeStreams.forEach(stream => {
                            const uptimeMinutes = Math.floor(stream.uptime / 60000);
                            activeSection.innerHTML += \`
                                <div class="info-box" style="margin-bottom: 8px;">
                                    <p><strong>\${stream.url}</strong> - Uptime: \${uptimeMinutes} minutes</p>
                                </div>
                            \`;
                        });
                        container.appendChild(activeSection);
                    }
                } else {
                    container.innerHTML = '<p style="color: #718096;">No encoders configured.</p>';
                }
            } catch (error) {
                console.error('Error loading encoder status:', error);
                document.getElementById('encoder-status').innerHTML =
                    '<p style="color: #f56565;">Error loading encoder status. Ensure CH4C is running properly.</p>';
            }
        }

        // Fetch and display audio devices
        async function loadAudioDevices() {
            try {
                const response = await fetch('/audio-devices');
                const devices = await response.json();

                const container = document.getElementById('audio-devices');
                container.innerHTML = '';

                if (devices && devices.length > 0) {
                    devices.forEach((device, index) => {
                        const div = document.createElement('div');
                        div.className = 'audio-device';
                        div.textContent = \`\${index + 1}. \${device}\`;
                        container.appendChild(div);
                    });
                } else {
                    container.innerHTML = '<p style="color: #718096;">No audio devices found.</p>';
                }
            } catch (error) {
                console.error('Error loading audio devices:', error);
                document.getElementById('audio-devices').innerHTML =
                    '<p style="color: #f56565;">Error loading audio devices.</p>';
            }
        }

        // Replace CH4C_IP_ADDRESS placeholder with actual hostname
        function updateM3UConfig() {
            const ch4cAddress = window.location.hostname;

            // Update the display in the info box
            const ipDisplay = document.getElementById('ch4c-ip-display');
            if (ipDisplay) {
                ipDisplay.textContent = ch4cAddress;
            }

            // Update the custom URL prefix in Add Custom Channel modal
            const customUrlPrefix = document.getElementById('customUrlPrefix');
            if (customUrlPrefix) {
                customUrlPrefix.textContent = ch4cAddress;
            }

            // Update the M3U config block
            const m3uBlock = document.getElementById('m3u-config');
            if (m3uBlock) {
                const currentText = m3uBlock.textContent;
                const updatedText = currentText.replace(/CH4C_IP_ADDRESS/g, ch4cAddress);
                m3uBlock.textContent = updatedText;
            }
        }

        // Load data on page load
        loadEncoderStatus();
        loadAudioDevices();
        updateM3UConfig();

        // Refresh status every 30 seconds
        setInterval(loadEncoderStatus, 30000);
    </script>
</body>
</html>
`

const INSTANT_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CH4C - Instant Recording</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }

        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 600px;
            width: 100%;
            padding: 40px;
        }

        .header {
            text-align: center;
            margin-bottom: 32px;
        }

        .header h1 {
            color: #2d3748;
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 8px;
        }

        .header p {
            color: #718096;
            font-size: 14px;
        }

        .form-group {
            margin-bottom: 24px;
        }

        .form-group label {
            display: block;
            color: #2d3748;
            font-weight: 600;
            font-size: 14px;
            margin-bottom: 8px;
        }

        .form-group .label-hint {
            color: #a0aec0;
            font-weight: 400;
            font-size: 12px;
            margin-left: 4px;
        }

        .form-group input[type="text"],
        .form-group input[type="number"] {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 14px;
            transition: all 0.3s ease;
            font-family: inherit;
        }

        .form-group input[type="text"]:focus,
        .form-group input[type="number"]:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .form-group input::placeholder {
            color: #cbd5e0;
        }

        .button-group {
            display: flex;
            gap: 12px;
            margin-top: 32px;
        }

        .btn {
            flex: 1;
            padding: 14px 24px;
            border: none;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            font-family: inherit;
        }

        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.4);
        }

        .btn-secondary {
            background: white;
            color: #667eea;
            border: 2px solid #667eea;
        }

        .btn-secondary:hover {
            background: #f7fafc;
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.2);
        }

        .btn:active {
            transform: translateY(0);
        }

        .info-box {
            background: #edf2f7;
            border-left: 4px solid #667eea;
            padding: 12px 16px;
            border-radius: 4px;
            margin-top: 24px;
        }

        .info-box p {
            color: #4a5568;
            font-size: 13px;
            line-height: 1.6;
        }

        .info-box strong {
            color: #2d3748;
        }

        @media (max-width: 640px) {
            .container {
                padding: 24px;
            }

            .button-group {
                flex-direction: column;
            }

            .header h1 {
                font-size: 24px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎬 Instant Recording</h1>
            <p>Chrome HDMI for Channels</p>
            <p style="margin-top: 12px;"><a href="/" style="color: #667eea; text-decoration: none; font-size: 14px;">← Back to Home</a></p>
        </div>

        <form method="POST" action="/instant">
            <div class="form-group">
                <label>
                    Recording Name
                    <span class="label-hint">(optional)</span>
                </label>
                <input
                    type="text"
                    name="recording_name"
                    id="recording_name"
                    placeholder="e.g., NFL Game, Concert Stream"
                />
            </div>

            <div class="form-group">
                <label>
                    URL to Stream
                    <span class="label-hint">*</span>
                </label>
                <input
                    type="text"
                    name="recording_url"
                    id="recording_url"
                    placeholder="https://example.com/stream"
                    required
                />
            </div>

            <div class="form-group">
                <label>
                    Duration (minutes)
                    <span class="label-hint">* required for recording, optional for tuning</span>
                </label>
                <input
                    type="number"
                    name="recording_duration"
                    id="recording_duration"
                    placeholder="60"
                    min="1"
                    step="1"
                />
            </div>

            <div class="button-group">
                <button type="submit" name="button_record" value="Start Recording" class="btn btn-primary">
                    📹 Start Recording
                </button>
                <button type="submit" name="button_tune" value="Tune" class="btn btn-secondary">
                    📺 Tune to Channel ${ENCODERS[0]?.channel || '24.42'}
                </button>
            </div>

            <div class="info-box">
                <p>
                    <strong>📹 Start Recording:</strong> Creates a scheduled recording in Channels DVR and begins streaming the URL.<br>
                    <strong>📺 Tune to Channel:</strong> Simply loads the URL on an available encoder without recording. The stream will be available on the encoder's channel number in Channels DVR. Optional: specify duration for auto-stop, or leave blank for indefinite streaming.
                </p>
                <p style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #cbd5e0;">
                    <strong>Need to stop a stream?</strong> Visit <a href="/stop" style="color: #667eea; text-decoration: underline;">/stop</a> to stop all active streams.
                </p>
            </div>
        </form>
    </div>

    <script>
        // Make duration required only when recording
        const form = document.querySelector('form');
        const durationInput = document.getElementById('recording_duration');

        form.addEventListener('submit', function(e) {
            const submitButton = e.submitter;

            if (submitButton && submitButton.name === 'button_record') {
                // Recording requires duration
                if (!durationInput.value || parseInt(durationInput.value) <= 0) {
                    e.preventDefault();
                    alert('Duration is required when starting a recording.');
                    durationInput.focus();
                }
            }
        });
    </script>
</body>
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

const M3U_MANAGER_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CH4C M3U Manager</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 1400px;
            width: 100%;
            margin: 0 auto;
            padding: 40px;
        }

        .header {
            text-align: center;
            margin-bottom: 32px;
        }

        .header h1 {
            color: #2d3748;
            font-size: 32px;
            font-weight: 700;
            margin-bottom: 8px;
        }

        .header p {
            color: #718096;
            font-size: 14px;
        }

        .header .back-link {
            display: inline-block;
            margin-top: 12px;
            color: #667eea;
            text-decoration: none;
            font-size: 14px;
        }

        .header .back-link:hover {
            text-decoration: underline;
        }

        .actions-bar {
            display: flex;
            gap: 12px;
            margin-bottom: 24px;
            flex-wrap: wrap;
            align-items: center;
        }

        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .btn-secondary {
            background: white;
            color: #667eea;
            border: 2px solid #667eea;
        }

        .btn-secondary:hover {
            background: #f7fafc;
        }

        .btn-success {
            background: #48bb78;
            color: white;
        }

        .btn-danger {
            background: #f56565;
            color: white;
        }

        .btn-small {
            padding: 6px 12px;
            font-size: 12px;
        }

        .service-tabs {
            display: flex;
            gap: 8px;
            margin-bottom: 24px;
            border-bottom: 2px solid #e2e8f0;
        }

        .tab {
            padding: 12px 24px;
            background: transparent;
            border: none;
            border-bottom: 3px solid transparent;
            color: #718096;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
        }

        .tab:hover {
            color: #667eea;
        }

        .tab.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }

        .m3u-url-box {
            background: #edf2f7;
            padding: 12px;
            border-radius: 6px;
            margin-bottom: 24px;
            display: flex;
            align-items: center;
            gap: 12px;
        }

        .m3u-url-box input {
            flex: 1;
            padding: 8px;
            border: 1px solid #cbd5e0;
            border-radius: 4px;
            font-family: monospace;
            font-size: 13px;
        }

        .table-container {
            overflow-x: auto;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 24px;
        }

        th {
            background: #f7fafc;
            padding: 12px;
            text-align: left;
            font-size: 13px;
            font-weight: 600;
            color: #2d3748;
            border-bottom: 2px solid #e2e8f0;
        }

        th.sortable {
            cursor: pointer;
            user-select: none;
            position: relative;
            padding-right: 24px;
        }

        th.sortable:hover {
            background: #edf2f7;
        }

        th.sortable::after {
            content: '⇅';
            position: absolute;
            right: 8px;
            opacity: 0.3;
        }

        th.sortable.sort-asc::after {
            content: '↑';
            opacity: 1;
        }

        th.sortable.sort-desc::after {
            content: '↓';
            opacity: 1;
        }

        td {
            padding: 12px;
            border-bottom: 1px solid #e2e8f0;
            font-size: 14px;
            color: #4a5568;
        }

        tr:hover {
            background: #f7fafc;
        }

        .channel-logo {
            width: 60px;
            height: 40px;
            object-fit: contain;
        }

        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-weight: 600;
        }

        .badge-sports { background: #bee3f8; color: #2c5282; }
        .badge-news { background: #fed7d7; color: #742a2a; }
        .badge-movies { background: #feebc8; color: #7c2d12; }
        .badge-drama { background: #c6f6d5; color: #22543d; }
        .badge-children { background: #faf089; color: #744210; }
        .badge-kids { background: #faf089; color: #744210; }
        .badge-entertainment { background: #c6f6d5; color: #22543d; }
        .badge-other { background: #e2e8f0; color: #2d3748; }

        .toggle-switch {
            position: relative;
            display: inline-block;
            width: 48px;
            height: 24px;
        }

        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #cbd5e0;
            transition: .4s;
            border-radius: 24px;
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 18px;
            width: 18px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: .4s;
            border-radius: 50%;
        }

        input:checked + .slider {
            background-color: #48bb78;
        }

        input:checked + .slider:before {
            transform: translateX(24px);
        }

        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
        }

        .modal-content {
            background-color: white;
            margin: 5% auto;
            padding: 32px;
            border-radius: 16px;
            max-width: 600px;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }

        .modal-content h2 {
            margin-bottom: 24px;
            color: #2d3748;
        }

        .form-group {
            margin-bottom: 20px;
        }

        .form-group label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #2d3748;
            font-size: 14px;
        }

        .form-group input,
        .form-group select {
            width: 100%;
            padding: 10px 12px;
            border: 2px solid #e2e8f0;
            border-radius: 6px;
            font-size: 14px;
        }

        .form-group input:focus,
        .form-group select:focus {
            outline: none;
            border-color: #667eea;
        }

        .modal-actions {
            display: flex;
            gap: 12px;
            margin-top: 24px;
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #718096;
        }

        .empty-state h3 {
            font-size: 20px;
            margin-bottom: 8px;
        }

        .loading {
            text-align: center;
            padding: 40px;
            color: #718096;
        }

        @media (max-width: 768px) {
            .container {
                padding: 20px;
            }

            .actions-bar {
                flex-direction: column;
            }

            table {
                font-size: 12px;
            }

            th, td {
                padding: 8px;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📋 CH4C M3U Manager</h1>
            <p>Manage channels from multiple streaming services and create custom M3U playlists</p>
            <a href="/" class="back-link">← Back to Home</a>
        </div>

        <div class="m3u-url-box">
            <strong>M3U Playlist URL:</strong>
            <input type="text" id="m3uUrl" readonly value="http://<<host>>/m3u-manager/playlist.m3u">
            <button class="btn btn-secondary btn-small" onclick="copyM3UUrl()">📋 Copy</button>
            <button class="btn btn-secondary btn-small" onclick="previewM3U()">👁️ Preview</button>
            <a href="/m3u-manager/playlist.m3u" download class="btn btn-success btn-small">⬇️ Download</a>
        </div>

        <div class="service-tabs">
            <button class="tab active" data-service="all" onclick="switchTab('all')">All Channels</button>
            <button class="tab" data-service="sling" onclick="switchTab('sling')">Sling TV</button>
            <button class="tab" data-service="custom" onclick="switchTab('custom')">Custom Entries</button>
        </div>

        <div class="actions-bar" style="align-items: flex-start;">
            <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start; min-height: 54px;">
                <button class="btn btn-primary" onclick="showAddCustomModal()">➕ Add Custom Channel</button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 4px; align-items: flex-start; min-height: 54px;">
                <button class="btn btn-primary" onclick="refreshService('sling')">🔄 Refresh Sling TV</button>
                <span style="font-size: 11px; color: #718096;">Last Updated: <span id="lastUpdate">Never</span></span>
            </div>
            <label style="display: flex; align-items: center; gap: 8px; margin-left: auto; cursor: pointer; user-select: none;">
                <input type="checkbox" id="showEnabledOnly" onchange="toggleEnabledFilter()" style="width: auto; cursor: pointer;">
                <span style="font-size: 14px; color: #2d3748; font-weight: 600;">Show Enabled Only</span>
            </label>
        </div>

        <div class="table-container">
            <table id="channelsTable">
                <thead>
                    <tr>
                        <th>Enabled</th>
                        <th class="sortable" onclick="sortChannels('channelNumber')">Channel #</th>
                        <th>Logo</th>
                        <th class="sortable" onclick="sortChannels('name')">Name</th>
                        <th class="sortable" onclick="sortChannels('service')">Service</th>
                        <th class="sortable" onclick="sortChannels('category')">Genre</th>
                        <th class="sortable" onclick="sortChannels('epg')">Station ID</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody id="channelsBody">
                    <tr>
                        <td colspan="8" class="loading">Loading channels...</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- Add Custom Channel Modal -->
    <div id="addCustomModal" class="modal">
        <div class="modal-content">
            <h2>Add Custom Channel</h2>
            <form id="customChannelForm">
                <div class="form-group">
                    <label>Channel Name *</label>
                    <input type="text" id="customName" required placeholder="e.g., NFL Network">
                </div>
                <div class="form-group">
                    <label>Stream URL *</label>
                    <input type="text" id="customUrl" required placeholder="https://watch.sling.com/1/channel/...">
                    <small style="color: #718096; font-size: 12px; display: block; margin-top: 4px;">
                        Will be prepended with: <code style="background: #f7fafc; padding: 2px 6px; border-radius: 3px; font-size: 11px;">http://<span id="customUrlPrefix">detecting...</span>:${CH4C_PORT}/stream?url=</code>
                    </small>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
                    <div class="form-group" style="margin: 0;">
                        <label>Channel Number</label>
                        <input type="text" id="customNumber" placeholder="Auto-assigned if blank">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label>Genre</label>
                        <select id="customCategory">
                            <option value="Sports">Sports</option>
                            <option value="News">News</option>
                            <option value="Movies">Movies</option>
                            <option value="Drama">Drama</option>
                            <option value="Children">Children</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                </div>
                <div class="form-group" style="margin-bottom: 16px;">
                    <div style="display: grid; grid-template-columns: 140px 1fr 1fr auto; gap: 8px; align-items: start;">
                        <div>
                            <label style="display: block; margin-bottom: 4px;">EPG Mode</label>
                            <select id="customEpgMode" onchange="toggleEpgMode()" style="width: 100%;">
                                <option value="stationId">Station ID</option>
                                <option value="placeholder">Placeholder</option>
                            </select>
                        </div>
                        <div id="customStationIdField">
                            <label style="display: block; margin-bottom: 4px;">Station ID</label>
                            <input type="text" id="customStationId" placeholder="Optional Station ID">
                        </div>
                        <div id="customCallSignField">
                            <label style="display: block; margin-bottom: 4px;">Callsign</label>
                            <input type="text" id="customCallSign" placeholder="e.g., ESPN, AETV">
                        </div>
                        <div id="customDurationField" style="display: none; grid-column: 2 / 4;">
                            <label style="display: block; margin-bottom: 4px;">Duration (minutes)</label>
                            <input type="number" id="customDuration" placeholder="e.g., 180" min="1" max="1440" value="180">
                            <small style="color: #718096; font-size: 12px; display: block; margin-top: 4px;">Guide will show placeholders at this interval.</small>
                        </div>
                        <button type="button" class="btn btn-secondary" id="customLookupButton" onclick="showStationLookupModal('add')" style="white-space: nowrap; align-self: end;">🔍 Lookup</button>
                    </div>
                </div>
                <div class="form-group">
                    <label>Logo URL</label>
                    <input type="text" id="customLogo" placeholder="https://...">
                </div>
                <div class="modal-actions">
                    <button type="submit" class="btn btn-primary">Add Channel</button>
                    <button type="button" class="btn btn-secondary" onclick="closeModal('addCustomModal')">Cancel</button>
                </div>
            </form>
        </div>
    </div>

    <!-- Edit Channel Modal -->
    <div id="editChannelModal" class="modal">
        <div class="modal-content">
            <h2>Edit Channel</h2>
            <form id="editChannelForm">
                <input type="hidden" id="editChannelId">
                <input type="hidden" id="editChannelService">
                <div class="form-group">
                    <label>Channel Name</label>
                    <input type="text" id="editName" readonly style="background: #f7fafc;">
                </div>
                <div class="form-group" id="editStreamUrlGroup" style="display: none;">
                    <label>Stream URL *</label>
                    <input type="text" id="editStreamUrl" placeholder="https://watch.sling.com/1/channel/...">
                    <small style="color: #718096; font-size: 12px; display: block; margin-top: 4px;">
                        Will be prepended with: <code style="background: #f7fafc; padding: 2px 6px; border-radius: 3px; font-size: 11px;">http://<span id="editUrlPrefix">detecting...</span>:${CH4C_PORT}/stream?url=</code>
                    </small>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
                    <div class="form-group" style="margin: 0;">
                        <label>Channel Number</label>
                        <input type="text" id="editNumber" placeholder="Auto-assigned if blank">
                    </div>
                    <div class="form-group" style="margin: 0;">
                        <label>Genre</label>
                        <select id="editCategory">
                            <option value="Sports">Sports</option>
                            <option value="News">News</option>
                            <option value="Movies">Movies</option>
                            <option value="Drama">Drama</option>
                            <option value="Children">Children</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                </div>
                <div class="form-group" style="margin-bottom: 16px;">
                    <div style="display: grid; grid-template-columns: 140px 1fr 1fr auto; gap: 8px; align-items: start;">
                        <div>
                            <label style="display: block; margin-bottom: 4px;">EPG Mode</label>
                            <select id="editEpgMode" onchange="toggleEditEpgMode()" style="width: 100%;">
                                <option value="stationId">Station ID</option>
                                <option value="placeholder">Placeholder</option>
                            </select>
                        </div>
                        <div id="editStationIdField">
                            <label style="display: block; margin-bottom: 4px;">Station ID</label>
                            <input type="text" id="editStationId" placeholder="Optional Station ID">
                        </div>
                        <div id="editCallSignField">
                            <label style="display: block; margin-bottom: 4px;">Callsign</label>
                            <input type="text" id="editCallSign" placeholder="e.g., ESPN, AETV">
                        </div>
                        <div id="editDurationField" style="display: none; grid-column: 2 / 4;">
                            <label style="display: block; margin-bottom: 4px;">Duration (minutes)</label>
                            <input type="number" id="editDuration" placeholder="e.g., 180" min="1" max="1440" value="180">
                            <small style="color: #718096; font-size: 12px; display: block; margin-top: 4px;">Guide will show placeholders at this interval.</small>
                        </div>
                        <button type="button" class="btn btn-secondary" id="editLookupButton" onclick="showStationLookupModal('edit')" style="white-space: nowrap; align-self: end;">🔍 Lookup</button>
                    </div>
                </div>
                <div class="form-group">
                    <label>Logo URL</label>
                    <input type="text" id="editLogo" placeholder="https://...">
                </div>
                <div class="modal-actions">
                    <button type="submit" class="btn btn-primary">Save Changes</button>
                    <button type="button" class="btn btn-secondary" onclick="closeModal('editChannelModal')">Cancel</button>
                </div>
            </form>
        </div>
    </div>

    <!-- Refresh Service Modal -->
    <div id="refreshServiceModal" class="modal">
        <div class="modal-content">
            <h2>Refresh Service</h2>
            <p style="margin-bottom: 20px; color: #4a5568;">Refresh channels from <strong id="refreshServiceName"></strong></p>
            <div class="form-group">
                <label style="display: flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="refreshResetEdits" style="width: auto; margin-right: 8px;">
                    <span>Reset all manual edits (channel numbers, categories, logos, etc.)</span>
                </label>
                <small style="color: #718096; font-size: 12px; display: block; margin-top: 8px; margin-left: 24px;">
                    If unchecked, your manual edits will be preserved. If checked, all channels will be reset to default values from Channels DVR.
                </small>
            </div>
            <div id="slingOptionsGroup" class="form-group" style="display: none; margin-top: 16px;">
                <label style="display: flex; align-items: center; cursor: pointer;">
                    <input type="checkbox" id="refreshFavoritesOnly" checked style="width: auto; margin-right: 8px;">
                    <span>Favorites Only</span>
                </label>
                <small style="color: #718096; font-size: 12px; display: block; margin-top: 8px; margin-left: 24px;">
                    If checked, only your favorite channels will be imported. If unchecked, all available Sling TV channels will be imported.
                </small>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-primary" onclick="confirmRefresh()">Refresh</button>
                <button type="button" class="btn btn-secondary" onclick="closeModal('refreshServiceModal')">Cancel</button>
            </div>
        </div>
    </div>

    <!-- M3U Preview Modal -->
    <div id="previewM3UModal" class="modal">
        <div class="modal-content" style="max-width: 800px;">
            <h2>M3U Playlist Preview</h2>
            <div style="margin-bottom: 16px;">
                <textarea id="m3uPreviewText" readonly style="width: 100%; height: 400px; font-family: 'Courier New', monospace; font-size: 12px; padding: 12px; border: 2px solid #e2e8f0; border-radius: 6px; resize: vertical; background: #f7fafc;"></textarea>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="copyM3UPreview()">📋 Copy to Clipboard</button>
                <button type="button" class="btn btn-secondary" onclick="closeModal('previewM3UModal')">Close</button>
            </div>
        </div>
    </div>

    <!-- Loading Modal -->
    <div id="loadingModal" class="modal">
        <div class="modal-content" style="max-width: 400px; text-align: center;">
            <div id="loadingSpinnerContainer" style="margin: 24px 0;">
                <div class="spinner"></div>
            </div>
            <div id="loadingCompleteContainer" style="margin: 24px 0; display: none;">
                <div style="font-size: 48px; color: #48bb78;">✓</div>
            </div>
            <h2 id="loadingModalTitle" style="margin: 16px 0 8px 0;">Loading...</h2>
            <p id="loadingModalMessage" style="color: #718096; margin: 0;">Please wait while we fetch channel data.</p>
            <div id="loadingModalActions" style="margin-top: 24px; display: none;">
                <button type="button" class="btn btn-primary" onclick="closeModal('loadingModal')">Close</button>
            </div>
        </div>
    </div>

    <!-- Station Lookup Modal -->
    <div id="stationLookupModal" class="modal">
        <div class="modal-content" style="max-width: 600px;">
            <h2>Station Lookup</h2>
            <div class="form-group">
                <label>Search for Station:</label>
                <div style="display: flex; gap: 8px;">
                    <input type="text" id="lookupSearchInput" placeholder="Try different name (e.g., AETV for A&E)" style="flex: 1;" onkeypress="if(event.key==='Enter'){event.preventDefault();performStationLookup();}">
                    <button type="button" class="btn btn-secondary" onclick="performStationLookup()" style="white-space: nowrap;">🔍 Search</button>
                </div>
                <div id="lookupSearchResults" style="margin-top: 12px; display: none;"></div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn btn-secondary" onclick="closeModal('stationLookupModal')">Cancel</button>
            </div>
        </div>
    </div>

    <style>
        .spinner {
            border: 4px solid #e2e8f0;
            border-top: 4px solid #3b82f6;
            border-radius: 50%;
            width: 48px;
            height: 48px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
        }

        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
    </style>

    <script>
        let currentService = 'all';
        let allChannels = [];
        let currentSort = { field: null, direction: 'asc' };
        let showEnabledOnly = false;

        // Load channels on page load
        document.addEventListener('DOMContentLoaded', () => {
            loadChannels();
            loadStatus();
            updateCustomUrlPrefix();
        });

        async function loadChannels() {
            try {
                const response = await fetch('/m3u-manager/channels');
                allChannels = await response.json();
                renderChannels();
            } catch (error) {
                console.error('Error loading channels:', error);
                document.getElementById('channelsBody').innerHTML =
                    '<tr><td colspan="8" class="empty-state"><h3>Error loading channels</h3><p>' + error.message + '</p></td></tr>';
            }
        }

        async function loadStatus() {
            try {
                const response = await fetch('/m3u-manager/status');
                const status = await response.json();

                document.getElementById('lastUpdate').textContent = status.lastUpdate
                    ? new Date(status.lastUpdate).toLocaleString()
                    : 'Never';
            } catch (error) {
                console.error('Error loading status:', error);
            }
        }

        function renderChannels() {
            const tbody = document.getElementById('channelsBody');
            let filtered = currentService === 'all'
                ? allChannels
                : allChannels.filter(ch => ch.service === currentService);

            // Apply enabled filter if active
            if (showEnabledOnly) {
                filtered = filtered.filter(ch => ch.enabled !== false);
            }

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" class="empty-state"><h3>No channels found</h3><p>Add some channels to get started</p></td></tr>';
                return;
            }

            // Apply sorting if active
            if (currentSort.field) {
                filtered = [...filtered].sort((a, b) => {
                    let aVal, bVal;

                    switch (currentSort.field) {
                        case 'channelNumber':
                            aVal = parseFloat(a.channelNumber) || 9999;
                            bVal = parseFloat(b.channelNumber) || 9999;
                            break;
                        case 'name':
                            aVal = (a.name || '').toLowerCase();
                            bVal = (b.name || '').toLowerCase();
                            break;
                        case 'service':
                            aVal = (a.service || '').toLowerCase();
                            bVal = (b.service || '').toLowerCase();
                            break;
                        case 'category':
                            aVal = (a.category || '').toLowerCase();
                            bVal = (b.category || '').toLowerCase();
                            break;
                        case 'epg':
                            aVal = a.stationId || (a.duration ? \`\${a.duration}min\` : 'zzz');
                            bVal = b.stationId || (b.duration ? \`\${b.duration}min\` : 'zzz');
                            aVal = aVal.toLowerCase();
                            bVal = bVal.toLowerCase();
                            break;
                        default:
                            return 0;
                    }

                    if (aVal < bVal) return currentSort.direction === 'asc' ? -1 : 1;
                    if (aVal > bVal) return currentSort.direction === 'asc' ? 1 : -1;
                    return 0;
                });
            }

            tbody.innerHTML = filtered.map(ch => \`
                <tr>
                    <td>
                        <label class="toggle-switch">
                            <input type="checkbox" \${ch.enabled !== false ? 'checked' : ''} onchange="toggleChannel('\${ch.id}')">
                            <span class="slider"></span>
                        </label>
                    </td>
                    <td>\${ch.channelNumber || 'Auto'}</td>
                    <td>\${ch.logo ? \`<img src="\${ch.logo}" class="channel-logo" onerror="this.style.display='none'">\` : '-'}</td>
                    <td><strong>\${ch.name}</strong></td>
                    <td>\${ch.service}</td>
                    <td><span class="badge badge-\${(ch.category || 'other').toLowerCase()}">\${ch.category || 'Other'}</span></td>
                    <td>\${ch.stationId ? ch.stationId : (ch.duration ? \`\${ch.duration}min placeholder\` : '-')}</td>
                    <td>
                        <button class="btn btn-secondary btn-small" onclick="showEditModal('\${ch.id}')">✏️ Edit</button>
                        \${ch.service === 'custom' && ch.id.startsWith('custom-') ? \`<button class="btn btn-danger btn-small" onclick="deleteChannel('\${ch.id}')">🗑️ Delete</button>\` : ''}
                    </td>
                </tr>
            \`).join('');
        }

        function switchTab(service) {
            currentService = service;
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.service === service);
            });
            renderChannels();
        }

        function toggleEnabledFilter() {
            showEnabledOnly = document.getElementById('showEnabledOnly').checked;
            renderChannels();
        }

        let pendingRefreshService = null;

        function refreshService(serviceName) {
            pendingRefreshService = serviceName;
            document.getElementById('refreshServiceName').textContent = serviceName;
            document.getElementById('refreshResetEdits').checked = false;

            // Show/hide Sling-specific options
            const slingOptionsGroup = document.getElementById('slingOptionsGroup');
            if (serviceName === 'sling') {
                slingOptionsGroup.style.display = 'block';
                document.getElementById('refreshFavoritesOnly').checked = true;
            } else {
                slingOptionsGroup.style.display = 'none';
            }

            document.getElementById('refreshServiceModal').style.display = 'block';
        }

        async function confirmRefresh() {
            if (!pendingRefreshService) return;

            const serviceName = pendingRefreshService;
            const resetEdits = document.getElementById('refreshResetEdits').checked;

            // Get Sling-specific options
            const favoritesOnly = serviceName === 'sling'
                ? document.getElementById('refreshFavoritesOnly').checked
                : true; // Default to true for non-Sling services

            closeModal('refreshServiceModal');

            // Show loading modal
            const serviceDisplayName = serviceName.charAt(0).toUpperCase() + serviceName.slice(1);
            document.getElementById('loadingModalTitle').textContent = 'Refreshing ' + serviceDisplayName + '...';
            document.getElementById('loadingModalMessage').textContent = serviceName === 'sling'
                ? 'Please wait while we scrape channel data from Sling TV guide. This may take a minute.'
                : 'Please wait while we fetch channel data from ' + serviceDisplayName + '.';
            document.getElementById('loadingSpinnerContainer').style.display = 'block';
            document.getElementById('loadingCompleteContainer').style.display = 'none';
            document.getElementById('loadingModalActions').style.display = 'none';
            document.getElementById('loadingModal').style.display = 'block';

            try {
                // Build query string
                const params = new URLSearchParams();
                if (resetEdits) params.append('resetEdits', 'true');
                if (serviceName === 'sling') params.append('favoritesOnly', favoritesOnly);

                const queryString = params.toString();
                const url = \`/m3u-manager/refresh/\${serviceName}\${queryString ? '?' + queryString : ''}\`;
                const response = await fetch(url, { method: 'POST' });
                const result = await response.json();

                // Transform loading modal into completion modal
                document.getElementById('loadingSpinnerContainer').style.display = 'none';
                document.getElementById('loadingCompleteContainer').style.display = 'block';
                document.getElementById('loadingModalTitle').textContent = 'Refresh Complete!';

                let message = 'Successfully refreshed ' + result.channelCount + ' channels from ' + serviceName;
                if (resetEdits) {
                    message += ' (all edits reset)';
                } else {
                    message += ' (edits preserved)';
                }
                if (serviceName === 'sling') {
                    message += favoritesOnly ? '. Favorites only.' : '. All channels.';
                }

                document.getElementById('loadingModalMessage').textContent = message;
                document.getElementById('loadingModalActions').style.display = 'block';

                await loadChannels();
                await loadStatus();
            } catch (error) {
                // Transform loading modal into error modal
                document.getElementById('loadingSpinnerContainer').style.display = 'none';
                document.getElementById('loadingCompleteContainer').innerHTML = '<div style="font-size: 48px; color: #f56565;">✗</div>';
                document.getElementById('loadingCompleteContainer').style.display = 'block';
                document.getElementById('loadingModalTitle').textContent = 'Refresh Failed';
                document.getElementById('loadingModalMessage').textContent = 'Error: ' + error.message;
                document.getElementById('loadingModalActions').style.display = 'block';
            } finally {
                pendingRefreshService = null;
            }
        }

        async function toggleChannel(id) {
            try {
                await fetch(\`/m3u-manager/channels/\${id}/toggle\`, { method: 'PATCH' });
                await loadChannels();
                await loadStatus();
            } catch (error) {
                alert('Error toggling channel: ' + error.message);
            }
        }

        async function deleteChannel(id) {
            if (!confirm('Delete this channel?')) {
                return;
            }

            try {
                await fetch(\`/m3u-manager/channels/\${id}\`, { method: 'DELETE' });
                await loadChannels();
                await loadStatus();
            } catch (error) {
                alert('Error deleting channel: ' + error.message);
            }
        }

        function toggleEpgMode() {
            const mode = document.getElementById('customEpgMode').value;
            const stationIdField = document.getElementById('customStationIdField');
            const callSignField = document.getElementById('customCallSignField');
            const durationField = document.getElementById('customDurationField');
            const lookupButton = document.getElementById('customLookupButton');

            if (mode === 'stationId') {
                stationIdField.style.display = 'block';
                callSignField.style.display = 'block';
                durationField.style.display = 'none';
                lookupButton.style.display = 'block';
            } else {
                stationIdField.style.display = 'none';
                callSignField.style.display = 'none';
                durationField.style.display = 'block';
                lookupButton.style.display = 'none';
                // Clear station ID and callsign when switching to placeholder mode
                document.getElementById('customStationId').value = '';
                document.getElementById('customCallSign').value = '';
            }
        }

        function toggleEditEpgMode() {
            const mode = document.getElementById('editEpgMode').value;
            const stationIdField = document.getElementById('editStationIdField');
            const callSignField = document.getElementById('editCallSignField');
            const durationField = document.getElementById('editDurationField');
            const lookupButton = document.getElementById('editLookupButton');

            if (mode === 'stationId') {
                stationIdField.style.display = 'block';
                callSignField.style.display = 'block';
                durationField.style.display = 'none';
                lookupButton.style.display = 'block';
            } else {
                stationIdField.style.display = 'none';
                callSignField.style.display = 'none';
                durationField.style.display = 'block';
                lookupButton.style.display = 'none';
                // Clear station ID and callsign when switching to placeholder mode
                document.getElementById('editStationId').value = '';
                document.getElementById('editCallSign').value = '';
            }
        }

        function sortChannels(field) {
            // Toggle sort direction if clicking same field
            if (currentSort.field === field) {
                currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.field = field;
                currentSort.direction = 'asc';
            }

            // Update header classes
            document.querySelectorAll('th.sortable').forEach(th => {
                th.classList.remove('sort-asc', 'sort-desc');
            });

            // Find and highlight the active sort column
            const headers = document.querySelectorAll('th.sortable');
            headers.forEach(th => {
                const onclickAttr = th.getAttribute('onclick');
                if (onclickAttr && onclickAttr.includes(field)) {
                    th.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
                }
            });

            renderChannels();
        }

        function showAddCustomModal() {
            document.getElementById('addCustomModal').style.display = 'block';
            toggleEpgMode(); // Initialize visibility
        }

        function showEditModal(id) {
            const channel = allChannels.find(ch => ch.id === id);
            if (!channel) return;

            const nameField = document.getElementById('editName');

            document.getElementById('editChannelId').value = channel.id;
            document.getElementById('editChannelService').value = channel.service;
            nameField.value = channel.name;
            document.getElementById('editNumber').value = channel.channelNumber || '';
            document.getElementById('editCallSign').value = channel.callSign || '';
            document.getElementById('editStationId').value = channel.stationId || '';
            document.getElementById('editDuration').value = channel.duration || 180;
            document.getElementById('editCategory').value = channel.category || 'Drama';
            document.getElementById('editLogo').value = channel.logo || '';

            // Show/hide and populate Stream URL field for custom channels only
            const streamUrlGroup = document.getElementById('editStreamUrlGroup');
            if (channel.service === 'custom') {
                // Show stream URL field for custom channels
                streamUrlGroup.style.display = 'block';

                // Extract the URL without the CH4C wrapper prefix
                const streamUrl = channel.streamUrl || '';
                const ch4cAddress = window.location.hostname;
                const prefix = \`http://\${ch4cAddress}:${CH4C_PORT}/stream?url=\`;

                // Check if URL starts with the prefix and extract the actual URL
                let extractedUrl = streamUrl;
                if (streamUrl.startsWith(prefix)) {
                    extractedUrl = decodeURIComponent(streamUrl.substring(prefix.length));
                }

                document.getElementById('editStreamUrl').value = extractedUrl;

                // Allow editing name for custom channels
                nameField.removeAttribute('readonly');
                nameField.style.background = '';
            } else {
                // Hide stream URL field for non-custom channels
                streamUrlGroup.style.display = 'none';

                // Make name readonly for non-custom channels
                nameField.setAttribute('readonly', 'readonly');
                nameField.style.background = '#f7fafc';
            }

            // Set EPG mode based on whether channel has stationId or duration
            if (channel.stationId) {
                document.getElementById('editEpgMode').value = 'stationId';
            } else {
                document.getElementById('editEpgMode').value = 'placeholder';
            }
            toggleEditEpgMode(); // Update visibility

            document.getElementById('editChannelModal').style.display = 'block';
        }

        function closeModal(modalId) {
            if (modalId) {
                document.getElementById(modalId).style.display = 'none';
            } else {
                // Legacy support - close add modal
                document.getElementById('addCustomModal').style.display = 'none';
            }

            if (modalId === 'addCustomModal') {
                document.getElementById('customChannelForm').reset();
            } else if (modalId === 'editChannelModal') {
                document.getElementById('editChannelForm').reset();
            }
        }

        document.getElementById('customChannelForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const epgMode = document.getElementById('customEpgMode').value;
            const userEnteredUrl = document.getElementById('customUrl').value.trim();

            // Prepend the CH4C stream wrapper URL
            const ch4cAddress = window.location.hostname;
            const fullStreamUrl = \`http://\${ch4cAddress}:${CH4C_PORT}/stream?url=\${encodeURIComponent(userEnteredUrl)}\`;

            const channelData = {
                name: document.getElementById('customName').value,
                streamUrl: fullStreamUrl,
                channelNumber: document.getElementById('customNumber').value || null,
                stationId: epgMode === 'stationId' ? (document.getElementById('customStationId').value || null) : null,
                duration: epgMode === 'placeholder' ? (parseInt(document.getElementById('customDuration').value) || 180) : null,
                category: document.getElementById('customCategory').value,
                logo: document.getElementById('customLogo').value || null,
                callSign: document.getElementById('customCallSign').value || null
            };

            try {
                const response = await fetch('/m3u-manager/custom', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(channelData)
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
                    throw new Error(errorData.error || 'Failed to add channel');
                }

                closeModal('addCustomModal');
                await loadChannels();
                await loadStatus();
                alert('Channel added successfully!');
            } catch (error) {
                console.error('Error adding channel:', error);
                alert('Error adding channel: ' + error.message);
            }
        });

        document.getElementById('editChannelForm').addEventListener('submit', async (e) => {
            e.preventDefault();

            const id = document.getElementById('editChannelId').value;
            const service = document.getElementById('editChannelService').value;
            const epgMode = document.getElementById('editEpgMode').value;
            const nameField = document.getElementById('editName');

            const updates = {
                channelNumber: document.getElementById('editNumber').value || null,
                callSign: document.getElementById('editCallSign').value || null,
                stationId: epgMode === 'stationId' ? (document.getElementById('editStationId').value || null) : null,
                duration: epgMode === 'placeholder' ? (parseInt(document.getElementById('editDuration').value) || 180) : null,
                category: document.getElementById('editCategory').value,
                logo: document.getElementById('editLogo').value || null
            };

            // For custom channels, include name and stream URL
            if (service === 'custom') {
                updates.name = nameField.value;

                // Prepend the CH4C stream wrapper URL to the user-entered URL
                const userEnteredUrl = document.getElementById('editStreamUrl').value.trim();
                const ch4cAddress = window.location.hostname;
                const fullStreamUrl = \`http://\${ch4cAddress}:${CH4C_PORT}/stream?url=\${encodeURIComponent(userEnteredUrl)}\`;
                updates.streamUrl = fullStreamUrl;
            }

            try {
                const response = await fetch(\`/m3u-manager/channels/\${id}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(updates)
                });

                if (!response.ok) {
                    throw new Error('Failed to update channel');
                }

                closeModal('editChannelModal');
                await loadChannels();
                await loadStatus();
            } catch (error) {
                alert('Error updating channel: ' + error.message);
            }
        });

        async function lookupByCallSign() {
            const callSign = document.getElementById('editCallSign').value.trim();

            if (!callSign || callSign.length < 2) {
                alert('Please enter a call sign (at least 2 characters)');
                return;
            }

            try {
                const response = await fetch('/m3u-manager/search-stations?q=' + encodeURIComponent(callSign) + '&limit=1');
                if (!response.ok) {
                    throw new Error('Lookup failed');
                }

                const results = await response.json();

                if (results.length === 0) {
                    alert('No station found for call sign "' + callSign + '". Try a different call sign or use the search box below.');
                    return;
                }

                // Use the best match (first result)
                const station = results[0];

                // Update the fields
                document.getElementById('editStationId').value = station.stationId;
                document.getElementById('editCallSign').value = station.callSign;
                document.getElementById('editLogo').value = station.logo || '';

                // Show confirmation
                alert('Found: ' + station.callSign + ' (Station ID: ' + station.stationId + ')\\nLogo and Station ID have been updated.');
            } catch (error) {
                alert('Error looking up call sign: ' + error.message);
            }
        }

        async function searchStationId() {
            const query = document.getElementById('stationSearchInput').value.trim();
            const resultsDiv = document.getElementById('stationSearchResults');

            if (!query || query.length < 2) {
                resultsDiv.style.display = 'none';
                return;
            }

            try {
                const response = await fetch(\`/m3u-manager/search-stations?q=\${encodeURIComponent(query)}&limit=10\`);
                if (!response.ok) {
                    throw new Error('Search failed');
                }

                const results = await response.json();

                if (results.length === 0) {
                    resultsDiv.innerHTML = '<div style="padding: 12px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; color: #856404; font-size: 13px;">No matching stations found. Try a different name.</div>';
                    resultsDiv.style.display = 'block';
                    return;
                }

                // Build results HTML
                let html = '<div style="background: #f7fafc; border: 1px solid #cbd5e0; border-radius: 4px; max-height: 300px; overflow-y: auto;">';
                html += '<div style="padding: 8px 12px; background: #e2e8f0; border-bottom: 1px solid #cbd5e0; font-weight: 600; font-size: 12px; color: #4a5568;">Search Results (click to select)</div>';

                results.forEach(station => {
                    html += \`
                        <div onclick="selectStation('\${station.stationId}', '\${escapeHtml(station.callSign)}', '\${escapeHtml(station.logo)}', '\${station.channel || ''}')"
                             style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.15s;"
                             onmouseover="this.style.background='#edf2f7'"
                             onmouseout="this.style.background='transparent'">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                \${station.logo ? \`<img src="\${station.logo}" alt="Logo" style="width: 40px; height: 40px; object-fit: contain; border-radius: 4px; background: white; padding: 2px;">\` : '<div style="width: 40px; height: 40px; background: #cbd5e0; border-radius: 4px;"></div>'}
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; font-size: 14px; color: #2d3748;">\${escapeHtml(station.callSign)}</div>
                                    <div style="font-size: 12px; color: #718096; margin-top: 2px;">
                                        Station ID: \${station.stationId}
                                        \${station.channel ? \` • Ch \${station.channel}\` : ''}
                                        \${station.source ? \` • \${station.source}\` : ''}
                                    </div>
                                </div>
                                <div style="font-size: 11px; color: #a0aec0; font-weight: 500;">Score: \${station.matchScore}</div>
                            </div>
                        </div>
                    \`;
                });

                html += '</div>';
                resultsDiv.innerHTML = html;
                resultsDiv.style.display = 'block';

            } catch (error) {
                resultsDiv.innerHTML = '<div style="padding: 12px; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; color: #721c24; font-size: 13px;">Error searching: ' + error.message + '</div>';
                resultsDiv.style.display = 'block';
            }
        }

        function selectStation(stationId, callSign, logo, channelNumber) {
            document.getElementById('editStationId').value = stationId;
            document.getElementById('editCallSign').value = callSign;
            // Always update logo field (even if empty string)
            document.getElementById('editLogo').value = logo || '';
            // Update channel number if provided
            if (channelNumber) {
                document.getElementById('editNumber').value = channelNumber;
            }
            document.getElementById('stationSearchResults').style.display = 'none';
            document.getElementById('stationSearchInput').value = '';

            // Show confirmation
            const resultsDiv = document.getElementById('stationSearchResults');
            resultsDiv.innerHTML = '<div style="padding: 12px; background: #d4edda; border: 1px solid #c3e6cb; border-radius: 4px; color: #155724; font-size: 13px;">✓ Selected: ' + escapeHtml(callSign) + ' (Station ID: ' + stationId + ')</div>';
            resultsDiv.style.display = 'block';
            setTimeout(() => {
                resultsDiv.style.display = 'none';
            }, 3000);
        }

        // Add Custom Channel modal - Lookup by call sign
        async function lookupByCallSignAdd() {
            const callSign = document.getElementById('customCallSign').value.trim();

            if (!callSign || callSign.length < 2) {
                alert('Please enter a call sign (at least 2 characters)');
                return;
            }

            try {
                const response = await fetch('/m3u-manager/search-stations?q=' + encodeURIComponent(callSign) + '&limit=1');
                if (!response.ok) {
                    throw new Error('Lookup failed');
                }

                const results = await response.json();

                if (results.length === 0) {
                    alert('No station found for call sign "' + callSign + '". Try a different call sign or use the search box below.');
                    return;
                }

                // Use the best match (first result)
                const station = results[0];

                // Update the fields
                document.getElementById('customStationId').value = station.stationId;
                document.getElementById('customCallSign').value = station.callSign;
                document.getElementById('customLogo').value = station.logo || '';

                // Show confirmation
                alert('Found: ' + station.callSign + ' (Station ID: ' + station.stationId + ')\\nLogo and Station ID have been updated.');
            } catch (error) {
                alert('Error looking up call sign: ' + error.message);
            }
        }

        // Add Custom Channel modal - Search for station ID
        async function searchStationIdAdd() {
            const query = document.getElementById('customStationSearchInput').value.trim();
            const resultsDiv = document.getElementById('customStationSearchResults');

            if (!query || query.length < 2) {
                resultsDiv.style.display = 'none';
                return;
            }

            try {
                const response = await fetch(\`/m3u-manager/search-stations?q=\${encodeURIComponent(query)}&limit=10\`);
                if (!response.ok) {
                    throw new Error('Search failed');
                }

                const results = await response.json();

                if (results.length === 0) {
                    resultsDiv.innerHTML = '<div style="padding: 12px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; color: #856404; font-size: 13px;">No matching stations found. Try a different name.</div>';
                    resultsDiv.style.display = 'block';
                    return;
                }

                // Build results HTML
                let html = '<div style="background: #f7fafc; border: 1px solid #cbd5e0; border-radius: 4px; max-height: 300px; overflow-y: auto;">';
                html += '<div style="padding: 8px 12px; background: #e2e8f0; border-bottom: 1px solid #cbd5e0; font-weight: 600; font-size: 12px; color: #4a5568;">Search Results (click to select)</div>';

                results.forEach(station => {
                    html += \`
                        <div onclick="selectStationAdd('\${station.stationId}', '\${escapeHtml(station.callSign)}', '\${escapeHtml(station.logo)}', '\${station.channel || ''}')"
                             style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.15s;"
                             onmouseover="this.style.background='#edf2f7'"
                             onmouseout="this.style.background='transparent'">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                \${station.logo ? \`<img src="\${station.logo}" alt="Logo" style="width: 40px; height: 40px; object-fit: contain; border-radius: 4px; background: white; padding: 2px;">\` : '<div style="width: 40px; height: 40px; background: #cbd5e0; border-radius: 4px;"></div>'}
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; font-size: 14px; color: #2d3748;">\${escapeHtml(station.callSign)}</div>
                                    <div style="font-size: 12px; color: #718096; margin-top: 2px;">
                                        Station ID: \${station.stationId}
                                        \${station.channel ? \` • Ch \${station.channel}\` : ''}
                                        \${station.source ? \` • \${station.source}\` : ''}
                                    </div>
                                </div>
                                <div style="font-size: 11px; color: #a0aec0; font-weight: 500;">Score: \${station.matchScore}</div>
                            </div>
                        </div>
                    \`;
                });

                html += '</div>';
                resultsDiv.innerHTML = html;
                resultsDiv.style.display = 'block';

            } catch (error) {
                resultsDiv.innerHTML = '<div style="padding: 12px; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; color: #721c24; font-size: 13px;">Error searching: ' + error.message + '</div>';
                resultsDiv.style.display = 'block';
            }
        }

        // Add Custom Channel modal - Select station from search results
        function selectStationAdd(stationId, callSign, logo, channelNumber) {
            document.getElementById('customStationId').value = stationId;
            document.getElementById('customCallSign').value = callSign;
            // Always update logo field (even if empty string)
            document.getElementById('customLogo').value = logo || '';
            // Update channel number if provided
            if (channelNumber) {
                document.getElementById('customNumber').value = channelNumber;
            }
            document.getElementById('customStationSearchResults').style.display = 'none';
            document.getElementById('customStationSearchInput').value = '';

            // Show confirmation
            const resultsDiv = document.getElementById('customStationSearchResults');
            resultsDiv.innerHTML = '<div style="padding: 12px; background: #d4edda; border: 1px solid #c3e6cb; border-radius: 4px; color: #155724; font-size: 13px;">✓ Selected: ' + escapeHtml(callSign) + ' (Station ID: ' + stationId + ')</div>';
            resultsDiv.style.display = 'block';
            setTimeout(() => {
                resultsDiv.style.display = 'none';
            }, 3000);
        }

        // Station Lookup Modal functions
        let stationLookupContext = 'add'; // Track which modal opened the lookup ('add' or 'edit')

        function showStationLookupModal(context) {
            stationLookupContext = context;
            document.getElementById('lookupSearchInput').value = '';
            document.getElementById('lookupSearchResults').style.display = 'none';
            document.getElementById('lookupSearchResults').innerHTML = '';
            document.getElementById('stationLookupModal').style.display = 'block';
        }

        async function performStationLookup() {
            const query = document.getElementById('lookupSearchInput').value.trim();
            const resultsDiv = document.getElementById('lookupSearchResults');

            if (!query || query.length < 2) {
                resultsDiv.style.display = 'none';
                return;
            }

            try {
                const response = await fetch(\`/m3u-manager/search-stations?q=\${encodeURIComponent(query)}&limit=10\`);
                if (!response.ok) {
                    throw new Error('Search failed');
                }

                const results = await response.json();

                if (results.length === 0) {
                    resultsDiv.innerHTML = '<div style="padding: 12px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 4px; color: #856404; font-size: 13px;">No matching stations found. Try a different name.</div>';
                    resultsDiv.style.display = 'block';
                    return;
                }

                // Build results HTML
                let html = '<div style="background: #f7fafc; border: 1px solid #cbd5e0; border-radius: 4px; max-height: 300px; overflow-y: auto;">';
                html += '<div style="padding: 8px 12px; background: #e2e8f0; border-bottom: 1px solid #cbd5e0; font-weight: 600; font-size: 12px; color: #4a5568;">Search Results (click to select)</div>';

                results.forEach(station => {
                    html += \`
                        <div onclick="selectStationFromLookup('\${station.stationId}', '\${escapeHtml(station.callSign)}', '\${escapeHtml(station.logo)}', '\${station.channel || ''}')"
                             style="padding: 10px 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.15s;"
                             onmouseover="this.style.background='#edf2f7'"
                             onmouseout="this.style.background='transparent'">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                \${station.logo ? \`<img src="\${station.logo}" alt="Logo" style="width: 40px; height: 40px; object-fit: contain; border-radius: 4px; background: white; padding: 2px;">\` : '<div style="width: 40px; height: 40px; background: #cbd5e0; border-radius: 4px;"></div>'}
                                <div style="flex: 1;">
                                    <div style="font-weight: 600; font-size: 14px; color: #2d3748;">\${escapeHtml(station.callSign)}</div>
                                    <div style="font-size: 12px; color: #718096; margin-top: 2px;">
                                        Station ID: \${station.stationId}
                                        \${station.channel ? \` • Ch \${station.channel}\` : ''}
                                        \${station.source ? \` • \${station.source}\` : ''}
                                    </div>
                                </div>
                                <div style="font-size: 11px; color: #a0aec0; font-weight: 500;">Score: \${station.matchScore}</div>
                            </div>
                        </div>
                    \`;
                });

                html += '</div>';
                resultsDiv.innerHTML = html;
                resultsDiv.style.display = 'block';

            } catch (error) {
                resultsDiv.innerHTML = '<div style="padding: 12px; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; color: #721c24; font-size: 13px;">Error searching: ' + error.message + '</div>';
                resultsDiv.style.display = 'block';
            }
        }

        function selectStationFromLookup(stationId, callSign, logo, channelNumber) {
            // Populate the appropriate modal based on context
            if (stationLookupContext === 'add') {
                document.getElementById('customStationId').value = stationId;
                document.getElementById('customCallSign').value = callSign;
                document.getElementById('customLogo').value = logo || '';
                if (channelNumber) {
                    document.getElementById('customNumber').value = channelNumber;
                }
            } else if (stationLookupContext === 'edit') {
                document.getElementById('editStationId').value = stationId;
                document.getElementById('editCallSign').value = callSign;
                document.getElementById('editLogo').value = logo || '';
                if (channelNumber) {
                    document.getElementById('editNumber').value = channelNumber;
                }
            }

            // Close the Station Lookup modal
            closeModal('stationLookupModal');
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function copyM3UUrl() {
            const input = document.getElementById('m3uUrl');
            input.select();
            document.execCommand('copy');
            alert('M3U URL copied to clipboard!');
        }

        function updateCustomUrlPrefix() {
            // Update the custom URL prefix in Add Custom Channel modal and Edit Channel modal
            const ch4cAddress = window.location.hostname;
            const customUrlPrefix = document.getElementById('customUrlPrefix');
            if (customUrlPrefix) {
                customUrlPrefix.textContent = ch4cAddress;
            }
            const editUrlPrefix = document.getElementById('editUrlPrefix');
            if (editUrlPrefix) {
                editUrlPrefix.textContent = ch4cAddress;
            }
        }

        async function previewM3U() {
            try {
                const response = await fetch('/m3u-manager/playlist.m3u');
                const m3uText = await response.text();

                document.getElementById('m3uPreviewText').value = m3uText;
                document.getElementById('previewM3UModal').style.display = 'block';
            } catch (error) {
                alert('Error loading M3U preview: ' + error.message);
            }
        }

        function copyM3UPreview() {
            const textarea = document.getElementById('m3uPreviewText');
            textarea.select();
            document.execCommand('copy');
            alert('M3U content copied to clipboard!');
        }

        // Close modal when clicking outside
        window.onclick = function(event) {
            const addModal = document.getElementById('addCustomModal');
            const editModal = document.getElementById('editChannelModal');
            const refreshModal = document.getElementById('refreshServiceModal');
            const previewModal = document.getElementById('previewM3UModal');
            const lookupModal = document.getElementById('stationLookupModal');

            if (event.target === addModal) {
                closeModal('addCustomModal');
            } else if (event.target === editModal) {
                closeModal('editChannelModal');
            } else if (event.target === refreshModal) {
                closeModal('refreshServiceModal');
            } else if (event.target === previewModal) {
                closeModal('previewM3UModal');
            } else if (event.target === lookupModal) {
                closeModal('stationLookupModal');
            }
        }
    </script>
</body>
</html>
`;

module.exports = {
  CHANNELS_URL: config.CHANNELS_URL,
  CHANNELS_PORT: config.CHANNELS_PORT,
  ENCODERS: config.ENCODERS,
  CH4C_PORT: config.CH4C_PORT,
  DATA_DIR: config.DATA_DIR,
  FIND_VIDEO_RETRIES,
  FIND_VIDEO_WAIT,
  PLAY_VIDEO_RETRIES,
  PLAY_VIDEO_WAIT,
  FULL_SCREEN_WAIT,
  ENABLE_PAUSE_MONITOR,
  PAUSE_MONITOR_INTERVAL,
  CHANNELS_POST_URL,
  START_PAGE_HTML,
  INSTANT_PAGE_HTML,
  M3U_MANAGER_PAGE_HTML,
  CHROME_USERDATA_DIRECTORIES,
  CHROME_EXECUTABLE_DIRECTORIES
};