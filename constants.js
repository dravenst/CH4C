const os = require('os');
const path = require('path');
const fs = require('fs');
const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const { URL } = require('url');
const { logTS } = require('./logger');
const { AudioDeviceManager, DisplayManager } = require('./audio-device-manager');

/**
 * Get data directory from raw CLI args before full yargs parsing.
 * This allows us to find config.json location early.
 * @param {string[]} args - Raw command line arguments
 * @returns {string} - Data directory path
 */
function getDataDirFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Check for --data-dir=value or -d=value
    if (arg.startsWith('--data-dir=')) {
      return arg.split('=')[1];
    }
    if (arg.startsWith('-d=')) {
      return arg.split('=')[1];
    }
    // Check for --data-dir value or -d value
    if ((arg === '--data-dir' || arg === '-d') && args[i + 1]) {
      return args[i + 1];
    }
  }
  return 'data'; // default
}

/**
 * Load configuration from config.json file if it exists.
 * @param {string} configPath - Path to config.json
 * @returns {object|null} - Parsed config object or null if not found/invalid
 */
function loadConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) {
      return null;
    }

    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);

    logTS(`Loading configuration from: ${configPath}`);

    // Validate and normalize the config structure
    const normalized = {};

    if (config.channelsUrl !== undefined) {
      normalized.channelsUrl = config.channelsUrl;
    }
    if (config.channelsPort !== undefined) {
      normalized.channelsPort = String(config.channelsPort);
    }
    if (config.ch4cPort !== undefined) {
      normalized.ch4cPort = Number(config.ch4cPort);
    }
    if (config.ch4cSslPort !== undefined && config.ch4cSslPort !== null) {
      normalized.ch4cSslPort = Number(config.ch4cSslPort);
    }
    if (config.sslHostnames !== undefined) {
      normalized.sslHostnames = Array.isArray(config.sslHostnames)
        ? config.sslHostnames.join(',')
        : config.sslHostnames;
    }
    if (config.dataDir !== undefined) {
      normalized.dataDir = config.dataDir;
    }
    if (config.enablePauseMonitor !== undefined) {
      normalized.enablePauseMonitor = Boolean(config.enablePauseMonitor);
    }
    if (config.pauseMonitorInterval !== undefined) {
      normalized.pauseMonitorInterval = Number(config.pauseMonitorInterval);
    }
    if (config.browserHealthInterval !== undefined) {
      normalized.browserHealthInterval = Number(config.browserHealthInterval);
    }
    if (config.encoders !== undefined && Array.isArray(config.encoders)) {
      normalized.encoders = config.encoders;
    }

    return normalized;
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.error(`Error: Invalid JSON in config file: ${configPath}`);
      console.error(`  ${error.message}`);
    } else {
      console.error(`Error reading config file: ${error.message}`);
    }
    return null;
  }
}

/**
 * Convert encoder objects from config file to CLI-style strings for yargs.
 * @param {object[]} encoders - Array of encoder config objects
 * @returns {string[]} - Array of CLI-formatted encoder strings
 */
function encodersToCliFormat(encoders) {
  return encoders.map(enc => {
    let str = enc.url;
    // Only append optional parts if we have values beyond defaults
    const hasChannel = enc.channel && enc.channel !== '24.42';
    const hasWidth = enc.width && enc.width !== 0;
    const hasHeight = enc.height && enc.height !== 0;
    const hasAudio = enc.audioDevice;

    if (hasChannel || hasWidth || hasHeight || hasAudio) {
      str += `:${enc.channel || '24.42'}`;
      str += `:${enc.width || 0}`;
      str += `:${enc.height || 0}`;
      if (hasAudio) {
        str += `:${enc.audioDevice}`;
      }
    }
    return str;
  });
}

// Determine data directory early to find config file
const rawArgsForDataDir = hideBin(process.argv);
const earlyDataDir = getDataDirFromArgs(rawArgsForDataDir);
const configFilePath = path.resolve(earlyDataDir, 'config.json');

// Load config file if it exists
const fileConfig = loadConfigFile(configFilePath);

// Track whether we're using config file (for startup message)
const usingConfigFile = fileConfig !== null;

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
 * Show display configuration for help/setup
 * Displays monitor positions for encoder width_pos:height_pos configuration
 */
