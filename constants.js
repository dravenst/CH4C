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
  ENABLE_PAUSE_MONITOR,
  PAUSE_MONITOR_INTERVAL,
  CHANNELS_POST_URL,
  START_PAGE_HTML,
  INSTANT_PAGE_HTML,
  CHROME_USERDATA_DIRECTORIES,
  CHROME_EXECUTABLE_DIRECTORIES
};