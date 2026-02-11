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
    describe: 'Encoder configurations in format "url[:channel:width_pos:height_pos:audio_device]" where channel is optional (format: xx.xx, default: 24.42), width_pos/height_pos are optional screen positions (default: 0:0), and audio_device is the optional audio output device name',
    coerce: (values) => {
      // Allow undefined/null/empty for optional encoder
      if (values === undefined || values === null) return values;
      if (Array.isArray(values) && values.length === 0) return undefined;
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
        // Skip undefined/null/empty values
        if (value === undefined || value === null || value === '') {
          return null;
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
      }).filter(Boolean);
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
  .usage('Usage: $0 [options]\n       $0 service <install|uninstall|status|start|stop>')
  .example('> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
  .example('\nSimple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71')
  .example('\n> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.71/live/stream1:24.43:1920:0:MACROSILICON"')
  .example('\nThis sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1920 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.')
  .example('\nWhen specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.')
  .epilogue('Service Commands:\n  $0 service install [-d <path>]   Install as Windows scheduled task (starts at logon)\n  $0 service uninstall             Remove the scheduled task\n  $0 service status                Check if installed and running\n  $0 service start                 Start the scheduled task\n  $0 service stop                  Stop CH4C gracefully')
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
    .option('channels-url', { alias: 's', type: 'string', describe: 'Channels server URL' })
    .option('channels-port', { alias: 'p', type: 'string', default: '8089', describe: 'Channels server port' })
    .option('encoder', { alias: 'e', type: 'array', describe: 'Encoder configurations in format "url[:channel:width_pos:height_pos:audio_device]" where channel is optional (format: xx.xx, default: 24.42), width_pos/height_pos are optional screen positions (default: 0:0), and audio_device is the optional audio output device name' })
    .option('ch4c-port', { alias: 'c', type: 'number', default: 2442, describe: 'CH4C port number' })
    .option('data-dir', { alias: 'd', type: 'string', default: 'data', describe: 'Directory for storing channel data. Can be relative or absolute path (default: data)' })
    .option('enable-pause-monitor', { alias: 'm', type: 'boolean', default: true, describe: 'Enable automatic video pause detection and resume' })
    .option('pause-monitor-interval', { alias: 'i', type: 'number', default: 10, describe: 'Interval in seconds to check for paused video' })
    .option('browser-health-interval', { alias: 'b', type: 'number', default: 6, describe: 'Interval in hours to check browser health (default: 6)' })
    .option('ch4c-ssl-port', { alias: 't', type: 'number', describe: 'Enable HTTPS on specified port' })
    .option('ssl-hostnames', { alias: 'n', type: 'string', describe: 'Additional hostnames/IPs for SSL certificate (comma-separated)' })
    .usage('Usage: $0 [options]\n       $0 service <install|uninstall|status|start|stop>\n\nAll parameters are optional. You can configure settings via the web UI at http://localhost:<ch4c-port>/settings')
    .example('> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"')
    .example('\nSimple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71')
    .example('\n> $0 -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.72/live/stream1:24.43:1920:0:MACROSILICON"')
    .example('\nThis sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1920 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.')
    .example('\nWhen specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.')
    .epilogue('Service Commands:\n  $0 service install [-d <path>]   Install as Windows scheduled task (starts at logon)\n  $0 service uninstall             Remove the scheduled task\n  $0 service status                Check if installed and running\n  $0 service start                 Start the scheduled task\n  $0 service stop                  Stop CH4C gracefully')
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

// Track which settings were explicitly provided via CLI args (not from config file defaults).
// These will be shown as "CLI" overrides in the settings UI and cannot be changed via the web form.
const cliOverrides = {};
const cliArgMap = {
  'channels-url': 'channelsUrl',
  'channels-port': 'channelsPort',
  'ch4c-port': 'ch4cPort',
  'ch4c-ssl-port': 'ch4cSslPort',
  'ssl-hostnames': 'sslHostnames',
  'data-dir': 'dataDir',
  'enable-pause-monitor': 'enablePauseMonitor',
  'pause-monitor-interval': 'pauseMonitorInterval',
  'browser-health-interval': 'browserHealthInterval'
};

// An arg is CLI-provided if it was explicitly passed on the command line (not from config file or default).
// yargs tracks which args were explicitly provided in argv._ and via the parsed object.
for (const [cliName, configName] of Object.entries(cliArgMap)) {
  // Check if the raw CLI args contain this option (not from config file defaults)
  const hasCliArg = rawArgs.some(arg =>
    arg === `--${cliName}` || arg.startsWith(`--${cliName}=`) ||
    arg === `-${cliName.charAt(0)}`
  );
  if (hasCliArg) {
    cliOverrides[configName] = String(argv[cliName]);
  }
}

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
const CHANNELS_POST_URL = CHANNELS_URL ? `${CHANNELS_URL}:${CHANNELS_PORT}/dvr/jobs/new` : null

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
            <h2 class="section-title">Getting Started</h2>
            <div style="display: flex; flex-direction: column; gap: 20px;">

                <!-- Step 1 -->
                <div style="display: flex; gap: 16px; align-items: flex-start;">
                    <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 50%; min-width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;">1</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 6px 0; font-size: 16px;">Preparation</h3>
                        <p style="margin: 0; color: #4a5568; font-size: 14px;">Connect your HDMI encoder(s) to the PC. Set the PC display(s) to <strong>1920x1080</strong> and configure the encoder transport stream to match (recommended <strong>30fps</strong>). Install a VNC server (e.g., <a href="https://www.intergrid.com.au/tightvnc/" target="_blank" style="color: #667eea; font-weight: 600;">TightVNC</a>) and enable <strong>loopback connections</strong>. See the <a href="https://github.com/dravenst/CH4C#readme" target="_blank" style="color: #667eea;">documentation</a> for detailed hardware and encoder configuration.</p>
                    </div>
                </div>

                <!-- Step 2 -->
                <div style="display: flex; gap: 16px; align-items: flex-start;">
                    <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 50%; min-width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;">2</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 6px 0; font-size: 16px;">Configure Settings</h3>
                        <p style="margin: 0; color: #4a5568; font-size: 14px;">Go to <a href="/settings" style="color: #667eea; font-weight: 600;">Settings</a> and enter your <strong>Channels DVR URL</strong>. Optionally configure the HTTPS port for secure remote access.</p>
                    </div>
                </div>

                <!-- Step 3 -->
                <div style="display: flex; gap: 16px; align-items: flex-start;">
                    <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 50%; min-width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;">3</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 6px 0; font-size: 16px;">Add Encoder(s)</h3>
                        <p style="margin: 0; color: #4a5568; font-size: 14px;">In <a href="/settings" style="color: #667eea; font-weight: 600;">Settings</a>, click <strong>+ Add Encoder</strong> for each HDMI encoder. Set the <strong>Encoder URL</strong> (e.g., <code style="font-size: 12px;">http://192.168.1.50/live/stream0</code>). Use the <strong>Audio Devices</strong> list to find the correct audio output device name for each encoder. For multi-monitor setups, set the <strong>Screen X/Y Position</strong> using the <strong>Display Configuration</strong> offsets with Screens. Save settings and restart CH4C.</p>
                    </div>
                </div>

                <!-- Step 4 -->
                <div style="display: flex; gap: 16px; align-items: flex-start;">
                    <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 50%; min-width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;">4</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 6px 0; font-size: 16px;">Add M3U Source to Channels DVR</h3>
                        <p style="margin: 0; color: #4a5568; font-size: 14px;">In Channels DVR, go to Settings &rarr; Add Source &rarr; Custom Channels. Set Stream Format to <strong>MPEG-TS</strong> and enter the M3U URL found in the <a href="/m3u-manager" style="color: #667eea; font-weight: 600;">M3U Manager</a>:<br>
                        <code id="ch4c-m3u-url" style="display: inline-block; margin-top: 6px; padding: 4px 8px; background: #f0f0f0; border-radius: 4px; font-size: 12px;">http://CH4C_IP:${CH4C_PORT}/m3u-manager/playlist.m3u</code></p>
                    </div>
                </div>

                <!-- Step 5 -->
                <div style="display: flex; gap: 16px; align-items: flex-start;">
                    <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 50%; min-width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;">5</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 6px 0; font-size: 16px;">Test the Encoder</h3>
                        <p style="margin: 0; color: #4a5568; font-size: 14px;">After restarting, verify your encoder appears in the <strong>Encoder Status</strong> section above with a healthy status. Try tuning to the encoder's channel in Channels DVR to confirm the video and audio are working correctly.  E.g. Use the Chrome instance(s) started by CH4C and navigate to a site such as youtube.com to play a video with sound and confirm it works through the Channels DVR app.</p>
                    </div>
                </div>

                <!-- Step 6 -->
                <div style="display: flex; gap: 16px; align-items: flex-start;">
                    <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 50%; min-width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;">6</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 6px 0; font-size: 16px;">Log In to Streaming Services</h3>
                        <p style="margin: 0; color: #4a5568; font-size: 14px;">Use <a href="/remote-access" style="color: #667eea; font-weight: 600;">Remote Access</a> to connect to this PC via the built-in VNC viewer. Log in to each streaming service (NBC, Sling, Disney+, etc.) in the browser windows. Credentials are cached per encoder, but services may periodically require re-authentication.</p>
                    </div>
                </div>

                <!-- Step 7 -->
                <div style="display: flex; gap: 16px; align-items: flex-start;">
                    <div style="background: linear-gradient(135deg, #667eea, #764ba2); color: white; border-radius: 50%; min-width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 16px;">7</div>
                    <div style="flex: 1;">
                        <h3 style="margin: 0 0 6px 0; font-size: 16px;">Add Channels</h3>
                        <p style="margin: 0; color: #4a5568; font-size: 14px;">Use the <a href="/m3u-manager" style="color: #667eea; font-weight: 600;">M3U Manager</a> to add channels. Use <strong>Refresh Sling TV</strong> to automatically sync Sling channels, or <strong>Add Custom Channel</strong> for any streaming service URL. See the <a href="https://github.com/dravenst/CH4C#readme" target="_blank" style="color: #667eea;">documentation</a> for sample channel URLs. You will need to Reload M3U for the M3U source you added to the Channels Sources in Step 4 for the new channels to appear in the Guide. </p>
                    </div>
                </div>

            </div>
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

            // Update the M3U URL in getting started
            const m3uUrl = document.getElementById('ch4c-m3u-url');
            if (m3uUrl) {
                m3uUrl.textContent = m3uUrl.textContent.replace('CH4C_IP', ch4cAddress);
            }

            // Update the custom URL prefix in Add Custom Channel modal
            const customUrlPrefix = document.getElementById('customUrlPrefix');
            if (customUrlPrefix) {
                customUrlPrefix.textContent = ch4cAddress;
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
        * { margin: 0; padding: 0; box-sizing: border-box; }
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
            max-width: 850px;
            width: 100%;
            margin: 0 auto;
            padding: 40px;
        }
        .header { text-align: center; margin-bottom: 32px; }
        .header h1 { color: #2d3748; font-size: 28px; font-weight: 700; margin-bottom: 8px; }
        .header p { color: #718096; font-size: 14px; }
        .header .back-link {
            display: inline-block; margin-top: 12px; color: #667eea;
            text-decoration: none; font-size: 14px;
        }
        .header .back-link:hover { text-decoration: underline; }

        /* Sections */
        .section { margin-bottom: 32px; }
        .section + .section { margin-top: 8px; }
        .section-header {
            font-size: 12px; font-weight: 600; color: #667eea;
            text-transform: uppercase; letter-spacing: 0.5px;
            padding-bottom: 12px; border-bottom: 2px solid #e2e8f0;
            margin-bottom: 16px; display: flex; align-items: center; gap: 8px;
        }

        /* Form fields */
        .form-group { padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
        .form-group:last-child { border-bottom: none; }
        .form-group.disabled { opacity: 0.6; }
        .form-group.depends-disabled { opacity: 0.5; }

        /* Checkbox + field pair on one line */
        .form-group-toggle-pair { padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
        .form-group-toggle-pair.disabled { opacity: 0.6; }
        .toggle-pair-row { display: flex; align-items: center; gap: 12px; }
        .toggle-pair-row .toggle-checkbox-field { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
        .toggle-pair-row .toggle-dependent-field { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
        .toggle-pair-row .toggle-dependent-field.toggled-off input { opacity: 0.4; pointer-events: none; }
        .toggle-pair-row .toggle-dependent-field.toggled-off .form-unit { opacity: 0.4; }
        .form-row { display: flex; align-items: center; gap: 12px; }
        .form-label {
            flex: 0 0 auto; font-weight: 500; color: #4a5568; font-size: 14px;
            display: flex; align-items: center; gap: 6px;
        }
        .form-input, .form-select {
            flex: 1; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px;
            font-size: 14px; color: #2d3748; background: white;
            font-family: inherit; max-width: 300px;
        }
        .form-input:focus, .form-select:focus {
            outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.15);
        }
        .form-input:disabled, .form-select:disabled {
            background: #f7fafc; cursor: not-allowed;
        }
        .form-input.error { border-color: #e53e3e; }
        .form-checkbox { width: 18px; height: 18px; accent-color: #667eea; cursor: pointer; }
        .form-unit { font-size: 13px; color: #718096; white-space: nowrap; }
        .form-description { font-size: 12px; color: #a0aec0; margin-top: 4px; padding-left: 0; }

        /* Paired fields on one line */
        .form-group-pair { padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
        .form-group-pair.disabled { opacity: 0.6; }
        .form-pair-row { display: flex; align-items: center; gap: 12px; }
        .form-pair-row .pair-field { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
        .form-pair-row .pair-field.pair-field-wide { flex: 1; }
        .form-pair-row .pair-label {
            font-weight: 500; color: #4a5568; font-size: 14px; white-space: nowrap;
            display: flex; align-items: center; gap: 6px;
        }
        .form-pair-row .pair-input-wide {
            flex: 1; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px;
            font-size: 14px; color: #2d3748; background: white; font-family: inherit;
            min-width: 0;
        }
        .form-pair-row .pair-input-narrow {
            width: 80px; padding: 8px 12px; border: 1px solid #e2e8f0; border-radius: 6px;
            font-size: 14px; color: #2d3748; background: white; font-family: inherit;
        }
        .form-pair-row input:focus {
            outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.15);
        }
        .form-pair-row input:disabled { background: #f7fafc; cursor: not-allowed; }
        .form-pair-description { font-size: 12px; color: #a0aec0; margin-top: 4px; }
        .form-error { font-size: 12px; color: #e53e3e; margin-top: 4px; }

        /* Badges */
        .cli-badge {
            display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 10px;
            font-weight: 600; background: #edf2f7; color: #667eea; letter-spacing: 0.5px;
        }
        .modified-dot {
            display: inline-block; width: 6px; height: 6px; border-radius: 50%;
            background: #667eea; flex-shrink: 0;
        }

        /* Directory browser */
        .browse-btn {
            padding: 6px 12px; border: 1px solid #e2e8f0; border-radius: 6px; background: #edf2f7;
            color: #4a5568; font-size: 13px; cursor: pointer; white-space: nowrap;
        }
        .browse-btn:hover { background: #e2e8f0; }
        .dir-modal-overlay {
            display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.4); z-index: 1000; justify-content: center; align-items: center;
        }
        .dir-modal-overlay.show { display: flex; }
        .dir-modal {
            background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 500px; max-width: 90vw; max-height: 70vh; display: flex; flex-direction: column;
        }
        .dir-modal-header {
            padding: 16px 20px; border-bottom: 1px solid #e2e8f0;
            display: flex; justify-content: space-between; align-items: center;
        }
        .dir-modal-header h3 { font-size: 16px; color: #2d3748; margin: 0; }
        .dir-modal-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #a0aec0; padding: 4px; }
        .dir-modal-close:hover { color: #4a5568; }
        .dir-modal-path {
            padding: 10px 20px; background: #f7fafc; border-bottom: 1px solid #e2e8f0;
            font-family: 'Monaco', 'Courier New', monospace; font-size: 12px; color: #4a5568;
            word-break: break-all;
        }
        .dir-modal-list {
            flex: 1; overflow-y: auto; padding: 8px 0; min-height: 200px; max-height: 400px;
        }
        .dir-item {
            padding: 8px 20px; cursor: pointer; font-size: 14px; color: #2d3748;
            display: flex; align-items: center; gap: 8px;
        }
        .dir-item:hover { background: #edf2f7; }
        .dir-item-icon { color: #667eea; font-size: 16px; flex-shrink: 0; }
        .dir-item-parent { color: #718096; font-style: italic; }
        .dir-modal-footer {
            padding: 12px 20px; border-top: 1px solid #e2e8f0;
            display: flex; justify-content: flex-end; gap: 8px;
        }
        .dir-modal-empty { padding: 20px; text-align: center; color: #a0aec0; font-size: 14px; }

        /* Screen picker modal */
        .screen-modal-overlay {
            display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.5); z-index: 1000; align-items: center; justify-content: center;
        }
        .screen-modal-overlay.show { display: flex; }
        .screen-modal {
            background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 90%; max-width: 650px; max-height: 80vh; display: flex; flex-direction: column;
        }
        .screen-modal-header {
            padding: 16px 20px; border-bottom: 1px solid #e2e8f0;
            display: flex; justify-content: space-between; align-items: center;
        }
        .screen-modal-header h3 { font-size: 16px; color: #2d3748; margin: 0; }
        .screen-modal-body { padding: 20px; overflow-y: auto; }
        .screen-modal-hint { font-size: 13px; color: #718096; margin-bottom: 16px; }
        .screen-display {
            cursor: pointer; transition: box-shadow 0.15s, transform 0.15s;
        }
        .screen-display:hover {
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.6), 0 4px 12px rgba(0,0,0,0.3) !important;
            transform: scale(1.03);
        }
        .screen-modal-footer {
            padding: 12px 20px; border-top: 1px solid #e2e8f0;
            display: flex; justify-content: flex-end; gap: 8px;
        }
        .screen-modal-none { padding: 20px; text-align: center; color: #a0aec0; font-size: 14px; }

        /* Encoder cards */
        .encoder-card {
            background: #f7fafc; border-radius: 8px; padding: 16px;
            margin-bottom: 12px; border-left: 4px solid #667eea;
        }
        .encoder-card-header {
            display: flex; justify-content: space-between; align-items: center;
            margin-bottom: 12px;
        }
        .encoder-card-title { font-weight: 600; color: #2d3748; font-size: 15px; }
        .encoder-card-actions { display: flex; gap: 8px; }
        .encoder-details {
            display: flex; flex-direction: column; gap: 6px;
        }
        .encoder-detail-row {
            display: flex; gap: 24px; font-size: 13px; align-items: baseline;
        }
        .encoder-detail { display: flex; gap: 4px; align-items: baseline; }
        .encoder-detail-label { color: #718096; white-space: nowrap; font-size: 12px; }
        .encoder-detail-value {
            color: #2d3748; font-family: 'Monaco', 'Courier New', monospace; font-size: 12px;
        }

        /* Encoder form (inline) */
        .encoder-form {
            background: #f7fafc; border-radius: 8px; padding: 20px;
            margin-bottom: 12px; border: 2px dashed #667eea; display: none;
        }
        .encoder-form.show { display: block; }
        .encoder-form h3 { font-size: 15px; color: #2d3748; margin-bottom: 16px; }
        .encoder-form .form-row { margin-bottom: 12px; }
        .encoder-form .form-label { flex: 0 0 140px; }
        .encoder-form .form-description { padding-left: 0; }

        /* Buttons */
        .btn {
            padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px;
            font-weight: 500; cursor: pointer; transition: all 0.15s;
        }
        .btn-sm { padding: 4px 10px; font-size: 12px; }
        .btn-primary {
            background: linear-gradient(135deg, #667eea, #764ba2); color: white;
        }
        .btn-primary:hover { opacity: 0.9; }
        .btn-primary:disabled { background: #cbd5e0; cursor: not-allowed; opacity: 0.6; }
        .btn-secondary { background: #edf2f7; color: #4a5568; }
        .btn-secondary:hover { background: #e2e8f0; }
        .btn-danger { background: #fed7d7; color: #c53030; }
        .btn-danger:hover { background: #feb2b2; }
        .btn-success { background: #c6f6d5; color: #276749; }

        /* Action bar */
        .action-bar {
            display: flex; justify-content: space-between; align-items: center;
            margin-top: 24px; padding-top: 20px; border-top: 2px solid #e2e8f0;
        }
        .config-path { font-size: 12px; color: #a0aec0; }
        .config-path code {
            background: #edf2f7; padding: 2px 6px; border-radius: 4px;
            font-family: 'Monaco', 'Courier New', monospace; font-size: 11px;
        }
        .action-buttons { display: flex; gap: 8px; }

        /* Messages (toast popup) */
        .message {
            position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
            padding: 12px 24px; border-radius: 6px; font-size: 13px;
            display: none; z-index: 9999; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            max-width: 600px; text-align: center;
        }
        .message.show { display: block; }
        .message.success { background: #c6f6d5; color: #276749; border-left: 4px solid #38a169; }
        .message.error { background: #fed7d7; color: #c53030; border-left: 4px solid #e53e3e; }

        .loading { text-align: center; padding: 40px; color: #718096; }

        @media (max-width: 768px) {
            .container { padding: 24px; }
            .header h1 { font-size: 24px; }
            .form-row { flex-direction: column; gap: 4px; align-items: flex-start; }
            .form-label { flex: none; }
            .form-input, .form-select { max-width: 100%; width: 100%; }
            .form-description, .form-error, .form-pair-description { padding-left: 0; }
            .form-pair-row { flex-direction: column; gap: 4px; align-items: flex-start; }
            .form-pair-row .pair-field { width: 100%; }
            .form-pair-row .pair-input-wide, .form-pair-row .pair-input-narrow { width: 100%; }
            .encoder-details { grid-template-columns: 1fr; }
            .encoder-form .form-label { flex: none; }
            .encoder-form .form-description { padding-left: 0; }
            .action-bar { flex-direction: column; gap: 12px; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Settings</h1>
            <p>Configure CH4C server, monitoring, and encoders</p>
            <a href="/" class="back-link">&larr; Back to Home</a>
        </div>

        <div id="message" class="message"></div>
        <div id="settings-content">
            <div class="loading">Loading settings...</div>
        </div>
    </div>

    <!-- Directory browser modal -->
    <div id="dir-modal-overlay" class="dir-modal-overlay" onclick="if(event.target===this)closeDirBrowser()">
        <div class="dir-modal">
            <div class="dir-modal-header">
                <h3>Select Directory</h3>
                <button class="dir-modal-close" onclick="closeDirBrowser()">&times;</button>
            </div>
            <div class="dir-modal-path" id="dir-modal-path"></div>
            <div class="dir-modal-list" id="dir-modal-list"></div>
            <div class="dir-modal-footer">
                <button class="btn btn-secondary" onclick="closeDirBrowser()">Cancel</button>
                <button class="btn btn-primary" onclick="selectCurrentDir()">Select This Directory</button>
            </div>
        </div>
    </div>

    <div id="screen-modal-overlay" class="screen-modal-overlay" onclick="if(event.target===this)closeScreenPicker()">
        <div class="screen-modal">
            <div class="screen-modal-header">
                <h3>Select Screen</h3>
                <button class="dir-modal-close" onclick="closeScreenPicker()">&times;</button>
            </div>
            <div class="screen-modal-body">
                <div class="screen-modal-hint">Click a display to use its position offsets. If using DPI scaling above 100%, offsets may be incorrect.</div>
                <div id="screen-layout"></div>
            </div>
            <div class="screen-modal-footer">
                <button class="btn btn-secondary" onclick="closeScreenPicker()">Cancel</button>
            </div>
        </div>
    </div>

    <script>
        let settingsData = null;
        let audioDevices = [];
        let displayData = [];
        let screenPickerPrefix = null;
        let hasChanges = false;

        async function loadSettings() {
            const container = document.getElementById('settings-content');
            try {
                const [settingsRes, audioRes, displayRes] = await Promise.all([
                    fetch('/api/settings'),
                    fetch('/audio-devices').catch(() => ({ ok: false })),
                    fetch('/displays').catch(() => ({ ok: false }))
                ]);
                if (!settingsRes.ok) throw new Error('Failed to load settings');
                settingsData = await settingsRes.json();
                if (audioRes.ok) {
                    const audioData = await audioRes.json();
                    audioDevices = audioData.devices || audioData || [];
                }
                if (displayRes.ok) {
                    displayData = await displayRes.json();
                    if (!Array.isArray(displayData)) displayData = [];
                }
                container.innerHTML = renderAll();
            } catch (error) {
                container.innerHTML = '<div class="message error show">Error loading settings: ' + error.message + '</div>';
            }
        }

        function renderAll() {
            let html = '';
            const { values, encoders, metadata, defaults, cliOverrides, configSource, configPath } = settingsData;

            // Render Server section with paired fields
            if (metadata.server) {
                html += '<div class="section">';
                html += '<div class="section-header">Server</div>';
                const serverByPath = {};
                metadata.server.forEach(function(f) { serverByPath[f.path] = f; });
                // Channels DVR URL + Port on same line
                if (serverByPath.channelsUrl && serverByPath.channelsPort) {
                    html += renderFieldPair(serverByPath.channelsUrl, serverByPath.channelsPort, values, defaults, cliOverrides);
                }
                // CH4C HTTP Port + HTTPS Port on same line
                if (serverByPath.ch4cPort && serverByPath.ch4cSslPort) {
                    html += renderFieldPair(serverByPath.ch4cPort, serverByPath.ch4cSslPort, values, defaults, cliOverrides);
                }
                // Remaining server fields rendered individually (with browse button for dataDir)
                var pairedPaths = ['channelsUrl', 'channelsPort', 'ch4cPort', 'ch4cSslPort'];
                for (const field of metadata.server) {
                    if (pairedPaths.indexOf(field.path) === -1) {
                        html += renderField(field, values, defaults, cliOverrides, field.path === 'dataDir');
                    }
                }
                html += '</div>';
            }

            // Encoders section
            html += '<div class="section">';
            html += '<div class="section-header">Encoders <button class="btn btn-sm btn-secondary" onclick="showAddEncoder()">+ Add</button></div>';
            html += '<div id="encoder-form-add" class="encoder-form"></div>';
            html += '<div id="encoder-list">';
            if (encoders && encoders.length > 0) {
                encoders.forEach((enc, i) => { html += renderEncoderCard(enc, i); });
            } else {
                html += '<div style="color:#718096;font-size:14px;padding:8px 0;">No encoders configured</div>';
            }
            html += '</div></div>';

            // Render Monitoring section with paired toggle fields
            if (metadata.monitoring) {
                html += '<div class="section">';
                html += '<div class="section-header">Monitoring</div>';
                var monByPath = {};
                metadata.monitoring.forEach(function(f) { monByPath[f.path] = f; });

                // Pause Monitor checkbox + Pause Check Interval on same line
                if (monByPath.enablePauseMonitor && monByPath.pauseMonitorInterval) {
                    html += renderTogglePair(monByPath.enablePauseMonitor, monByPath.pauseMonitorInterval, values, defaults, cliOverrides);
                }

                // Browser Health Check - rendered inline to match toggle pair style
                if (monByPath.browserHealthInterval) {
                    var bhField = monByPath.browserHealthInterval;
                    var bhVal = values[bhField.path];
                    var bhDef = defaults[bhField.path];
                    var bhCli = cliOverrides[bhField.path];
                    var bhIsCli = bhCli !== undefined;
                    var bhIsModified = !bhIsCli && bhVal !== undefined && bhVal !== null && String(bhVal) !== String(bhDef);
                    var bhDisabled = bhIsCli ? 'disabled' : '';
                    var bhDisplayVal = (bhVal !== null && bhVal !== undefined) ? bhVal : '';
                    var bhMin = bhField.min !== undefined ? ' min="' + bhField.min + '"' : '';
                    var bhMax = bhField.max !== undefined ? ' max="' + bhField.max + '"' : '';
                    var bhStep = bhField.type === 'float' ? ' step="0.1"' : '';

                    html += '<div class="form-group-toggle-pair' + (bhIsCli ? ' disabled' : '') + '">';
                    html += '<div class="toggle-pair-row">';
                    html += '<div class="toggle-checkbox-field">';
                    html += '<label class="pair-label" for="field-' + bhField.path + '">';
                    if (bhIsModified) html += '<span class="modified-dot" title="Modified from default"></span>';
                    html += escapeHtml(bhField.label);
                    if (bhIsCli) html += ' <span class="cli-badge">CLI</span>';
                    html += '</label>';
                    html += '</div>';
                    html += '<div class="toggle-dependent-field">';
                    html += '<input type="number"' + bhStep + ' class="pair-input-narrow" id="field-' + bhField.path + '" data-path="' + bhField.path + '" value="' + bhDisplayVal + '"' + bhMin + bhMax + ' ' + bhDisabled + ' onchange="markChanged()">';
                    if (bhField.unit) html += '<span class="form-unit">' + escapeHtml(bhField.unit) + '</span>';
                    html += '</div>';
                    html += '</div>';
                    html += '<div class="form-pair-description">' + escapeHtml(bhField.description);
                    if (bhDef !== null && bhDef !== undefined) {
                        html += ' (default: ' + escapeHtml(String(bhDef));
                        if (bhField.unit) html += ' ' + escapeHtml(bhField.unit);
                        html += ')';
                    }
                    html += '</div>';
                    if (bhIsCli) html += '<div class="form-pair-description" style="color:#667eea;">Set via command line: ' + escapeHtml(bhCli) + '</div>';
                    html += '</div>';
                }

                // Remaining monitoring fields rendered individually (if any beyond explicitly handled ones)
                var explicitMonPaths = ['enablePauseMonitor', 'pauseMonitorInterval', 'browserHealthInterval'];
                for (const field of metadata.monitoring) {
                    if (explicitMonPaths.indexOf(field.path) === -1) {
                        html += renderField(field, values, defaults, cliOverrides);
                    }
                }
                html += '</div>';
            }

            // Render any other metadata sections not explicitly handled
            for (const [sectionKey, fields] of Object.entries(metadata)) {
                if (sectionKey === 'server' || sectionKey === 'monitoring') continue;
                html += '<div class="section">';
                html += '<div class="section-header">' + sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1) + '</div>';
                for (const field of fields) {
                    html += renderField(field, values, defaults, cliOverrides);
                }
                html += '</div>';
            }

            // Action bar
            html += '<div class="action-bar">';
            html += '<div class="config-path">Config: <code>' + escapeHtml(configPath) + '</code>';
            html += ' (' + (configSource === 'file' ? 'file' : 'CLI args') + ')</div>';
            html += '<div class="action-buttons">';
            html += '<button class="btn btn-secondary" onclick="cancelSettings()">Cancel</button>';
            html += '<button class="btn btn-primary" id="save-btn" onclick="saveSettings()" disabled>Save</button>';
            html += '</div></div>';

            return html;
        }

        function renderField(field, values, defaults, cliOverrides, showBrowse) {
            const value = values[field.path];
            const defaultVal = defaults[field.path];
            const cliVal = cliOverrides[field.path];
            const isCli = cliVal !== undefined;
            const isModified = !isCli && value !== undefined && value !== null && String(value) !== String(defaultVal);
            const disabled = isCli ? 'disabled' : '';
            const groupClass = 'form-group' + (isCli ? ' disabled' : '');

            // Check dependsOn
            const dependsDisabled = field.dependsOn && !values[field.dependsOn];
            const finalClass = groupClass + (dependsDisabled ? ' depends-disabled' : '');

            let html = '<div class="' + finalClass + '">';
            html += '<div class="form-row">';

            // Label
            html += '<label class="form-label" for="field-' + field.path + '">';
            if (isModified) html += '<span class="modified-dot" title="Modified from default"></span>';
            html += escapeHtml(field.label);
            if (isCli) html += ' <span class="cli-badge">CLI</span>';
            html += '</label>';

            // Input
            const inputId = 'field-' + field.path;
            if (field.type === 'boolean') {
                const checked = value ? 'checked' : '';
                html += '<input type="checkbox" class="form-checkbox" id="' + inputId + '" data-path="' + field.path + '" ' + checked + ' ' + disabled + ' onchange="markChanged()">';
            } else if (field.type === 'port' || field.type === 'integer') {
                const displayVal = (value !== null && value !== undefined) ? value : '';
                const min = field.min !== undefined ? ' min="' + field.min + '"' : '';
                const max = field.max !== undefined ? ' max="' + field.max + '"' : '';
                html += '<input type="number" class="form-input" style="flex:0 0 80px;max-width:80px;" id="' + inputId + '" data-path="' + field.path + '" value="' + displayVal + '"' + min + max + ' ' + disabled + ' onchange="markChanged()">';
            } else if (field.type === 'float') {
                const displayVal = (value !== null && value !== undefined) ? value : '';
                const min = field.min !== undefined ? ' min="' + field.min + '"' : '';
                const max = field.max !== undefined ? ' max="' + field.max + '"' : '';
                html += '<input type="number" step="0.1" class="form-input" style="flex:0 0 80px;max-width:80px;" id="' + inputId + '" data-path="' + field.path + '" value="' + displayVal + '"' + min + max + ' ' + disabled + ' onchange="markChanged()">';
            } else {
                const displayVal = (value !== null && value !== undefined) ? escapeHtml(String(value)) : '';
                const ph = field.placeholder ? ' placeholder="' + escapeHtml(field.placeholder) + '"' : '';
                var extraOnchange = field.path === 'dataDir' ? 'checkDataDirChange()' : '';
                html += '<input type="text" class="form-input" id="' + inputId + '" data-path="' + field.path + '" value="' + displayVal + '"' + ph + ' ' + disabled + ' onchange="markChanged();' + extraOnchange + '">';
            }

            // Unit
            if (field.unit) {
                html += '<span class="form-unit">' + escapeHtml(field.unit) + '</span>';
            }

            // Browse button for directory fields
            if (showBrowse && !isCli) {
                html += '<button type="button" class="browse-btn" onclick="openDirBrowser(\\'' + field.path + '\\')">Browse</button>';
            }

            html += '</div>'; // end form-row

            // Description
            html += '<div class="form-description">' + escapeHtml(field.description);
            if (defaultVal !== null && defaultVal !== undefined) {
                html += ' (default: ' + escapeHtml(String(defaultVal));
                if (field.unit) html += ' ' + escapeHtml(field.unit);
                html += ')';
            }
            html += '</div>';

            // Migration warning for data directory changes
            if (field.path === 'dataDir') {
                html += '<div id="datadir-warning" class="form-description" style="color:#dd6b20;display:none;">SSL certificates will be copied to the new directory on save. Chrome login profiles are stored separately and are not affected.</div>';
            }

            // CLI override notice
            if (isCli) {
                html += '<div class="form-description" style="color:#667eea;">Set via command line: ' + escapeHtml(cliVal) + '</div>';
            }

            html += '</div>'; // end form-group
            return html;
        }

        function renderFieldPair(fieldA, fieldB, values, defaults, cliOverrides) {
            var html = '';
            var anyDisabled = false;

            // Helper to get field state
            function fieldState(f) {
                var val = values[f.path];
                var def = defaults[f.path];
                var cli = cliOverrides[f.path];
                var isCli = cli !== undefined;
                var isModified = !isCli && val !== undefined && val !== null && String(val) !== String(def);
                return { val: val, def: def, cli: cli, isCli: isCli, isModified: isModified, disabled: isCli ? 'disabled' : '' };
            }

            var a = fieldState(fieldA);
            var b = fieldState(fieldB);
            if (a.isCli || b.isCli) anyDisabled = true;

            html += '<div class="form-group-pair' + (anyDisabled ? ' disabled' : '') + '">';
            html += '<div class="form-pair-row">';

            // Field A - wide if it's a text input, auto if it's a narrow port/number
            var fieldAWide = (fieldA.type !== 'port' && fieldA.type !== 'integer');
            html += '<div class="pair-field' + (fieldAWide ? ' pair-field-wide' : '') + '">';
            html += '<label class="pair-label" for="field-' + fieldA.path + '">';
            if (a.isModified) html += '<span class="modified-dot" title="Modified from default"></span>';
            html += escapeHtml(fieldA.label);
            if (a.isCli) html += ' <span class="cli-badge">CLI</span>';
            html += '</label>';
            var aId = 'field-' + fieldA.path;
            if (fieldA.type === 'port' || fieldA.type === 'integer') {
                var aVal = (a.val !== null && a.val !== undefined) ? a.val : '';
                html += '<input type="number" class="pair-input-narrow" id="' + aId + '" data-path="' + fieldA.path + '" value="' + aVal + '" ' + a.disabled + ' onchange="markChanged()">';
            } else {
                var aVal = (a.val !== null && a.val !== undefined) ? escapeHtml(String(a.val)) : '';
                var ph = fieldA.placeholder ? ' placeholder="' + escapeHtml(fieldA.placeholder) + '"' : '';
                html += '<input type="text" class="pair-input-wide" id="' + aId + '" data-path="' + fieldA.path + '" value="' + aVal + '"' + ph + ' ' + a.disabled + ' onchange="markChanged()">';
            }
            html += '</div>';

            // Field B (narrow input - port/number)
            html += '<div class="pair-field">';
            html += '<label class="pair-label" for="field-' + fieldB.path + '">';
            if (b.isModified) html += '<span class="modified-dot" title="Modified from default"></span>';
            html += escapeHtml(fieldB.label);
            if (b.isCli) html += ' <span class="cli-badge">CLI</span>';
            html += '</label>';
            var bId = 'field-' + fieldB.path;
            if (fieldB.type === 'port' || fieldB.type === 'integer') {
                var bVal = (b.val !== null && b.val !== undefined) ? b.val : '';
                html += '<input type="number" class="pair-input-narrow" id="' + bId + '" data-path="' + fieldB.path + '" value="' + bVal + '" ' + b.disabled + ' onchange="markChanged()">';
            } else {
                var bVal = (b.val !== null && b.val !== undefined) ? escapeHtml(String(b.val)) : '';
                var ph2 = fieldB.placeholder ? ' placeholder="' + escapeHtml(fieldB.placeholder) + '"' : '';
                html += '<input type="text" class="pair-input-wide" id="' + bId + '" data-path="' + fieldB.path + '" value="' + bVal + '"' + ph2 + ' ' + b.disabled + ' onchange="markChanged()">';
            }
            html += '</div>';

            html += '</div>'; // end form-pair-row

            // Combined description
            html += '<div class="form-pair-description">' + escapeHtml(fieldA.description);
            if (a.def !== null && a.def !== undefined) html += ' (default: ' + escapeHtml(String(a.def)) + ')';
            html += '</div>';

            // CLI notices
            if (a.isCli) html += '<div class="form-pair-description" style="color:#667eea;">' + escapeHtml(fieldA.label) + ' set via CLI: ' + escapeHtml(a.cli) + '</div>';
            if (b.isCli) html += '<div class="form-pair-description" style="color:#667eea;">' + escapeHtml(fieldB.label) + ' set via CLI: ' + escapeHtml(b.cli) + '</div>';

            html += '</div>'; // end form-group-pair
            return html;
        }

        // Render a boolean toggle + dependent field on one line
        function renderTogglePair(toggleField, depField, values, defaults, cliOverrides) {
            var tVal = values[toggleField.path];
            var tDef = defaults[toggleField.path];
            var tCli = cliOverrides[toggleField.path];
            var tIsCli = tCli !== undefined;
            var tIsModified = !tIsCli && tVal !== undefined && tVal !== null && String(tVal) !== String(tDef);

            var dVal = values[depField.path];
            var dDef = defaults[depField.path];
            var dCli = cliOverrides[depField.path];
            var dIsCli = dCli !== undefined;
            var dIsModified = !dIsCli && dVal !== undefined && dVal !== null && String(dVal) !== String(dDef);

            var anyDisabled = tIsCli || dIsCli;
            var isOn = !!tVal;

            var html = '<div class="form-group-toggle-pair' + (anyDisabled ? ' disabled' : '') + '">';
            html += '<div class="toggle-pair-row">';

            // Checkbox field
            html += '<div class="toggle-checkbox-field">';
            html += '<label class="pair-label" for="field-' + toggleField.path + '">';
            if (tIsModified) html += '<span class="modified-dot" title="Modified from default"></span>';
            html += escapeHtml(toggleField.label);
            if (tIsCli) html += ' <span class="cli-badge">CLI</span>';
            html += '</label>';
            var checked = isOn ? 'checked' : '';
            var tDisabled = tIsCli ? 'disabled' : '';
            html += '<input type="checkbox" class="form-checkbox" id="field-' + toggleField.path + '" data-path="' + toggleField.path + '" ' + checked + ' ' + tDisabled + ' onchange="toggleDependent(\\'' + toggleField.path + '\\', \\'' + depField.path + '\\'); markChanged()">';
            html += '</div>';

            // Dependent number field
            var depOffClass = isOn ? '' : ' toggled-off';
            html += '<div class="toggle-dependent-field' + depOffClass + '" id="dep-wrap-' + depField.path + '">';
            html += '<label class="pair-label" for="field-' + depField.path + '">';
            if (dIsModified) html += '<span class="modified-dot" title="Modified from default"></span>';
            html += escapeHtml(depField.label);
            if (dIsCli) html += ' <span class="cli-badge">CLI</span>';
            html += '</label>';
            var depDisabled = (dIsCli || !isOn) ? 'disabled' : '';
            var depDisplayVal = (dVal !== null && dVal !== undefined) ? dVal : '';
            var depMin = depField.min !== undefined ? ' min="' + depField.min + '"' : '';
            var depMax = depField.max !== undefined ? ' max="' + depField.max + '"' : '';
            var step = depField.type === 'float' ? ' step="0.1"' : '';
            html += '<input type="number"' + step + ' class="pair-input-narrow" id="field-' + depField.path + '" data-path="' + depField.path + '" value="' + depDisplayVal + '"' + depMin + depMax + ' ' + depDisabled + ' onchange="markChanged()">';
            if (depField.unit) html += '<span class="form-unit">' + escapeHtml(depField.unit) + '</span>';
            html += '</div>';

            html += '</div>'; // end toggle-pair-row

            // Description
            html += '<div class="form-pair-description">' + escapeHtml(toggleField.description);
            if (dDef !== null && dDef !== undefined) {
                html += ' (default: ' + escapeHtml(String(dDef));
                if (depField.unit) html += ' ' + escapeHtml(depField.unit);
                html += ')';
            }
            html += '</div>';

            // CLI notices
            if (tIsCli) html += '<div class="form-pair-description" style="color:#667eea;">' + escapeHtml(toggleField.label) + ' set via CLI: ' + escapeHtml(tCli) + '</div>';
            if (dIsCli) html += '<div class="form-pair-description" style="color:#667eea;">' + escapeHtml(depField.label) + ' set via CLI: ' + escapeHtml(dCli) + '</div>';

            html += '</div>'; // end form-group-toggle-pair
            return html;
        }

        function renderEncoderCard(enc, index) {
            let html = '<div class="encoder-card" id="encoder-card-' + index + '">';
            html += '<div class="encoder-card-header">';
            html += '<div class="encoder-card-title">Encoder ' + (index + 1) + '</div>';
            html += '<div class="encoder-card-actions">';
            html += '<button class="btn btn-sm btn-secondary" onclick="showEditEncoder(' + index + ')">Edit</button>';
            html += '<button class="btn btn-sm btn-danger" onclick="deleteEncoder(' + index + ')">Delete</button>';
            html += '</div></div>';
            html += '<div class="encoder-details">';
            html += '<div class="encoder-detail-row"><div class="encoder-detail"><span class="encoder-detail-label">URL:</span><span class="encoder-detail-value">' + escapeHtml(enc.url) + '</span></div></div>';
            html += '<div class="encoder-detail-row">';
            html += '<div class="encoder-detail"><span class="encoder-detail-label">Channel:</span><span class="encoder-detail-value">' + escapeHtml(enc.channel || '24.42') + '</span></div>';
            html += '<div class="encoder-detail"><span class="encoder-detail-label">Audio:</span><span class="encoder-detail-value">' + escapeHtml(enc.audioDevice || 'Default') + '</span></div>';
            html += '</div>';
            html += '<div class="encoder-detail-row"><div class="encoder-detail"><span class="encoder-detail-label">Position:</span><span class="encoder-detail-value">' + (enc.width || 0) + ' x ' + (enc.height || 0) + '</span></div></div>';
            html += '</div>';
            html += '<div id="encoder-form-edit-' + index + '" class="encoder-form" style="margin-top:12px;border:none;padding:16px 0 0;"></div>';
            html += '</div>';
            return html;
        }

        function renderEncoderForm(enc, mode, index) {
            const prefix = mode + (index !== undefined ? '-' + index : '');
            enc = enc || { url: '', channel: '24.42', width: 0, height: 0, audioDevice: '' };

            let html = '<h3>' + (mode === 'add' ? 'Add New Encoder' : 'Edit Encoder ' + (index + 1)) + '</h3>';

            // URL
            html += '<div class="form-row"><label class="form-label">Encoder URL *</label>';
            html += '<input type="url" class="form-input" id="enc-url-' + prefix + '" value="' + escapeHtml(enc.url || '') + '" placeholder="http://192.168.1.50/live/stream0" required></div>';
            html += '<div class="form-description">HTTP stream URL of the HDMI encoder</div>';

            // Channel
            html += '<div class="form-row"><label class="form-label">Channel Number</label>';
            html += '<input type="text" class="form-input" id="enc-channel-' + prefix + '" value="' + escapeHtml(enc.channel || '24.42') + '" placeholder="24.42" pattern="[0-9]+\\\\.[0-9]+"></div>';
            html += '<div class="form-description">Channels DVR channel in xx.xx format</div>';

            // Position: X and Y on same row with Screens button
            html += '<div class="form-row" style="gap:8px;">';
            html += '<label class="form-label">Screen Offset</label>';
            html += '<span style="font-size:13px;color:#718096;flex-shrink:0;">X</span>';
            html += '<input type="number" class="form-input" style="flex:0 0 80px;max-width:80px;" id="enc-width-' + prefix + '" value="' + (enc.width || 0) + '">';
            html += '<span style="font-size:13px;color:#718096;flex-shrink:0;">Y</span>';
            html += '<input type="number" class="form-input" style="flex:0 0 80px;max-width:80px;" id="enc-height-' + prefix + '" value="' + (enc.height || 0) + '">';
            if (displayData.length > 0) {
                html += '<button type="button" class="btn btn-sm btn-primary" style="flex-shrink:0;padding:6px 14px;" onclick="openScreenPicker(\\'' + prefix + '\\')">Screens</button>';
            }
            html += '</div>';
            html += '<div class="form-description">Screen position offsets for multi-monitor setups</div>';

            // Audio device
            html += '<div class="form-row"><label class="form-label">Audio Device</label>';
            if (audioDevices.length > 0) {
                html += '<select class="form-select" id="enc-audio-' + prefix + '">';
                html += '<option value="">Default</option>';
                audioDevices.forEach(function(dev) {
                    const name = typeof dev === 'string' ? dev : (dev.name || dev.label || '');
                    const selected = (enc.audioDevice && name.includes(enc.audioDevice)) ? ' selected' : '';
                    html += '<option value="' + escapeHtml(name) + '"' + selected + '>' + escapeHtml(name) + '</option>';
                });
                html += '</select>';
            } else {
                html += '<input type="text" class="form-input" id="enc-audio-' + prefix + '" value="' + escapeHtml(enc.audioDevice || '') + '" placeholder="e.g., Encoder">';
            }
            html += '</div>';
            html += '<div class="form-description">Audio output device name (or partial match)</div>';

            // Buttons
            html += '<div style="margin-top:16px;display:flex;gap:8px;">';
            if (mode === 'add') {
                html += '<button class="btn btn-primary" onclick="submitAddEncoder()">Add Encoder</button>';
                html += '<button class="btn btn-secondary" onclick="hideAddEncoder()">Cancel</button>';
            } else {
                html += '<button class="btn btn-primary" onclick="submitEditEncoder(' + index + ')">Save</button>';
                html += '<button class="btn btn-secondary" onclick="hideEditEncoder(' + index + ')">Cancel</button>';
            }
            html += '</div>';

            return html;
        }

        function getEncoderFromForm(prefix) {
            return {
                url: document.getElementById('enc-url-' + prefix).value.trim(),
                channel: document.getElementById('enc-channel-' + prefix).value.trim() || '24.42',
                width: parseInt(document.getElementById('enc-width-' + prefix).value) || 0,
                height: parseInt(document.getElementById('enc-height-' + prefix).value) || 0,
                audioDevice: document.getElementById('enc-audio-' + prefix).value.trim() || null
            };
        }

        function showAddEncoder() {
            const container = document.getElementById('encoder-form-add');
            container.innerHTML = renderEncoderForm(null, 'add');
            container.classList.add('show');
        }

        function hideAddEncoder() {
            const container = document.getElementById('encoder-form-add');
            container.classList.remove('show');
            container.innerHTML = '';
        }

        function showEditEncoder(index) {
            const container = document.getElementById('encoder-form-edit-' + index);
            container.innerHTML = renderEncoderForm(settingsData.encoders[index], 'edit', index);
            container.classList.add('show');
        }

        function hideEditEncoder(index) {
            const container = document.getElementById('encoder-form-edit-' + index);
            container.classList.remove('show');
            container.innerHTML = '';
        }

        // Preserve unsaved settings field values across page re-renders
        function preserveAndReload() {
            const savedValues = hasChanges ? collectSettingsValues() : null;
            const hadChanges = hasChanges;
            return async function() {
                await loadSettings();
                if (savedValues) {
                    document.querySelectorAll('[data-path]').forEach(function(el) {
                        const path = el.dataset.path;
                        if (!(path in savedValues)) return;
                        if (el.type === 'checkbox') {
                            el.checked = !!savedValues[path];
                        } else {
                            el.value = savedValues[path] != null ? savedValues[path] : '';
                        }
                    });
                    hasChanges = hadChanges;
                    var btn = document.getElementById('save-btn');
                    if (btn) btn.disabled = !hadChanges;
                }
            };
        }

        async function submitAddEncoder() {
            const enc = getEncoderFromForm('add');
            if (!enc.url) { showMessage('Encoder URL is required', 'error'); return; }
            const reload = preserveAndReload();
            try {
                const res = await fetch('/api/encoders', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(enc)
                });
                const data = await res.json();
                if (data.success) {
                    showMessage(data.message, 'success');
                    await reload();
                } else {
                    showMessage(formatErrors(data.errors), 'error');
                }
            } catch (e) { showMessage('Failed to add encoder: ' + e.message, 'error'); }
        }

        async function submitEditEncoder(index) {
            const enc = getEncoderFromForm('edit-' + index);
            if (!enc.url) { showMessage('Encoder URL is required', 'error'); return; }
            const reload = preserveAndReload();
            try {
                const res = await fetch('/api/encoders/' + index, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(enc)
                });
                const data = await res.json();
                if (data.success) {
                    showMessage(data.message, 'success');
                    await reload();
                } else {
                    showMessage(formatErrors(data.errors), 'error');
                }
            } catch (e) { showMessage('Failed to update encoder: ' + e.message, 'error'); }
        }

        async function deleteEncoder(index) {
            if (!confirm('Delete Encoder ' + (index + 1) + '?')) return;
            const reload = preserveAndReload();
            try {
                const res = await fetch('/api/encoders/' + index, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    showMessage(data.message, 'success');
                    await reload();
                } else {
                    showMessage(data.error || 'Failed to delete', 'error');
                }
            } catch (e) { showMessage('Failed to delete encoder: ' + e.message, 'error'); }
        }

        function collectSettingsValues() {
            const values = {};
            document.querySelectorAll('[data-path]').forEach(function(el) {
                if (el.disabled) return; // Skip CLI-overridden fields
                const path = el.dataset.path;
                if (el.type === 'checkbox') {
                    values[path] = el.checked;
                } else if (el.type === 'number') {
                    values[path] = el.value !== '' ? Number(el.value) : null;
                } else {
                    values[path] = el.value || null;
                }
            });
            return values;
        }

        async function saveSettings() {
            const values = collectSettingsValues();

            // Also include current encoders from the loaded data
            const encoders = settingsData.encoders || [];

            try {
                const res = await fetch('/api/settings', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ values, encoders })
                });
                const data = await res.json();
                if (!data.success) {
                    showMessage(formatErrors(data.errors || { error: data.error }), 'error');
                    return;
                }

                var successMsg = 'Configuration saved!';
                if (data.migratedFiles && data.migratedFiles.length > 0) {
                    successMsg += ' Migrated ' + data.migratedFiles.join(', ') + ' to new data directory.';
                }
                successMsg += ' Please restart CH4C for changes to take effect.';
                showMessage(successMsg, 'success');
                hasChanges = false;
                var btn = document.getElementById('save-btn');
                if (btn) btn.disabled = true;
            } catch (e) {
                showMessage('Failed to save: ' + e.message, 'error');
            }
        }

        function markChanged() {
            hasChanges = true;
            var btn = document.getElementById('save-btn');
            if (btn) btn.disabled = false;
        }

        function checkDataDirChange() {
            var input = document.getElementById('field-dataDir');
            var warning = document.getElementById('datadir-warning');
            if (!input || !warning) return;
            var currentVal = settingsData.values.dataDir || '';
            var newVal = input.value.trim();
            warning.style.display = (newVal && newVal !== currentVal) ? 'block' : 'none';
        }

        function toggleDependent(togglePath, depPath) {
            var cb = document.getElementById('field-' + togglePath);
            var wrap = document.getElementById('dep-wrap-' + depPath);
            var input = document.getElementById('field-' + depPath);
            if (!cb || !wrap || !input) return;
            if (cb.checked) {
                wrap.classList.remove('toggled-off');
                input.disabled = false;
            } else {
                wrap.classList.add('toggled-off');
                input.disabled = true;
            }
        }

        function openScreenPicker(prefix) {
            screenPickerPrefix = prefix;
            var layoutEl = document.getElementById('screen-layout');
            if (!displayData || displayData.length === 0) {
                layoutEl.innerHTML = '<div class="screen-modal-none">No displays detected.</div>';
            } else {
                var minX = Math.min.apply(null, displayData.map(function(d) { return d.x; }));
                var minY = Math.min.apply(null, displayData.map(function(d) { return d.y; }));
                var maxX = Math.max.apply(null, displayData.map(function(d) { return d.x + d.width; }));
                var maxY = Math.max.apply(null, displayData.map(function(d) { return d.y + d.height; }));
                var totalWidth = maxX - minX;
                var totalHeight = maxY - minY;
                var scale = Math.min(580 / totalWidth, 250 / totalHeight, 0.2);
                var layoutWidth = totalWidth * scale;
                var layoutHeight = totalHeight * scale;
                var colors = ['#667eea', '#48bb78', '#ed8936', '#e53e3e', '#9f7aea'];
                var html = '<div style="position:relative;width:' + layoutWidth + 'px;height:' + layoutHeight + 'px;background:#e2e8f0;border-radius:8px;margin:0 auto;">';
                displayData.forEach(function(display, index) {
                    var left = (display.x - minX) * scale;
                    var top = (display.y - minY) * scale;
                    var w = display.width * scale;
                    var h = display.height * scale;
                    var color = colors[index % colors.length];
                    html += '<div class="screen-display" style="position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + w + 'px;height:' + h + 'px;';
                    html += 'background:' + color + ';border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;';
                    html += 'color:white;font-size:11px;box-shadow:0 2px 4px rgba(0,0,0,0.2);border:2px solid ' + (display.primary ? '#fff' : 'transparent') + ';"';
                    html += ' data-x="' + display.x + '" data-y="' + display.y + '">';
                    html += '<div style="font-weight:700;">' + escapeHtml(display.name) + '</div>';
                    html += '<div style="opacity:0.9;">' + display.width + 'x' + display.height + '</div>';
                    html += '<div style="opacity:0.8;font-size:10px;">Offset: ' + display.x + ':' + display.y + '</div>';
                    if (display.primary) html += '<div style="font-size:9px;margin-top:2px;background:rgba(255,255,255,0.3);padding:1px 4px;border-radius:2px;">Primary</div>';
                    html += '</div>';
                });
                html += '</div>';
                layoutEl.innerHTML = html;
                // Attach click handlers via event delegation
                layoutEl.querySelectorAll('.screen-display').forEach(function(el) {
                    el.addEventListener('click', function() {
                        selectScreen(parseInt(el.getAttribute('data-x')), parseInt(el.getAttribute('data-y')));
                    });
                });
            }
            document.getElementById('screen-modal-overlay').classList.add('show');
        }

        function closeScreenPicker() {
            document.getElementById('screen-modal-overlay').classList.remove('show');
            screenPickerPrefix = null;
        }

        function selectScreen(x, y) {
            if (!screenPickerPrefix) return;
            var xInput = document.getElementById('enc-width-' + screenPickerPrefix);
            var yInput = document.getElementById('enc-height-' + screenPickerPrefix);
            if (xInput) xInput.value = x;
            if (yInput) yInput.value = y;
            markChanged();
            closeScreenPicker();
        }

        function cancelSettings() {
            if (hasChanges && !confirm('Discard unsaved changes?')) return;
            hasChanges = false;
            loadSettings();
        }

        function showMessage(text, type) {
            const el = document.getElementById('message');
            el.textContent = text;
            el.className = 'message show ' + type;
            setTimeout(function() { el.className = 'message'; }, 8000);
        }

        function formatErrors(errors) {
            if (typeof errors === 'string') return errors;
            return Object.entries(errors).map(function(e) { return e[0] + ': ' + (typeof e[1] === 'object' ? JSON.stringify(e[1]) : e[1]); }).join('; ');
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }

        // Directory browser
        var dirBrowserTarget = null;
        var dirBrowserCurrent = '';
        var dirBrowserDirs = [];

        function openDirBrowser(fieldPath) {
            dirBrowserTarget = fieldPath;
            var currentVal = document.getElementById('field-' + fieldPath).value || '';
            loadDirectory(currentVal || '');
            document.getElementById('dir-modal-overlay').classList.add('show');
        }

        function closeDirBrowser() {
            document.getElementById('dir-modal-overlay').classList.remove('show');
            dirBrowserTarget = null;
        }

        async function loadDirectory(dirPath) {
            var listEl = document.getElementById('dir-modal-list');
            var pathEl = document.getElementById('dir-modal-path');
            listEl.innerHTML = '<div class="dir-modal-empty">Loading...</div>';

            try {
                var url = '/api/directories' + (dirPath ? '?path=' + encodeURIComponent(dirPath) : '');
                var res = await fetch(url);
                var data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to load');

                dirBrowserCurrent = data.current;
                dirBrowserDirs = data.directories;
                pathEl.textContent = data.current;

                var html = '';
                if (data.parent !== null) {
                    html += '<div class="dir-item dir-item-parent" data-dir-path="' + escapeHtml(data.parent) + '">';
                    html += '<span class="dir-item-icon">&#128194;</span> .. (parent directory)</div>';
                }
                if (data.directories.length === 0 && data.parent === null) {
                    html += '<div class="dir-modal-empty">No subdirectories</div>';
                }
                var sep = data.current.includes('\\\\') ? '\\\\' : '/';
                var trail = data.current.endsWith('/') || data.current.endsWith('\\\\') ? '' : sep;
                data.directories.forEach(function(name) {
                    var fullPath = data.current + trail + name;
                    html += '<div class="dir-item" data-dir-path="' + escapeHtml(fullPath) + '">';
                    html += '<span class="dir-item-icon">&#128193;</span> ' + escapeHtml(name) + '</div>';
                });
                listEl.innerHTML = html;
            } catch (e) {
                listEl.innerHTML = '<div class="dir-modal-empty">Error: ' + escapeHtml(e.message) + '</div>';
            }
        }

        // Event delegation for directory clicks
        document.addEventListener('click', function(e) {
            var item = e.target.closest('[data-dir-path]');
            if (item) {
                loadDirectory(item.getAttribute('data-dir-path'));
            }
        });

        function selectCurrentDir() {
            if (dirBrowserTarget && dirBrowserCurrent) {
                var input = document.getElementById('field-' + dirBrowserTarget);
                input.value = dirBrowserCurrent;
                markChanged();
                if (dirBrowserTarget === 'dataDir') checkDataDirChange();
            }
            closeDirBrowser();
        }

        // Load on page load
        loadSettings();

        // Warn before leaving with unsaved changes
        window.addEventListener('beforeunload', function(e) {
            if (hasChanges) { e.preventDefault(); e.returnValue = ''; }
        });
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
  USING_CONFIG_FILE: usingConfigFile,
  CLI_OVERRIDES: cliOverrides
};