async function showDisplayConfiguration() {
  logTS('Display Configuration (use these values for width_pos:height_pos):');
  try {
    const displayManager = new DisplayManager();
    const displays = await displayManager.getDisplays();
    if (displays && displays.length > 0) {
      displays.forEach((display) => {
        const primaryTag = display.primary ? ' (Primary)' : '';
        logTS(`  ${display.name}${primaryTag}: Position ${display.x}:${display.y}, Size ${display.width}x${display.height}`);
      });
      logTS('  Note: If using DPI scaling above 100%, reported offsets may be incorrect.');
      logTS('        Set displays to 100% scaling for accurate values.');
    } else {
      logTS('  No displays detected.');
    }
  } catch (error) {
    logTS('  Error retrieving display configuration:', error.message);
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

// Flag to track if yargs encountered an error (prevents further execution)
let yargsErrorOccurred = false;

// Determine if config file provides required values
const hasConfigChannelsUrl = fileConfig && fileConfig.channelsUrl;
const hasConfigEncoders = fileConfig && fileConfig.encoders && fileConfig.encoders.length > 0;

const argv = yargs(rawArgs)
  .option('channels-url', {
    alias: 's',
    type: 'string',
    default: fileConfig?.channelsUrl,
    demandOption: !hasConfigChannelsUrl,  // Only required if not in config file
    describe: 'Channels server URL',
    coerce: (value) => {
      if (value === undefined) return value; // Allow undefined for help display
      if (!isValidUrl(value)) {
        throw new Error(`Invalid URL: ${value}`);
      }
      return value;
    }
  })
  .option('channels-port', {
    alias: 'p',
    type: 'string',
    default: fileConfig?.channelsPort || '8089',
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
    default: hasConfigEncoders ? encodersToCliFormat(fileConfig.encoders) : undefined,
    demandOption: !hasConfigEncoders,  // Only required if not in config file
    describe: 'Encoder configurations in format "url[:channel:width_pos:height_pos:audio_device]" where channel is optional (format: xx.xx, default: 24.42), width_pos/height_pos are optional screen positions (default: 0:0), and audio_device is the optional audio output device name',
    coerce: (values) => {
      // Allow undefined for help display
      if (values === undefined || values === null) return values;
      // Handle case where values come from config file as objects
      if (values && values.length > 0 && typeof values[0] === 'object') {
        return values.map(enc => ({
          url: enc.url,
          channel: enc.channel || '24.42',
          width: parseInt(enc.width) || 0,
          height: parseInt(enc.height) || 0,
          audioDevice: enc.audioDevice || null
        }));
      }
      return values.map(value => {
        // Skip undefined/null values
        if (value === undefined || value === null) {
          throw new Error('Encoder URL is required');
        }
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
    default: fileConfig?.ch4cPort || 2442,
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
    default: fileConfig?.dataDir || 'data',
    describe: 'Directory location for storing channel data.'
  })
  .option('enable-pause-monitor', {
    alias: 'm',
    type: 'boolean',
    default: fileConfig?.enablePauseMonitor !== undefined ? fileConfig.enablePauseMonitor : true,
    describe: 'Enable automatic video pause detection and resume'
  })
  .option('pause-monitor-interval', {
    alias: 'i',
    type: 'number',
    default: fileConfig?.pauseMonitorInterval || 10,
    describe: 'Interval in seconds to check for paused video',
    coerce: (value) => {
      const interval = parseInt(value);
      if (isNaN(interval) || interval < 1 || interval > 300) {
        throw new Error('Pause monitor interval must be between 1 and 300 seconds');
      }
      return interval;
    }
  })
  .option('browser-health-interval', {
    alias: 'b',
    type: 'number',
    default: fileConfig?.browserHealthInterval || 6,
    describe: 'Interval in hours to check browser health (validates browsers can navigate)',
    coerce: (value) => {
      const interval = parseFloat(value);
      if (isNaN(interval) || interval < 0.5 || interval > 168) {
        throw new Error('Browser health interval must be between 0.5 and 168 hours (1 week)');
      }
      return interval;
    }
  })
  .option('ch4c-ssl-port', {
    alias: 't',
    type: 'number',
    default: fileConfig?.ch4cSslPort,
    describe: 'Enable HTTPS on specified port (auto-generates SSL certificate if needed)',
    coerce: (value) => {
      if (value === undefined || value === null) return undefined;
      const port = parseInt(value);
      if (isNaN(port) || port < 1 || port > 65535) {
        throw new Error('SSL port must be a number between 1 and 65535');
      }
      return port;
    }
  })
  .option('ssl-hostnames', {
    alias: 'n',
    type: 'string',
    default: fileConfig?.sslHostnames,
    describe: 'Additional hostnames/IPs for SSL certificate (comma-separated). Auto-detects local IPs if not specified.',
    coerce: (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      return value.split(',').map(h => h.trim()).filter(h => h.length > 0);
    }
  })
  .usage('Usage: $0 [options]')
  .example('> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
  .example('\nSimple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71')
  .example('\n> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.71/live/stream1:24.43:1920:0:MACROSILICON"')
  .example('\nThis sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1920 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.')
  .example('\nWhen specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.')
  .help(false)  // Disable built-in help to handle it in fail()
  .alias('help', 'h')
  .wrap(null)  // Don't wrap help text
  .version(false)  // Disable version number in help
  .alias('version', 'v')
  .strict()
  .exitProcess(false)  // Prevent yargs from calling process.exit()
  .fail((msg, err, yargs) => {
    yargsErrorOccurred = true;

    // Show standard error message
    if (msg) console.error(msg);
    if (err) console.error('Error:', err.message);
    console.error('\n');

    // Show help
    yargs.showHelp();

    // Show audio devices and display config, then exit
    (async () => {
      await showAudioDevices();
      await showDisplayConfiguration();
      process.exit(1);
    })();
  })
  .parse();

// If yargs encountered an error, export empty and return (async exit will happen)
if (yargsErrorOccurred) {
  module.exports = {};
  return;
}

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
    .option('browser-health-interval', { alias: 'b', type: 'number', default: 6, describe: 'Interval in hours to check browser health (default: 6)' })
    .usage('Usage: $0 [options]')
    .example('> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
    .example('\nSimple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71')
    .example('\n> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.72/live/stream1:24.43:1920:0:MACROSILICON"')
    .example('\nThis sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1920 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.')
    .example('\nWhen specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.')
    .help()
    .wrap(null)
    .version(false);

  // Show help
  helpYargs.showHelp();

  // Show audio devices and display config, then exit
  (async () => {
    await showAudioDevices();
    await showDisplayConfiguration();
    process.exit(0);
  })();

  // Export empty config and return to prevent further initialization
  module.exports = {};
  return;
}

// Check if required parameters are missing - if so, show help and exit
if (!argv['channels-url'] || !argv['encoder'] || argv['encoder'].length === 0) {
  // Show help for missing required parameters
  console.error('Error: Missing required parameters. Please provide --channels-url (-s) and --encoder (-e).\n');

  const helpYargs = yargs()
    .option('channels-url', { alias: 's', type: 'string', demandOption: true, describe: 'Channels server URL' })
    .option('channels-port', { alias: 'p', type: 'string', default: '8089', describe: 'Channels server port' })
    .option('encoder', { alias: 'e', type: 'array', demandOption: true, describe: 'Encoder configurations in format "url[:channel:width_pos:height_pos:audio_device]"' })
    .option('ch4c-port', { alias: 'c', type: 'number', default: 2442, describe: 'CH4C port number' })
    .option('data-dir', { alias: 'd', type: 'string', default: 'data', describe: 'Directory for storing channel data' })
    .option('enable-pause-monitor', { alias: 'm', type: 'boolean', default: true, describe: 'Enable automatic video pause detection and resume' })
    .option('pause-monitor-interval', { alias: 'i', type: 'number', default: 10, describe: 'Interval in seconds to check for paused video' })
    .option('browser-health-interval', { alias: 'b', type: 'number', default: 6, describe: 'Interval in hours to check browser health' })
    .option('ch4c-ssl-port', { alias: 't', type: 'number', describe: 'Enable HTTPS on specified port' })
    .option('ssl-hostnames', { alias: 'n', type: 'string', describe: 'Additional hostnames/IPs for SSL certificate (comma-separated)' })
    .usage('Usage: $0 [options]')
    .example('$0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
    .help()
    .wrap(null)
    .version(false);

  helpYargs.showHelp();

  // Show audio devices and display config, then exit
  (async () => {
    await showAudioDevices();
    await showDisplayConfiguration();
    logTS('Tip: Create a config.json file in your data directory to avoid specifying parameters on the command line.');
    process.exit(1);
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
  CH4C_SSL_PORT: argv['ch4c-ssl-port'],
  SSL_HOSTNAMES: argv['ssl-hostnames'] || [],
  DATA_DIR: argv['data-dir'],
  ENABLE_PAUSE_MONITOR: argv['enable-pause-monitor'],
  PAUSE_MONITOR_INTERVAL: argv['pause-monitor-interval'],
  BROWSER_HEALTH_INTERVAL: argv['browser-health-interval']
};

if (usingConfigFile) {
  logTS(`Configuration loaded from: ${configFilePath}`);
} else {
  logTS('Configuration loaded from: command line arguments');
}
logTS('Current configuration:');
logTS(JSON.stringify(config, null, 2));

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

// browser health monitor settings - use values from command line arguments
const BROWSER_HEALTH_INTERVAL = config.BROWSER_HEALTH_INTERVAL

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
            gap: 16px;
            margin-bottom: 32px;
            flex-wrap: wrap;
            justify-content: center;
        }

        .quick-link {
            min-width: 140px;
            padding: 16px 24px;
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

        .docs-link {
            display: inline-block;
            padding: 12px 24px;
            background: white;
            border: 2px solid #667eea;
            color: #667eea;
            text-decoration: none;
            font-size: 14px;
            font-weight: 500;
            border-radius: 8px;
            transition: all 0.3s ease;
        }

        .docs-link:hover {
            background: #f7fafc;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
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
            <a href="/remote-access" class="quick-link">🖥️ Remote Access</a>
            <a href="/settings" class="quick-link">⚙️ Settings</a>
            <a href="/logs" class="quick-link">📜 Logs</a>
        </div>

        <div id="https-notice" style="display: none; margin: 24px 0; padding: 12px 16px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; color: #856404; position: relative;">
            <button onclick="dismissHttpsNotice()" style="position: absolute; top: 8px; right: 8px; background: none; border: none; color: #856404; font-size: 20px; cursor: pointer; padding: 4px 8px; line-height: 1;" title="Dismiss">×</button>
            <strong>🔒 HTTPS Enabled:</strong> To avoid browser security warnings and enable full clipboard functionality in Remote Access,
            <a href="/data/cert.pem" style="color: #856404; text-decoration: underline;">download cert.pem</a> and
            <a href="https://github.com/dravenst/CH4C/blob/main/HTTPS_SETUP.md" target="_blank" style="color: #856404; text-decoration: underline;">install as trusted</a>.
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
            <h2 class="section-title">Display Configuration</h2>
            <p style="color: #718096; font-size: 13px; margin-bottom: 16px;">Use these positions when configuring encoder screen offsets (width_pos:height_pos). <strong>Note:</strong> If using DPI scaling above 100%, the reported offsets may be incorrect. Set displays to 100% scaling for accurate values.</p>
            <div id="display-layout">
                <p style="color: #718096;">Loading display configuration...</p>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">Available Audio Devices</h2>
            <div id="audio-devices">
                <p style="color: #718096;">Loading audio devices...</p>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">Documentation</h2>
            <div style="text-align: center;">
                <a href="https://github.com/dravenst/CH4C#readme" target="_blank" class="docs-link">📖 Documentation & Setup Guide</a>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">How CH4C Works</h2>
            <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 12px; padding: 32px; color: white; margin-bottom: 24px;">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; align-items: center; text-align: center;">

                    <!-- Streaming Services -->
                    <div>
                        <div style="background: rgba(255,255,255,0.15); border-radius: 8px; padding: 16px; backdrop-filter: blur(10px);">
                            <div style="font-size: 32px; margin-bottom: 8px;">🌐</div>
                            <div style="font-weight: 600; margin-bottom: 4px;">Web Streams</div>
                            <div style="font-size: 12px; opacity: 0.9;">NBC, NFL, Disney+<br>Peacock, Sling, etc.</div>
                        </div>
                    </div>

                    <!-- Arrow -->
                    <div style="font-size: 24px; opacity: 0.7;">→</div>

                    <!-- CH4C Server -->
                    <div>
                        <div style="background: rgba(255,255,255,0.25); border-radius: 8px; padding: 16px; border: 2px solid rgba(255,255,255,0.5); backdrop-filter: blur(10px);">
                            <div style="font-size: 32px; margin-bottom: 8px;">💻</div>
                            <div style="font-weight: 700; margin-bottom: 4px; font-size: 16px;">CH4C Server</div>
                            <div style="font-size: 11px; opacity: 0.9;">Chrome browsers<br>capture web streams</div>
                            <div style="margin-top: 12px; font-size: 10px; opacity: 0.8;">HDMI Output ↓</div>
                        </div>
                    </div>

                    <!-- Arrow -->
                    <div style="font-size: 24px; opacity: 0.7;">→</div>

                    <!-- Hardware Encoder -->
                    <div>
                        <div style="background: rgba(255,255,255,0.15); border-radius: 8px; padding: 16px; backdrop-filter: blur(10px);">
                            <div style="font-size: 32px; margin-bottom: 8px;">📹</div>
                            <div style="font-weight: 600; margin-bottom: 4px;">HDMI Encoder</div>
                            <div style="font-size: 12px; opacity: 0.9;">LinkPi, Brightsign<br>or similar hardware</div>
                        </div>
                    </div>

                    <!-- Arrow -->
                    <div style="font-size: 24px; opacity: 0.7;">→</div>

                    <!-- Channels DVR -->
                    <div>
                        <div style="background: rgba(255,255,255,0.15); border-radius: 8px; padding: 16px; backdrop-filter: blur(10px);">
                            <div style="font-size: 32px; margin-bottom: 8px;">📺</div>
                            <div style="font-weight: 600; margin-bottom: 4px;">Channels DVR</div>
                            <div style="font-size: 12px; opacity: 0.9;">Records & streams<br>to your devices</div>
                        </div>
                    </div>

                    <!-- Arrow -->
                    <div style="font-size: 24px; opacity: 0.7;">→</div>

                    <!-- End Users -->
                    <div>
                        <div style="background: rgba(255,255,255,0.15); border-radius: 8px; padding: 16px; backdrop-filter: blur(10px);">
                            <div style="font-size: 32px; margin-bottom: 8px;">📱</div>
                            <div style="font-weight: 600; margin-bottom: 4px;">Your Devices</div>
                            <div style="font-size: 12px; opacity: 0.9;">Watch anywhere<br>TV, phone, tablet</div>
                        </div>
                    </div>

                </div>
                <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(255,255,255,0.2); text-align: center; font-size: 13px; opacity: 0.9;">
                    CH4C controls Chrome browsers that display web content via HDMI to hardware encoders, making web streams available as TV channels in Channels DVR
                </div>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">Configuration</h2>
            <div class="info-box">
                <p>Configure CH4C using a <code>config.json</code> file in the data directory. See <a href="https://github.com/dravenst/CH4C#readme" target="_blank" style="color: #667eea;">Documentation</a> for command-line options.</p>
            </div>
            <div class="code-block">{
  "channelsUrl": "http://CHANNELS_DVR_IP",
  "channelsPort": "8089",
  "ch4cPort": 2442,
  "ch4cSslPort": 2443,
  "encoders": [
    {
      "url": "http://ENCODER_IP/live/stream0",
      "channel": "24.42",
      "width": 0,
      "height": 0,
      "audioDevice": "Encoder"
    }
  ]
}</div>
            <div class="info-box" style="margin-top: 16px;">
                <p><strong>Encoder properties:</strong> <code>url</code> (required), <code>channel</code> (default: 24.42), <code>width</code>/<code>height</code> (screen position offset), <code>audioDevice</code> (audio output device name)</p>
            </div>
        </div>

        <div class="section">
            <h2 class="section-title">Sample M3U Configuration</h2>
            <div class="info-box">
                <p>Create a custom channel source in Channels DVR using an M3U playlist.</p>
                <p><strong>CH4C Server:</strong> <code id="ch4c-ip-display">Detecting...</code>:<code>${CH4C_PORT}</code></p>
                <p><strong>Encoder:</strong> <code>${ENCODERS[0]?.url || 'Not configured'}</code> (Channel ${ENCODERS[0]?.channel || '24.42'})</p>
                <p style="margin-top: 8px; font-size: 12px; color: #718096;">The CH4C server address is auto-detected. If incorrect, replace it in the M3U below.</p>
                <p style="margin-top: 8px;"><strong>💡 Tip:</strong> Use the <a href="/m3u-manager" style="color: #667eea; text-decoration: underline;">M3U Manager</a> to easily create and manage your channel lineup with a visual interface.</p>
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
                            <p><strong>Position:</strong> \${encoder.widthPos || 0}, \${encoder.heightPos || 0}</p>
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
                        activeSection.innerHTML = '<h3 style="color: #2d3748; font-size: 16px; margin-bottom: 12px;">🔴 Active Streams:</h3>';

                        data.activeStreams.forEach(stream => {
                            const uptimeMinutes = Math.floor(stream.uptime / 60000);
                            const targetUrlDisplay = stream.targetUrl || 'Unknown URL';
                            const displayUrl = targetUrlDisplay.length > 60 ? targetUrlDisplay.substring(0, 60) + '...' : targetUrlDisplay;
                            // Find encoder index by URL
                            const encoderIndex = data.encoders.findIndex(e => e.url === stream.url);
                            const encoderChannel = encoderIndex >= 0 ? data.encoders[encoderIndex].channel : '?';
                            activeSection.innerHTML += \`
                                <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #fff5f5; border: 1px solid #feb2b2; border-radius: 8px; margin-bottom: 8px;">
                                    <div style="flex: 1; min-width: 0;">
                                        <div style="font-weight: 600; color: #2d3748;">Channel \${encoderChannel}</div>
                                        <div style="font-size: 12px; color: #718096; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="\${targetUrlDisplay}">\${displayUrl}</div>
                                        <div style="font-size: 11px; color: #a0aec0;">Running for \${uptimeMinutes} min</div>
                                    </div>
                                    <a href="/stop/\${encoderIndex}" onclick="return confirm('Stop this stream on Channel \${encoderChannel}?')" style="padding: 8px 16px; background: #fc8181; color: white; text-decoration: none; border-radius: 6px; font-size: 13px; font-weight: 600; margin-left: 12px; flex-shrink: 0;">Stop</a>
                                </div>
                            \`;
                        });

                        // Add Stop All button if multiple streams
                        if (data.activeStreams.length > 0) {
                            activeSection.innerHTML += \`
                                <div style="text-align: center; margin-top: 12px;">
                                    <a href="/stop" onclick="return confirm('Stop ALL active streams?')" style="display: inline-block; padding: 10px 20px; background: #e53e3e; color: white; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 600;">Stop All Streams</a>
                                </div>
                            \`;
                        }
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

        // Fetch and display display configuration
        async function loadDisplays() {
            try {
                const response = await fetch('/displays');
                const displays = await response.json();

                const layoutContainer = document.getElementById('display-layout');

                if (displays && displays.length > 0) {
                    // Calculate bounds for visual layout
                    let minX = Math.min(...displays.map(d => d.x));
                    let minY = Math.min(...displays.map(d => d.y));
                    let maxX = Math.max(...displays.map(d => d.x + d.width));
                    let maxY = Math.max(...displays.map(d => d.y + d.height));

                    const totalWidth = maxX - minX;
                    const totalHeight = maxY - minY;

                    // Create visual layout with scaled displays
                    const scale = Math.min(600 / totalWidth, 200 / totalHeight, 0.15);
                    const layoutWidth = totalWidth * scale;
                    const layoutHeight = totalHeight * scale;

                    let layoutHtml = \`<div style="position: relative; width: \${layoutWidth}px; height: \${layoutHeight}px; background: #e2e8f0; border-radius: 8px; margin: 0 auto;">\`;

                    displays.forEach((display, index) => {
                        const left = (display.x - minX) * scale;
                        const top = (display.y - minY) * scale;
                        const width = display.width * scale;
                        const height = display.height * scale;

                        const colors = ['#667eea', '#48bb78', '#ed8936', '#e53e3e', '#9f7aea'];
                        const color = colors[index % colors.length];

                        layoutHtml += \`
                            <div style="position: absolute; left: \${left}px; top: \${top}px; width: \${width}px; height: \${height}px;
                                        background: \${color}; border-radius: 4px; display: flex; flex-direction: column;
                                        align-items: center; justify-content: center; color: white; font-size: 11px;
                                        box-shadow: 0 2px 4px rgba(0,0,0,0.2); border: 2px solid \${display.primary ? '#fff' : 'transparent'};">
                                <div style="font-weight: 700;">\${display.name}</div>
                                <div style="opacity: 0.9;">\${display.width}x\${display.height}</div>
                                <div style="opacity: 0.8; font-size: 10px;">Offset: \${display.x}:\${display.y}</div>
                                \${display.primary ? '<div style="font-size: 9px; margin-top: 2px; background: rgba(255,255,255,0.3); padding: 1px 4px; border-radius: 2px;">Primary</div>' : ''}
                            </div>
                        \`;
                    });

                    layoutHtml += '</div>';
                    layoutContainer.innerHTML = layoutHtml;
                } else {
                    layoutContainer.innerHTML = '<p style="color: #718096;">No displays detected.</p>';
                }
            } catch (error) {
                console.error('Error loading displays:', error);
                document.getElementById('display-layout').innerHTML =
                    '<p style="color: #f56565;">Error loading display configuration.</p>';
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

        // Dismiss HTTPS notice
        function dismissHttpsNotice() {
            document.getElementById('https-notice').style.display = 'none';
            localStorage.setItem('ch4c-https-notice-dismissed', 'true');
        }

        // Show HTTPS notice if using HTTPS and not dismissed
        if (window.location.protocol === 'https:') {
            const dismissed = localStorage.getItem('ch4c-https-notice-dismissed');
            if (!dismissed) {
                document.getElementById('https-notice').style.display = 'block';
            }
        }

        // Load data on page load
        loadEncoderStatus();
        loadAudioDevices();
        loadDisplays();
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
        .form-group input[type="number"],
        .form-group select {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            font-size: 14px;
            transition: all 0.3s ease;
            font-family: inherit;
        }

        .form-group input[type="text"]:focus,
        .form-group input[type="number"]:focus,
        .form-group select:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .form-group input::placeholder {
            color: #cbd5e0;
        }

        .form-group select {
            cursor: pointer;
            background-color: white;
        }

        .form-row {
            display: flex;
            gap: 12px;
            margin-bottom: 24px;
        }

        .form-row .form-group {
            flex: 1;
            margin-bottom: 0;
        }

        .form-row .form-group.narrow {
            flex: 0.6;
        }

        .form-row .form-group.wide {
            flex: 1.4;
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

        .active-streams {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 2px solid #e2e8f0;
        }

        .active-streams h3 {
            color: #2d3748;
            font-size: 18px;
            margin-bottom: 16px;
        }

        .stream-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .stream-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 12px 16px;
            background: #f7fafc;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
        }

        .stream-info {
            display: flex;
            flex-direction: column;
            gap: 4px;
            flex: 1;
            min-width: 0;
        }

        .stream-info strong {
            color: #2d3748;
            font-size: 14px;
        }

        .stream-url {
            color: #718096;
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .stream-duration {
            color: #a0aec0;
            font-size: 11px;
        }

        .btn-stop {
            padding: 8px 16px;
            background: #fc8181;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-size: 13px;
            font-weight: 600;
            margin-left: 12px;
            flex-shrink: 0;
        }

        .btn-stop:hover {
            background: #f56565;
        }

        .stream-actions {
            margin-top: 16px;
            text-align: center;
        }

        .btn-stop-all {
            display: inline-block;
            padding: 10px 20px;
            background: #e53e3e;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
        }

        .btn-stop-all:hover {
            background: #c53030;
        }

        /* Modal styles */
        .modal-overlay {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .modal-overlay.active {
            display: flex;
        }

        .modal {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            max-width: 450px;
            width: 90%;
            padding: 32px;
            text-align: center;
            animation: modalSlideIn 0.3s ease;
        }

        @keyframes modalSlideIn {
            from {
                opacity: 0;
                transform: translateY(-20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .modal-icon {
            font-size: 48px;
            margin-bottom: 16px;
        }

        .modal-title {
            color: #2d3748;
            font-size: 22px;
            font-weight: 700;
            margin-bottom: 12px;
        }

        .modal-message {
            color: #4a5568;
            font-size: 15px;
            margin-bottom: 8px;
        }

        .modal-detail {
            color: #718096;
            font-size: 13px;
            background: #f7fafc;
            padding: 12px;
            border-radius: 8px;
            margin: 16px 0;
        }

        .modal-buttons {
            display: flex;
            gap: 12px;
            justify-content: center;
            margin-top: 24px;
        }

        .modal-btn {
            padding: 12px 24px;
            border: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .modal-btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .modal-btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .modal-btn-danger {
            background: #fc8181;
            color: white;
        }

        .modal-btn-danger:hover {
            background: #f56565;
        }

        .modal-success .modal-title { color: #22543d; }
        .modal-success .modal-icon { color: #48bb78; }

        .modal-info .modal-title { color: #2b6cb0; }
        .modal-info .modal-icon { color: #4299e1; }

        .modal-error .modal-title { color: #c53030; }
        .modal-error .modal-icon { color: #fc8181; }

        @media (max-width: 640px) {
            .container {
                padding: 24px;
            }

            .button-group {
                flex-direction: column;
            }

            .form-row {
                flex-direction: column;
            }

            .form-row .form-group {
                margin-bottom: 24px;
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

            <div class="form-row">
                <div class="form-group narrow">
                    <label>
                        Duration (minutes) *
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

                <div class="form-group wide">
                    <label>
                        Encoder
                        <span class="label-hint">(optional - auto-select if blank)</span>
                    </label>
                    <select
                        name="selected_encoder"
                        id="selected_encoder"
                    >
                        <option value="">Auto-select first available</option>
                        <<encoder_options>>
                    </select>
                </div>
            </div>

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

            <div class="form-row">
                <div class="form-group">
                    <label>
                        Episode Title
                        <span class="label-hint">(optional)</span>
                    </label>
                    <input
                        type="text"
                        name="episode_title"
                        id="episode_title"
                        placeholder="e.g., Championship Game"
                    />
                </div>

                <div class="form-group">
                    <label>
                        Season Number
                        <span class="label-hint">(optional)</span>
                    </label>
                    <input
                        type="number"
                        name="season_number"
                        id="season_number"
                        placeholder="e.g., 1"
                        min="1"
                        step="1"
                    />
                </div>

                <div class="form-group">
                    <label>
                        Episode Number
                        <span class="label-hint">(optional)</span>
                    </label>
                    <input
                        type="number"
                        name="episode_number"
                        id="episode_number"
                        placeholder="e.g., 5"
                        min="1"
                        step="1"
                    />
                </div>
            </div>

            <div class="form-group">
                <label>
                    Summary
                    <span class="label-hint">(optional)</span>
                </label>
                <input
                    type="text"
                    name="recording_summary"
                    id="recording_summary"
                    placeholder="e.g., Description of the recording"
                />
            </div>

            <div class="button-group">
                <button type="submit" name="button_record" value="Start Recording" class="btn btn-primary">
                    📹 Start Recording
                </button>
                <button type="submit" name="button_tune" value="Tune" class="btn btn-secondary" id="tune_button">
                    📺 Tune to Channel
                </button>
            </div>

            <div class="info-box">
                <p>
                    <strong>📹 Start Recording:</strong> Creates a scheduled recording in Channels DVR and begins streaming the URL.<br>
                    <strong>📺 Tune to Channel:</strong> Simply loads the URL on an available encoder without recording. The stream will be available on the encoder's channel number in Channels DVR. Optional: specify duration for auto-stop, or leave blank for indefinite streaming.
                </p>
            </div>
        </form>
        <<active_streams>>
    </div>

    <!-- Modal for confirmations -->
    <div class="modal-overlay" id="modal-overlay">
        <div class="modal" id="modal">
            <div class="modal-icon" id="modal-icon"></div>
            <h2 class="modal-title" id="modal-title"></h2>
            <p class="modal-message" id="modal-message"></p>
            <div class="modal-detail" id="modal-detail"></div>
            <div class="modal-buttons" id="modal-buttons"></div>
        </div>
    </div>

    <script>
        // Make duration required only when recording
        const form = document.querySelector('form');
        const durationInput = document.getElementById('recording_duration');
        const encoderSelect = document.getElementById('selected_encoder');
        const tuneButton = document.getElementById('tune_button');

        // Update tune button text based on selected encoder
        function updateTuneButtonText() {
            const selectedOption = encoderSelect.options[encoderSelect.selectedIndex];
            let channelText = '';

            if (encoderSelect.value === '' && encoderSelect.options.length > 1) {
                // Auto-select: use first available encoder (second option after "Auto-select")
                const firstEncoderOption = encoderSelect.options[1];
                if (firstEncoderOption) {
                    const match = firstEncoderOption.text.match(/Channel ([0-9.]+)/);
                    if (match) channelText = match[1];
                }
            } else if (encoderSelect.value !== '') {
                // Specific encoder selected
                const match = selectedOption.text.match(/Channel ([0-9.]+)/);
                if (match) channelText = match[1];
            }

            tuneButton.textContent = channelText ? '📺 Tune to Channel ' + channelText : '📺 Tune to Channel';
        }

        // Update on page load and when selection changes
        updateTuneButtonText();
        encoderSelect.addEventListener('change', updateTuneButtonText);

        // Modal functions
        function showModal(type, icon, title, message, detail, buttons) {
            const overlay = document.getElementById('modal-overlay');
            const modal = document.getElementById('modal');
            const modalIcon = document.getElementById('modal-icon');
            const modalTitle = document.getElementById('modal-title');
            const modalMessage = document.getElementById('modal-message');
            const modalDetail = document.getElementById('modal-detail');
            const modalButtons = document.getElementById('modal-buttons');

            modal.className = 'modal modal-' + type;
            modalIcon.textContent = icon;
            modalTitle.textContent = title;
            modalMessage.textContent = message;
            modalDetail.textContent = detail;
            modalDetail.style.display = detail ? 'block' : 'none';

            modalButtons.innerHTML = '';
            buttons.forEach(btn => {
                const button = document.createElement('button');
                button.className = 'modal-btn ' + (btn.class || 'modal-btn-primary');
                button.textContent = btn.text;
                button.onclick = btn.action;
                modalButtons.appendChild(button);
            });

            overlay.classList.add('active');
        }

        function hideModal() {
            document.getElementById('modal-overlay').classList.remove('active');
        }

        // Close modal when clicking overlay
        document.getElementById('modal-overlay').addEventListener('click', function(e) {
            if (e.target === this) hideModal();
        });

        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            const submitButton = e.submitter;

            if (submitButton && submitButton.name === 'button_record') {
                // Recording requires duration
                if (!durationInput.value || parseInt(durationInput.value) <= 0) {
                    showModal('error', '⚠️', 'Duration Required',
                        'Please enter a duration for the recording.', '',
                        [{ text: 'OK', action: () => { hideModal(); durationInput.focus(); } }]);
                    return;
                }
            }

            // Disable buttons during submission
            const buttons = form.querySelectorAll('button[type="submit"]');
            buttons.forEach(btn => btn.disabled = true);

            try {
                // Build URL-encoded form data (Express body-parser expects this format)
                const formData = new FormData(form);
                formData.append(submitButton.name, submitButton.value);

                // Convert FormData to URL-encoded string
                const urlEncodedData = new URLSearchParams();
                for (const [key, value] of formData.entries()) {
                    urlEncodedData.append(key, value);
                }

                const response = await fetch('/instant', {
                    method: 'POST',
                    body: urlEncodedData,
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/json'
                    }
                });

                const result = await response.json();

                if (result.success) {
                    const isRecording = submitButton.name === 'button_record';
                    const icon = isRecording ? '✓' : '📺';
                    const title = isRecording ? 'Recording Started' : 'Tuned to Channel ' + result.channel;
                    const type = isRecording ? 'success' : 'info';

                    let message = result.message || '';
                    let detail = result.detail || '';

                    showModal(type, icon, title, message, detail, [{ text: 'OK', action: hideModal }]);

                    // Refresh active streams
                    refreshActiveStreams();

                    // Clear form
                    document.getElementById('recording_url').value = '';
                    document.getElementById('recording_name').value = '';
                    document.getElementById('episode_title').value = '';
                    document.getElementById('recording_summary').value = '';
                    document.getElementById('season_number').value = '';
                    document.getElementById('episode_number').value = '';
                } else {
                    showModal('error', '❌', 'Error', result.error || 'An error occurred', '',
                        [{ text: 'OK', action: hideModal }]);
                }
            } catch (error) {
                showModal('error', '❌', 'Error', 'Failed to communicate with server: ' + error.message, '',
                    [{ text: 'OK', action: hideModal }]);
            } finally {
                buttons.forEach(btn => btn.disabled = false);
            }
        });

        // Fetch and update active streams
        async function refreshActiveStreams() {
            try {
                const response = await fetch('/health');
                const data = await response.json();

                let activeStreamsContainer = document.getElementById('active-streams-container');

                // Create the container if it doesn't exist
                if (!activeStreamsContainer) {
                    const container = document.querySelector('.container');
                    const existingSection = container.querySelector('.active-streams');
                    if (existingSection) {
                        existingSection.id = 'active-streams-container';
                        activeStreamsContainer = existingSection;
                    } else {
                        activeStreamsContainer = document.createElement('div');
                        activeStreamsContainer.id = 'active-streams-container';
                        activeStreamsContainer.className = 'active-streams';
                        container.appendChild(activeStreamsContainer);
                    }
                }

                if (data.activeStreams && data.activeStreams.length > 0) {
                    let html = '<h3>Active Streams</h3><div class="stream-list">';

                    data.activeStreams.forEach(stream => {
                        const uptimeMinutes = Math.floor(stream.uptime / 60000);
                        const targetUrlDisplay = stream.targetUrl || 'Unknown URL';
                        const displayUrl = targetUrlDisplay.length > 50 ? targetUrlDisplay.substring(0, 50) + '...' : targetUrlDisplay;

                        // Find encoder index by URL
                        const encoderIndex = data.encoders.findIndex(e => e.url === stream.url);
                        const encoderChannel = encoderIndex >= 0 ? data.encoders[encoderIndex].channel : '?';

                        html += \`
                            <div class="stream-item">
                                <div class="stream-info">
                                    <strong>Channel \${encoderChannel}</strong>
                                    <span class="stream-url" title="\${targetUrlDisplay}">\${displayUrl}</span>
                                    <span class="stream-duration">Running for \${uptimeMinutes} min</span>
                                </div>
                                <a href="/stop/\${encoderIndex}" class="btn-stop" onclick="return confirm('Stop this stream on Channel \${encoderChannel}?')">Stop</a>
                            </div>
                        \`;
                    });

                    html += '</div>';
                    html += '<div class="stream-actions"><a href="/stop" class="btn-stop-all" onclick="return confirm(\\'Stop ALL active streams?\\')">Stop All Streams</a></div>';

                    activeStreamsContainer.innerHTML = html;
                    activeStreamsContainer.style.display = 'block';
                } else {
                    activeStreamsContainer.innerHTML = '';
                    activeStreamsContainer.style.display = 'none';
                }
            } catch (error) {
                console.error('Error refreshing active streams:', error);
            }
        }

        // Initial load and refresh every 5 seconds
        refreshActiveStreams();
        setInterval(refreshActiveStreams, 5000);
    </script>
</body>
</html>
`

const REMOTE_ACCESS_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CH4C - Remote Access</title>
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

        .connection-panel {
            background: #f7fafc;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 16px;
            display: flex;
            gap: 80px;
            align-items: flex-start;
        }

        .connection-left {
            flex-shrink: 0;
            max-width: 500px;
        }

        .form-group {
            margin-bottom: 10px;
        }

        .form-group label {
            display: block;
            color: #2d3748;
            font-weight: 600;
            margin-bottom: 6px;
            font-size: 14px;
        }

        .form-group input {
            width: 100%;
            max-width: 250px;
            padding: 10px 12px;
            border: 2px solid #cbd5e0;
            border-radius: 6px;
            font-size: 14px;
        }

        .form-group input:focus {
            outline: none;
            border-color: #667eea;
        }

        .password-wrapper {
            position: relative;
            max-width: 250px;
        }

        .password-wrapper input {
            padding-right: 40px;
        }

        .password-toggle {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            background: none;
            border: none;
            cursor: pointer;
            padding: 4px;
            color: #718096;
            font-size: 18px;
            line-height: 1;
            transition: color 0.2s;
        }

        .password-toggle:hover {
            color: #667eea;
        }

        .password-toggle:disabled {
            cursor: not-allowed;
            opacity: 0.5;
        }

        .button-group {
            margin-bottom: 10px;
        }

        .btn {
            padding: 10px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            margin-right: 12px;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(102, 126, 234, 0.4);
        }

        .btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .btn-disconnect {
            background: linear-gradient(135deg, #f56565 0%, #e53e3e 100%);
        }

        .status-display {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .status-label {
            color: #4a5568;
            font-weight: 600;
            font-size: 14px;
        }

        .status-text {
            font-size: 14px;
            font-weight: 600;
        }

        .status-text.connected {
            color: #48bb78;
        }

        .status-text.disconnected {
            color: #718096;
        }

        @keyframes pulse {
            0%, 100% {
                transform: scale(1);
            }
            50% {
                transform: scale(1.05);
            }
        }
        }

        .status-text.connecting {
            color: #ed8936;
        }

        .vnc-container {
            background: #2d3748;
            border-radius: 8px;
            overflow: auto;
            position: relative;
            min-height: 600px;
            max-height: 800px;
            width: 100%;
        }

        #screen {
            display: inline-block;
        }

        #screen canvas {
            display: block;
        }

        .info-box {
            background: #edf2f7;
            border-left: 4px solid #667eea;
            padding: 16px;
            border-radius: 4px;
            margin-bottom: 20px;
        }

        .info-box p {
            color: #4a5568;
            font-size: 13px;
            line-height: 1.6;
            margin: 4px 0;
        }

        .info-box strong {
            color: #2d3748;
        }

        .viewport-controls {
            flex: 1;
        }

        .controls-layout {
            display: flex;
            gap: 60px;
            align-items: flex-start;
        }

        .navigation-section {
            flex-shrink: 0;
        }

        .navigation-section label {
            display: block;
            color: #2d3748;
            font-weight: 600;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .nav-grid {
            display: grid;
            grid-template-columns: repeat(3, 48px);
            grid-template-rows: repeat(3, 48px);
            gap: 6px;
            justify-content: center;
            align-items: center;
        }

        .arrow-btn {
            width: 48px;
            height: 48px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 20px;
            cursor: pointer;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .arrow-btn:hover {
            transform: scale(1.05);
            box-shadow: 0 6px 12px rgba(102, 126, 234, 0.4);
        }

        .arrow-btn:active {
            transform: scale(0.95);
        }

        .nav-center {
            width: 48px;
            height: 48px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #e2e8f0;
            border-radius: 6px;
        }

        .position-display {
            font-size: 11px;
            font-weight: 600;
            color: #2d3748;
            text-align: center;
        }

        .nav-spacer {
            width: 48px;
            height: 48px;
        }

        .zoom-section {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
        }

        .zoom-section label {
            display: block;
            color: #2d3748;
            font-weight: 600;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .zoom-buttons {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .zoom-buttons input[type="number"] {
            width: 70px;
            padding: 8px;
            border: 2px solid #cbd5e0;
            border-radius: 6px;
            font-size: 14px;
            text-align: center;
        }

        .zoom-buttons input[type="number"]:focus {
            outline: none;
            border-color: #667eea;
        }

        .control-btn {
            padding: 8px 12px;
            background: #e2e8f0;
            color: #2d3748;
            border: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s ease;
            min-width: 36px;
        }

        .control-btn:hover {
            background: #cbd5e0;
        }

        .control-btn:active {
            transform: scale(0.95);
        }

        .reset-btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .reset-btn:hover {
            background: linear-gradient(135deg, #5568d3 0%, #653a8b 100%);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header" style="padding: 16px 0; margin-bottom: 12px;">
            <h1 style="margin: 0; font-size: 24px;">Remote CH4C Server Access</h1>
            <div style="text-align: center; margin-top: 8px;">
                <p style="margin: 0 0 6px 0; font-size: 13px; color: #718096;">VNC remote access • <a href="https://github.com/dravenst/CH4C/blob/main/REMOTE_ACCESS_SETUP.md" target="_blank" style="color: #667eea;">Setup Guide</a> (enable TightVNC loopback)</p>
                <a href="/" class="back-link" style="margin: 0;">← Back to Home</a>
            </div>
        </div>

        <div class="connection-panel">
            <div class="connection-left" style="display: flex; gap: 48px; flex-wrap: wrap;">
                <div style="flex: 0 0 auto;">
                    <div style="display: flex; gap: 16px; margin-bottom: 10px;">
                        <div class="form-group" style="margin-bottom: 0;">
                            <label for="vnc-password">VNC Password:</label>
                            <div class="password-wrapper" style="max-width: 180px;">
                                <input type="password" id="vnc-password" placeholder="Enter VNC password" style="max-width: 180px;">
                                <button type="button" class="password-toggle" id="password-toggle" onclick="togglePasswordVisibility()" title="Show password">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                        <circle cx="12" cy="12" r="3"></circle>
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div class="form-group" style="margin-bottom: 0;">
                            <label for="vnc-port">Port:</label>
                            <input type="number" id="vnc-port" value="5900" min="1" max="65535" style="max-width: 80px;" placeholder="5900">
                        </div>
                    </div>

                    <div class="button-group">
                        <button id="connect-btn" class="btn" onclick="connect()">Connect</button>
                        <button id="disconnect-btn" class="btn btn-disconnect" onclick="disconnect()" disabled>Disconnect</button>
                    </div>

                    <div class="status-display">
                        <span class="status-label">Status:</span>
                        <span id="status" class="status-text disconnected">Disconnected</span>
                    </div>

                    <div id="clipboard-warning" style="display: none; margin-top: 8px; padding: 6px 8px; background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; font-size: 10px; color: #856404; line-height: 1.3; max-width: 400px; position: relative;">
                        <button onclick="dismissClipboardWarning()" style="position: absolute; top: 4px; right: 4px; background: none; border: none; color: #856404; font-size: 16px; cursor: pointer; padding: 2px 6px; line-height: 1;" title="Dismiss">×</button>
                        <span id="clipboard-warning-text"></span>
                    </div>
                </div>
            </div>

            <div class="viewport-controls" id="viewport-controls" style="visibility: hidden;">
                <div class="controls-layout">
                    <div class="navigation-section">
                        <label>Scroll:</label>
                        <div class="nav-grid">
                            <div class="nav-spacer"></div>
                            <button class="arrow-btn" onmousedown="startContinuousAdjust('y', -100)" onmouseup="stopContinuousAdjust()" onmouseleave="stopContinuousAdjust()" ontouchstart="startContinuousAdjust('y', -100)" ontouchend="stopContinuousAdjust()" title="Up">▲</button>
                            <div class="nav-spacer"></div>

                            <button class="arrow-btn" onmousedown="startContinuousAdjust('x', -100)" onmouseup="stopContinuousAdjust()" onmouseleave="stopContinuousAdjust()" ontouchstart="startContinuousAdjust('x', -100)" ontouchend="stopContinuousAdjust()" title="Left">◀</button>
                            <div class="nav-center">
                                <div class="position-display">
                                    <span id="pos-x">0</span>, <span id="pos-y">0</span>
                                </div>
                            </div>
                            <button class="arrow-btn" onmousedown="startContinuousAdjust('x', 100)" onmouseup="stopContinuousAdjust()" onmouseleave="stopContinuousAdjust()" ontouchstart="startContinuousAdjust('x', 100)" ontouchend="stopContinuousAdjust()" title="Right">▶</button>

                            <div class="nav-spacer"></div>
                            <button class="arrow-btn" onmousedown="startContinuousAdjust('y', 100)" onmouseup="stopContinuousAdjust()" onmouseleave="stopContinuousAdjust()" ontouchstart="startContinuousAdjust('y', 100)" ontouchend="stopContinuousAdjust()" title="Down">▼</button>
                            <div class="nav-spacer"></div>
                        </div>
                    </div>

                    <div class="zoom-section">
                        <label>Zoom:</label>
                        <div class="zoom-buttons">
                            <button class="control-btn" onclick="adjustZoom(-0.1)">−</button>
                            <input type="number" id="zoom-scale" value="0.5" min="0.1" max="3.0" step="0.1" onchange="applyViewportSettings()">
                            <button class="control-btn" onclick="adjustZoom(0.1)">+</button>
                        </div>
                        <button class="control-btn reset-btn" onclick="resetViewport()" style="margin-top: 8px; width: 100%;">Reset View</button>
                    </div>
                </div>
            </div>
        </div>

        <div id="clipboard-buttons" style="display: none; margin-bottom: 12px;">
            <div style="display: flex; gap: 12px; align-items: flex-start;">
                <label style="font-size: 14px; font-weight: 600; color: #2d3748; margin: 0; padding-top: 8px;">Clipboard:</label>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <div style="display: flex; gap: 8px;">
                        <button id="copy-from-vnc-btn" class="btn" onclick="copyFromVNC()" style="padding: 8px 16px; font-size: 12px; white-space: nowrap;">Copy VNC → Local</button>
                        <button id="paste-to-vnc-btn" class="btn" onclick="togglePasteBox()" style="padding: 8px 16px; font-size: 12px; white-space: nowrap;">Copy Local → VNC</button>
                    </div>
                    <div id="paste-box" style="display: none;">
                        <textarea id="paste-textarea" placeholder="Paste your text here, then click Send to VNC" style="width: 400px; height: 80px; padding: 8px; border: 2px solid #cbd5e0; border-radius: 6px; font-size: 12px; font-family: monospace; resize: vertical;"></textarea>
                        <div style="margin-top: 4px; display: flex; gap: 8px;">
                            <button class="btn" onclick="sendPasteToVNC()" style="padding: 6px 12px; font-size: 11px;">Send to VNC</button>
                            <button class="btn" onclick="togglePasteBox()" style="padding: 6px 12px; font-size: 11px; background: #718096;">Cancel</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div class="vnc-container">
            <div id="screen"></div>
        </div>
    </div>

    <script type="module">
        // Use locally installed noVNC
        import RFB from '/novnc/core/rfb.js';

        let rfb = null;
        let currentOffsetX = 0;
        let currentOffsetY = 0;
        let continuousAdjustInterval = null;
        let clipboardReadAllowed = null; // null = not tested, true = allowed, false = denied
        const connectBtn = document.getElementById('connect-btn');
        const disconnectBtn = document.getElementById('disconnect-btn');
        const statusEl = document.getElementById('status');
        const passwordInput = document.getElementById('vnc-password');
        const passwordToggle = document.getElementById('password-toggle');

        // Dismiss clipboard warning
        window.dismissClipboardWarning = function() {
            document.getElementById('clipboard-warning').style.display = 'none';
            localStorage.setItem('ch4c-clipboard-warning-dismissed', 'true');
        };

        // Update clipboard warning based on protocol and capabilities
        function updateClipboardWarning() {
            const warning = document.getElementById('clipboard-warning');
            const warningText = document.getElementById('clipboard-warning-text');

            if (!warning || !warningText) return;

            // Check if user has dismissed the warning
            const dismissed = localStorage.getItem('ch4c-clipboard-warning-dismissed');
            if (dismissed) {
                warning.style.display = 'none';
                return;
            }

            const isHTTPS = window.location.protocol === 'https:';

            if (!isHTTPS) {
                // HTTP - manual buttons required
                warningText.innerHTML = '<strong>⚠️ HTTP Limitation:</strong> Manual clipboard buttons required. Use "Copy VNC → Local" and "Copy Local → VNC" with textarea for clipboard operations.';
                warning.style.display = 'block';
            } else if (clipboardReadAllowed === false) {
                // HTTPS but certificate not trusted
                warningText.innerHTML = '<strong>⚠️ Certificate Not Trusted:</strong> Install <code>data/cert.pem</code> as trusted certificate for automatic clipboard. Currently using manual paste. <a href="/data/cert.pem" style="color: #856404; text-decoration: underline;">Download cert.pem</a>';
                warning.style.display = 'block';
            } else if (clipboardReadAllowed === true) {
                // HTTPS with trusted certificate - hide warning
                warning.style.display = 'none';
            } else {
                // HTTPS but not tested yet - show neutral message
                warningText.innerHTML = '<strong>ℹ️ HTTPS Active:</strong> Click "Copy Local → VNC" and allow clipboard access when prompted. To avoid the prompt: <a href="/data/cert.pem" style="color: #856404; text-decoration: underline;">Download cert.pem</a> and <a href="https://github.com/dravenst/CH4C/blob/main/HTTPS_SETUP.md" target="_blank" style="color: #856404; text-decoration: underline;">install as trusted</a>.';
                warning.style.display = 'block';
            }
        }

        // Toggle password visibility
        window.togglePasswordVisibility = function() {
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                passwordToggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
                passwordToggle.title = 'Hide password';
            } else {
                passwordInput.type = 'password';
                passwordToggle.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
                passwordToggle.title = 'Show password';
            }
        };

        window.connect = function() {
            const password = passwordInput.value;
            const port = document.getElementById('vnc-port').value || '5900';

            if (!password) {
                alert('Please enter a VNC password');
                return;
            }

            // Update UI
            statusEl.textContent = 'Connecting...';
            statusEl.className = 'status-text connecting';
            connectBtn.disabled = true;

            // Construct WebSocket URL with port parameter
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = protocol + '//' + window.location.host + '/vnc-proxy?port=' + encodeURIComponent(port);

            try {
                // Create RFB connection
                rfb = new RFB(document.getElementById('screen'), wsUrl, {
                    credentials: { password: password },
                    focusOnClick: true  // Ensure VNC canvas gets focus on click
                });

                // Set viewport options - show full desktop at native resolution
                rfb.scaleViewport = false;  // Don't scale (we'll handle it manually)
                rfb.resizeSession = false;  // Don't resize remote desktop
                rfb.clipViewport = false;   // Show full desktop
                rfb.showDotCursor = true;   // Always show a local cursor dot
                rfb.dragViewport = false;   // Disable drag to pan (we use buttons instead)

                // Prevent browser from intercepting Ctrl+C/V/X when VNC has focus
                // These shortcuts should be sent to the remote machine instead
                const screenContainer = document.getElementById('screen');
                screenContainer.addEventListener('keydown', (e) => {
                    if (e.ctrlKey && (e.key === 'c' || e.key === 'v' || e.key === 'x' || e.key === 'a')) {
                        e.stopPropagation();
                        // Don't preventDefault - let noVNC handle it
                    }
                }, true);  // Use capture phase to intercept before browser

                // Override _updateScale to prevent noVNC from resetting our manual scale
                const originalUpdateScale = rfb._updateScale.bind(rfb);
                rfb._updateScale = function() {
                    // Skip the default behavior that resets scale to 1.0
                    // We're managing scale manually
                    this._fixScrollbars();
                };

                // Store received clipboard text
                let receivedClipboardText = '';

                // Clipboard synchronization - receive from VNC server
                rfb.addEventListener('clipboard', async (e) => {
                    console.log('Received clipboard from VNC server');
                    const text = e.detail.text;
                    receivedClipboardText = text;

                    // Try automatic clipboard write first (works in HTTPS)
                    try {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            await navigator.clipboard.writeText(text);
                            console.log('Clipboard automatically synced');
                            // Show brief success message
                            const copyBtn = document.getElementById('manual-copy-btn');
                            if (copyBtn) {
                                copyBtn.style.display = 'inline-block';
                                copyBtn.textContent = '✓ Clipboard Synced';
                                copyBtn.style.animation = 'pulse 0.5s';
                                setTimeout(() => {
                                    copyBtn.style.display = 'none';
                                }, 2000);
                            }
                            return;
                        }
                    } catch (err) {
                        console.log('Automatic clipboard failed (expected in HTTP), showing manual button');
                    }

                    // Fallback: Show manual copy button with animation
                    const copyBtn = document.getElementById('copy-from-vnc-btn');
                    if (copyBtn) {
                        copyBtn.textContent = 'Copy VNC → Local';
                        copyBtn.style.animation = 'pulse 0.5s';
                    }

                    console.log('VNC clipboard received, click button to copy to browser');
                });

                // Copy from VNC to browser clipboard
                window.copyFromVNC = function() {
                    if (!receivedClipboardText) {
                        alert('No clipboard text available from VNC');
                        return;
                    }

                    // Create temporary textarea
                    const textarea = document.createElement('textarea');
                    textarea.value = receivedClipboardText;
                    textarea.style.position = 'fixed';
                    textarea.style.opacity = '0';
                    document.body.appendChild(textarea);
                    textarea.select();

                    try {
                        document.execCommand('copy');
                        console.log('Clipboard copied via execCommand');
                        const copyBtn = document.getElementById('copy-from-vnc-btn');
                        if (copyBtn) {
                            copyBtn.textContent = '✓ Copied!';
                            copyBtn.style.animation = 'none';
                            setTimeout(() => {
                                copyBtn.textContent = 'Copy VNC → Local';
                            }, 2000);
                        }
                    } catch (err) {
                        console.error('Failed to copy:', err);
                        alert('Failed to copy to clipboard');
                    } finally {
                        document.body.removeChild(textarea);
                    }
                };

                // Paste from browser clipboard to VNC
                // Try automatic clipboard first on HTTPS, fall back to textarea
                window.togglePasteBox = async function() {
                    if (!rfb) {
                        alert('Not connected to VNC');
                        return;
                    }

                    const isHTTPS = window.location.protocol === 'https:';

                    // Try automatic clipboard read on HTTPS
                    if (isHTTPS && navigator.clipboard && navigator.clipboard.readText) {
                        try {
                            console.log('Attempting automatic clipboard read...');
                            const text = await navigator.clipboard.readText();

                            if (text) {
                                // Success! Send directly to VNC
                                console.log('Automatic clipboard read successful, sending to VNC');
                                rfb.clipboardPasteFrom(text);
                                clipboardReadAllowed = true;
                                updateClipboardWarning();

                                // Show success feedback
                                const pasteBtn = document.getElementById('paste-to-vnc-btn');
                                if (pasteBtn) {
                                    const originalText = pasteBtn.textContent;
                                    pasteBtn.textContent = '✓ Sent to VNC!';
                                    pasteBtn.style.background = 'linear-gradient(135deg, #48bb78 0%, #38a169 100%)';
                                    setTimeout(() => {
                                        pasteBtn.textContent = originalText;
                                        pasteBtn.style.background = '';
                                    }, 2000);
                                }
                                return;
                            }
                        } catch (err) {
                            // Clipboard read denied - fall back to textarea
                            console.log('Automatic clipboard read denied:', err.message);
                            clipboardReadAllowed = false;
                            updateClipboardWarning();
                        }
                    }

                    // Fall back to manual textarea method
                    const pasteBox = document.getElementById('paste-box');
                    const textarea = document.getElementById('paste-textarea');

                    if (pasteBox.style.display === 'none') {
                        pasteBox.style.display = 'block';
                        textarea.value = '';
                        textarea.focus();
                    } else {
                        pasteBox.style.display = 'none';
                        textarea.value = '';
                    }
                };

                // Send text from textarea to VNC
                window.sendPasteToVNC = function() {
                    if (!rfb) {
                        alert('Not connected to VNC');
                        return;
                    }

                    const textarea = document.getElementById('paste-textarea');
                    const text = textarea.value;

                    if (!text) {
                        alert('Please paste some text first');
                        return;
                    }

                    console.log('Sending text to VNC server');
                    rfb.clipboardPasteFrom(text);

                    // Close the paste box and show success
                    togglePasteBox();

                    const pasteBtn = document.getElementById('paste-to-vnc-btn');
                    if (pasteBtn) {
                        const originalText = pasteBtn.textContent;
                        pasteBtn.textContent = '✓ Sent to VNC!';
                        pasteBtn.style.background = 'linear-gradient(135deg, #48bb78 0%, #38a169 100%)';
                        setTimeout(() => {
                            pasteBtn.textContent = originalText;
                            pasteBtn.style.background = '';
                        }, 2000);
                    }
                };

                // Connection successful
                rfb.addEventListener('connect', () => {
                    console.log('Connected to VNC server');
                    statusEl.textContent = 'Connected';
                    statusEl.className = 'status-text connected';
                    disconnectBtn.disabled = false;
                    passwordInput.disabled = true;  // Disable password input when connected
                    passwordToggle.disabled = true;  // Disable password toggle when connected

                    // Show clipboard buttons section
                    const clipboardSection = document.getElementById('clipboard-buttons');
                    if (clipboardSection) {
                        clipboardSection.style.display = 'block';
                    }

                    // Update clipboard warning based on detected capabilities
                    updateClipboardWarning();

                    // Show viewport controls
                    document.getElementById('viewport-controls').style.visibility = 'visible';

                    // Initialize position display
                    updatePositionDisplay();

                    // Apply initial zoom (0.5) after a short delay to ensure canvas is ready
                    setTimeout(() => {
                        applyViewportSettings();
                    }, 100);
                });

                // Connection failed
                rfb.addEventListener('disconnect', (e) => {
                    console.log('Disconnected from VNC server');
                    statusEl.textContent = 'Disconnected';
                    statusEl.className = 'status-text disconnected';
                    connectBtn.disabled = false;
                    disconnectBtn.disabled = true;
                    passwordInput.disabled = false;  // Re-enable password input when disconnected
                    passwordToggle.disabled = false;  // Re-enable password toggle when disconnected

                    // Hide clipboard buttons section and warning
                    const clipboardSection = document.getElementById('clipboard-buttons');
                    if (clipboardSection) {
                        clipboardSection.style.display = 'none';
                    }
                    const clipboardWarning = document.getElementById('clipboard-warning');
                    if (clipboardWarning) {
                        clipboardWarning.style.display = 'none';
                    }

                    // Reset clipboard capability detection on disconnect
                    clipboardReadAllowed = null;

                    // Hide viewport controls
                    document.getElementById('viewport-controls').style.visibility = 'hidden';

                    if (e.detail.clean === false) {
                        alert('Connection failed: ' + e.detail.reason + '\\n\\nMost common cause: TightVNC loopback connections are not enabled.\\nSee Setup Guide for instructions.');
                    }
                });

                // Handle credential requirements
                rfb.addEventListener('credentialsrequired', () => {
                    console.log('VNC credentials required');
                    rfb.sendCredentials({ password: password });
                });

            } catch (error) {
                console.error('Connection error:', error);
                alert('Failed to connect: ' + error.message + '\\n\\nMost common cause: TightVNC loopback connections are not enabled.\\nSee Setup Guide for instructions.');
                statusEl.textContent = 'Disconnected';
                statusEl.className = 'status-text disconnected';
                connectBtn.disabled = false;
            }
        };

        window.disconnect = function() {
            if (rfb) {
                rfb.disconnect();
                rfb = null;
            }
        };

        // Update position display
        function updatePositionDisplay() {
            document.getElementById('pos-x').textContent = currentOffsetX;
            document.getElementById('pos-y').textContent = currentOffsetY;
        }

        // Viewport control functions
        window.applyViewportSettings = function(preserveScroll = false) {
            const container = document.querySelector('.vnc-container');
            const screen = document.getElementById('screen');

            if (!container || !screen || !rfb) {
                console.warn('Not ready yet');
                return;
            }

            // Save current scroll position if preserving
            const savedScrollLeft = preserveScroll ? container.scrollLeft : currentOffsetX;
            const savedScrollTop = preserveScroll ? container.scrollTop : currentOffsetY;

            const scale = parseFloat(document.getElementById('zoom-scale').value) || 0.5;

            // Use noVNC's built-in scaling which properly handles mouse coordinates
            if (rfb._display) {
                rfb._display._rescale(scale);
                console.log(\`Applied noVNC scale: \${scale}\`);
            } else {
                console.warn('noVNC display not ready');
            }

            // Restore or set scroll position
            setTimeout(() => {
                container.scrollLeft = savedScrollLeft;
                container.scrollTop = savedScrollTop;
                console.log(\`Applied viewport: offset=(\${savedScrollLeft}, \${savedScrollTop}), scale=\${scale}\`);
            }, 0);
        };

        window.adjustOffset = function(axis, delta) {
            if (axis === 'x') {
                currentOffsetX += delta;
            } else {
                currentOffsetY += delta;
            }
            updatePositionDisplay();
            applyViewportSettings();
        };

        window.adjustZoom = function(delta) {
            const input = document.getElementById('zoom-scale');
            const currentValue = parseFloat(input.value) || 0.5;
            const newValue = Math.max(0.1, Math.min(3.0, currentValue + delta));
            input.value = newValue.toFixed(1);
            applyViewportSettings();
        };

        window.resetViewport = function() {
            currentOffsetX = 0;
            currentOffsetY = 0;
            document.getElementById('zoom-scale').value = 0.5;
            updatePositionDisplay();
            applyViewportSettings();
        };

        // Continuous adjustment for holding down arrow buttons
        window.startContinuousAdjust = function(axis, delta) {
            // Immediate first adjustment
            adjustOffset(axis, delta);

            // Continue adjusting while button is held
            continuousAdjustInterval = setInterval(() => {
                adjustOffset(axis, delta);
            }, 100); // Adjust every 100ms
        };

        window.stopContinuousAdjust = function() {
            if (continuousAdjustInterval) {
                clearInterval(continuousAdjustInterval);
                continuousAdjustInterval = null;
            }
        };

        // Allow Enter key to connect
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !connectBtn.disabled) {
                connect();
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

const LOGS_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CH4C - Logs</title>
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
            max-width: 1200px;
            width: 100%;
            margin: 0 auto;
            padding: 40px;
        }

        .header {
            text-align: center;
            margin-bottom: 24px;
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

        .controls {
            display: flex;
            gap: 12px;
            margin-bottom: 16px;
            flex-wrap: wrap;
            align-items: center;
        }

        .controls button {
            padding: 10px 20px;
            border: none;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }

        .btn-secondary {
            background: #e2e8f0;
            color: #4a5568;
        }

        .btn-secondary:hover {
            background: #cbd5e0;
        }

        .status-indicator {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-left: auto;
            font-size: 14px;
            color: #718096;
        }

        .status-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            background: #48bb78;
        }

        .status-dot.paused {
            background: #ed8936;
        }

        .log-container {
            background: #1a202c;
            border-radius: 8px;
            padding: 16px;
            height: 60vh;
            overflow-y: auto;
            font-family: 'Monaco', 'Menlo', 'Consolas', monospace;
            font-size: 13px;
            line-height: 1.5;
            user-select: text;
            cursor: text;
        }

        .log-entry {
            color: #e2e8f0;
            padding: 2px 0;
            border-bottom: 1px solid #2d3748;
            user-select: text;
        }

        .log-entry:last-child {
            border-bottom: none;
        }

        .log-timestamp {
            color: #a0aec0;
            margin-right: 8px;
        }

        .log-message {
            color: #e2e8f0;
        }

        .log-count {
            color: #718096;
            font-size: 13px;
            margin-top: 12px;
            text-align: right;
        }

        @media (max-width: 768px) {
            .container {
                padding: 24px;
            }

            .header h1 {
                font-size: 24px;
            }

            .controls {
                flex-direction: column;
                align-items: stretch;
            }

            .status-indicator {
                margin-left: 0;
                justify-content: center;
            }

            .log-container {
                height: 50vh;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>CH4C Logs</h1>
            <p>Chrome HDMI for Channels</p>
            <p style="margin-top: 12px;"><a href="/" style="color: #667eea; text-decoration: none; font-size: 14px;">← Back to Home</a></p>
        </div>

        <div class="controls">
            <button id="pauseBtn" class="btn-primary" onclick="togglePause()">Pause</button>
            <button class="btn-secondary" onclick="clearDisplay()">Clear Display</button>
            <button class="btn-secondary" onclick="downloadLogs()">Download Logs</button>
            <div class="status-indicator">
                <div id="statusDot" class="status-dot"></div>
                <span id="statusText">Live</span>
            </div>
        </div>

        <div id="logContainer" class="log-container"></div>
        <div id="logCount" class="log-count"></div>
    </div>

    <script>
        let isPaused = false;
        let lastLogCount = 0;
        let pollInterval = null;

        async function fetchLogs() {
            if (isPaused) return;

            try {
                const response = await fetch('/api/logs');
                const data = await response.json();
                renderLogs(data.logs);
                lastLogCount = data.logs.length;
            } catch (error) {
                console.error('Error fetching logs:', error);
            }
        }

        function renderLogs(logs) {
            const container = document.getElementById('logContainer');
            const wasAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 50;

            const newHtml = logs.map(log =>
                \`<div class="log-entry"><span class="log-timestamp">[\${log.timestamp}]</span><span class="log-message">\${escapeHtml(log.message)}</span></div>\`
            ).join('');

            // Only update if content changed (preserves text selection)
            if (container.innerHTML !== newHtml) {
                container.innerHTML = newHtml;

                // Auto-scroll to bottom if user was already at bottom
                if (wasAtBottom) {
                    container.scrollTop = container.scrollHeight;
                }
            }

            document.getElementById('logCount').textContent = \`Showing \${logs.length} log entries\`;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function togglePause() {
            isPaused = !isPaused;
            const btn = document.getElementById('pauseBtn');
            const dot = document.getElementById('statusDot');
            const text = document.getElementById('statusText');

            if (isPaused) {
                btn.textContent = 'Resume';
                dot.classList.add('paused');
                text.textContent = 'Paused';
            } else {
                btn.textContent = 'Pause';
                dot.classList.remove('paused');
                text.textContent = 'Live';
                fetchLogs(); // Immediately fetch when resuming
            }
        }

        function clearDisplay() {
            document.getElementById('logContainer').innerHTML = '';
            document.getElementById('logCount').textContent = 'Display cleared';
        }

        function downloadLogs() {
            fetch('/api/logs')
                .then(response => response.json())
                .then(data => {
                    const logText = data.logs.map(log => \`[\${log.timestamp}] \${log.message}\`).join('\\n');
                    const blob = new Blob([logText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = \`ch4c-logs-\${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt\`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                })
                .catch(error => console.error('Error downloading logs:', error));
        }

        // Initial fetch and start polling
        fetchLogs();
        pollInterval = setInterval(fetchLogs, 2000);
    </script>
</body>
</html>
`;

const SETTINGS_PAGE_HTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Settings - CH4C</title>
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
            max-width: 800px;
            width: 100%;
            margin: 0 auto;
            padding: 40px;
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

        .section {
            margin-bottom: 32px;
        }

        .section-header {
            font-size: 12px;
            font-weight: 600;
            color: #667eea;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            padding-bottom: 12px;
            border-bottom: 2px solid #e2e8f0;
            margin-bottom: 16px;
        }

        .settings-table {
            width: 100%;
        }

        .settings-row {
            display: flex;
            padding: 12px 0;
            border-bottom: 1px solid #f0f0f0;
        }

        .settings-row:last-child {
            border-bottom: none;
        }

        .settings-label {
            flex: 0 0 180px;
            font-weight: 500;
            color: #4a5568;
            font-size: 14px;
        }

        .settings-value {
            flex: 1;
            color: #2d3748;
            font-size: 14px;
            word-break: break-all;
        }

        .settings-value.mono {
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 13px;
            background: #f7fafc;
            padding: 4px 8px;
            border-radius: 4px;
        }

        .encoder-card {
            background: #f7fafc;
            border-radius: 8px;
            padding: 16px;
            margin-bottom: 12px;
            border-left: 4px solid #667eea;
        }

        .encoder-card:last-child {
            margin-bottom: 0;
        }

        .encoder-header {
            font-weight: 600;
            color: #2d3748;
            margin-bottom: 12px;
            font-size: 15px;
        }

        .encoder-details {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 8px;
        }

        .encoder-detail {
            font-size: 13px;
        }

        .encoder-detail-label {
            color: #718096;
        }

        .encoder-detail-value {
            color: #2d3748;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 12px;
        }

        .status-badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 500;
        }

        .status-badge.enabled {
            background: #c6f6d5;
            color: #276749;
        }

        .status-badge.disabled {
            background: #fed7d7;
            color: #c53030;
        }

        .info-box {
            background: #edf2f7;
            border-left: 4px solid #667eea;
            padding: 16px;
            border-radius: 4px;
            margin-top: 24px;
        }

        .info-box-title {
            font-weight: 600;
            color: #2d3748;
            margin-bottom: 8px;
            font-size: 14px;
        }

        .info-box-text {
            color: #4a5568;
            font-size: 13px;
            line-height: 1.5;
        }

        .info-box-text code {
            background: #e2e8f0;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'Monaco', 'Courier New', monospace;
            font-size: 12px;
        }

        .loading {
            text-align: center;
            padding: 40px;
            color: #718096;
        }

        .error-message {
            background: #fed7d7;
            border-left: 4px solid #c53030;
            padding: 16px;
            border-radius: 4px;
            color: #c53030;
        }

        @media (max-width: 768px) {
            .container {
                padding: 24px;
            }

            .header h1 {
                font-size: 24px;
            }

            .settings-row {
                flex-direction: column;
                gap: 4px;
            }

            .settings-label {
                flex: none;
            }

            .encoder-details {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>⚙️ Settings</h1>
            <p>Current CH4C configuration</p>
            <a href="/" class="back-link">← Back to Home</a>
        </div>

        <div id="settings-content">
            <div class="loading">Loading settings...</div>
        </div>
    </div>

    <script>
        async function loadSettings() {
            const container = document.getElementById('settings-content');

            try {
                const response = await fetch('/api/settings');
                if (!response.ok) {
                    throw new Error('Failed to load settings');
                }
                const settings = await response.json();

                container.innerHTML = renderSettings(settings);
            } catch (error) {
                container.innerHTML = \`
                    <div class="error-message">
                        Error loading settings: \${error.message}
                    </div>
                \`;
            }
        }

        function renderSettings(settings) {
            return \`
                <div class="section">
                    <div class="section-header">Channels DVR</div>
                    <div class="settings-table">
                        <div class="settings-row">
                            <div class="settings-label">Server URL</div>
                            <div class="settings-value mono">\${settings.channelsUrl || 'Not configured'}</div>
                        </div>
                        <div class="settings-row">
                            <div class="settings-label">Port</div>
                            <div class="settings-value">\${settings.channelsPort || '8089'}</div>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header">CH4C Server</div>
                    <div class="settings-table">
                        <div class="settings-row">
                            <div class="settings-label">HTTP Port</div>
                            <div class="settings-value">\${settings.ch4cPort || '2442'}</div>
                        </div>
                        <div class="settings-row">
                            <div class="settings-label">HTTPS Port</div>
                            <div class="settings-value">\${settings.ch4cSslPort || 'Disabled'}</div>
                        </div>
                        <div class="settings-row">
                            <div class="settings-label">Data Directory</div>
                            <div class="settings-value mono">\${settings.dataDir || 'data'}</div>
                        </div>
                    </div>
                </div>

                <div class="section">
                    <div class="section-header">Encoders</div>
                    \${renderEncoders(settings.encoders || [])}
                </div>

                <div class="section">
                    <div class="section-header">Monitoring</div>
                    <div class="settings-table">
                        <div class="settings-row">
                            <div class="settings-label">Pause Monitor</div>
                            <div class="settings-value">
                                <span class="status-badge \${settings.enablePauseMonitor ? 'enabled' : 'disabled'}">
                                    \${settings.enablePauseMonitor ? 'Enabled' : 'Disabled'}
                                </span>
                            </div>
                        </div>
                        <div class="settings-row">
                            <div class="settings-label">Pause Check Interval</div>
                            <div class="settings-value">\${settings.pauseMonitorInterval || 10} seconds</div>
                        </div>
                        <div class="settings-row">
                            <div class="settings-label">Browser Health Check</div>
                            <div class="settings-value">\${settings.browserHealthInterval || 6} hours</div>
                        </div>
                    </div>
                </div>

                <div class="info-box">
                    <div class="info-box-title">Configuration Source</div>
                    <div class="info-box-text">
                        \${settings.configSource === 'file'
                            ? \`Loaded from: <code>\${settings.configPath}</code>\`
                            : 'Loaded from command-line arguments'}
                        <br><br>
                        To modify settings, edit <code>config.json</code> in your data directory and restart CH4C.
                    </div>
                </div>
            \`;
        }

        function renderEncoders(encoders) {
            if (encoders.length === 0) {
                return '<div class="settings-value">No encoders configured</div>';
            }

            return encoders.map((encoder, index) => \`
                <div class="encoder-card">
                    <div class="encoder-header">Encoder \${index + 1}</div>
                    <div class="encoder-details">
                        <div class="encoder-detail">
                            <span class="encoder-detail-label">URL: </span>
                            <span class="encoder-detail-value">\${encoder.url}</span>
                        </div>
                        <div class="encoder-detail">
                            <span class="encoder-detail-label">Channel: </span>
                            <span class="encoder-detail-value">\${encoder.channel}</span>
                        </div>
                        <div class="encoder-detail">
                            <span class="encoder-detail-label">Position: </span>
                            <span class="encoder-detail-value">\${encoder.width} x \${encoder.height}</span>
                        </div>
                        <div class="encoder-detail">
                            <span class="encoder-detail-label">Audio Device: </span>
                            <span class="encoder-detail-value">\${encoder.audioDevice || 'Default'}</span>
                        </div>
                    </div>
                </div>
            \`).join('');
        }

        // Load settings on page load
        loadSettings();
    </script>
</body>
</html>
`;

module.exports = {
  CHANNELS_URL: config.CHANNELS_URL,
  CHANNELS_PORT: config.CHANNELS_PORT,
  ENCODERS: config.ENCODERS,
  CH4C_PORT: config.CH4C_PORT,
  CH4C_SSL_PORT: config.CH4C_SSL_PORT,
  SSL_HOSTNAMES: config.SSL_HOSTNAMES,
  DATA_DIR: config.DATA_DIR,
  FIND_VIDEO_RETRIES,
  FIND_VIDEO_WAIT,
  PLAY_VIDEO_RETRIES,
  PLAY_VIDEO_WAIT,
  FULL_SCREEN_WAIT,
  ENABLE_PAUSE_MONITOR,
  PAUSE_MONITOR_INTERVAL,
  BROWSER_HEALTH_INTERVAL,
  CHANNELS_POST_URL,
  START_PAGE_HTML,
  INSTANT_PAGE_HTML,
  M3U_MANAGER_PAGE_HTML,
  REMOTE_ACCESS_PAGE_HTML,
  LOGS_PAGE_HTML,
  SETTINGS_PAGE_HTML,
  CHROME_USERDATA_DIRECTORIES,
  CHROME_EXECUTABLE_DIRECTORIES,
  CONFIG_FILE_PATH: configFilePath,
  USING_CONFIG_FILE: usingConfigFile
};