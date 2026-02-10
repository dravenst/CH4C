const fs = require('fs');
const path = require('path');
const { logTS } = require('./logger');

/**
 * CONFIG_METADATA - Declarative setting definitions.
 * Single source of truth for all configurable settings.
 * The UI, validation, and save logic all derive from this.
 */
const CONFIG_METADATA = {
  server: [
    {
      path: 'channelsUrl',
      label: 'Channels DVR URL',
      description: 'URL of your Channels DVR server (e.g., http://192.168.1.100)',
      type: 'string',
      required: true,
      placeholder: 'http://192.168.1.100'
    },
    {
      path: 'channelsPort',
      label: 'Channels Port',
      description: 'Channels DVR server port',
      type: 'port',
      default: '8089',
      min: 1,
      max: 65535
    },
    {
      path: 'ch4cPort',
      label: 'CH4C HTTP Port',
      description: 'Port for the CH4C web server',
      type: 'port',
      default: 2442,
      min: 1,
      max: 65535
    },
    {
      path: 'ch4cSslPort',
      label: 'CH4C HTTPS Port',
      description: 'Enable HTTPS on this port. Leave empty to disable.',
      type: 'port',
      default: null,
      min: 1,
      max: 65535
    },
    {
      path: 'dataDir',
      label: 'Data Directory',
      description: 'Directory for persistent storage (config file and SSL certificates)',
      type: 'path',
      default: 'data'
    }
  ],
  monitoring: [
    {
      path: 'enablePauseMonitor',
      label: 'Pause Monitor',
      description: 'Automatically detect and resume paused videos',
      type: 'boolean',
      default: true
    },
    {
      path: 'pauseMonitorInterval',
      label: 'Pause Check Interval',
      description: 'How often to check for paused video',
      type: 'integer',
      default: 10,
      min: 1,
      max: 300,
      unit: 'seconds',
      dependsOn: 'enablePauseMonitor'
    },
    {
      path: 'browserHealthInterval',
      label: 'Browser Health Check',
      description: 'Interval for browser responsiveness validation',
      type: 'float',
      default: 6,
      min: 0.5,
      max: 168,
      unit: 'hours'
    }
  ]
};

/**
 * Encoder field definitions for the encoder CRUD form.
 */
const ENCODER_FIELDS = [
  {
    path: 'url',
    label: 'Encoder URL',
    description: 'HTTP stream URL of the HDMI encoder (e.g., http://192.168.1.50/live/stream0)',
    type: 'url',
    required: true,
    placeholder: 'http://192.168.1.50/live/stream0'
  },
  {
    path: 'channel',
    label: 'Channel Number',
    description: 'Channels DVR channel number in xx.xx format',
    type: 'string',
    default: '24.42',
    placeholder: '24.42',
    pattern: '^\\d+\\.\\d+$'
  },
  {
    path: 'width',
    label: 'Screen X Position',
    description: 'Horizontal screen position offset for the browser window (multi-monitor setup)',
    type: 'integer',
    default: 0
  },
  {
    path: 'height',
    label: 'Screen Y Position',
    description: 'Vertical screen position offset for the browser window (multi-monitor setup)',
    type: 'integer',
    default: 0
  },
  {
    path: 'audioDevice',
    label: 'Audio Device',
    description: 'Name (or partial name) of the audio output device to route audio to this encoder',
    type: 'string',
    default: null,
    placeholder: 'e.g., Encoder'
  }
];

/**
 * Validate a single setting value against its metadata.
 * @param {object} meta - Setting metadata from CONFIG_METADATA
 * @param {*} value - Value to validate
 * @returns {string|null} - Error message or null if valid
 */
function validateSetting(meta, value) {
  // Required check
  if (meta.required && (value === undefined || value === null || value === '')) {
    return `${meta.label} is required`;
  }

  // Allow empty/null for optional fields
  if (value === undefined || value === null || value === '') {
    return null;
  }

  switch (meta.type) {
    case 'string':
    case 'path':
      if (typeof value !== 'string') {
        return `${meta.label} must be a string`;
      }
      break;

    case 'url':
      try {
        new URL(value);
      } catch {
        return `${meta.label} must be a valid URL`;
      }
      break;

    case 'port':
    case 'integer': {
      const num = Number(value);
      if (!Number.isInteger(num)) {
        return `${meta.label} must be a whole number`;
      }
      if (meta.min !== undefined && num < meta.min) {
        return `${meta.label} must be at least ${meta.min}`;
      }
      if (meta.max !== undefined && num > meta.max) {
        return `${meta.label} must be at most ${meta.max}`;
      }
      break;
    }

    case 'float': {
      const num = Number(value);
      if (isNaN(num)) {
        return `${meta.label} must be a number`;
      }
      if (meta.min !== undefined && num < meta.min) {
        return `${meta.label} must be at least ${meta.min}`;
      }
      if (meta.max !== undefined && num > meta.max) {
        return `${meta.label} must be at most ${meta.max}`;
      }
      break;
    }

    case 'boolean':
      // Accept boolean or string "true"/"false"
      break;
  }

  // Pattern check (for channel numbers etc.)
  if (meta.pattern && typeof value === 'string') {
    const regex = new RegExp(meta.pattern);
    if (!regex.test(value)) {
      return `${meta.label} format is invalid`;
    }
  }

  return null;
}

/**
 * Validate an encoder object.
 * @param {object} encoder - Encoder config object
 * @returns {object} - { valid: boolean, errors: object }
 */
function validateEncoder(encoder) {
  const errors = {};

  for (const field of ENCODER_FIELDS) {
    const value = encoder[field.path];
    const error = validateSetting(field, value);
    if (error) {
      errors[field.path] = error;
    }
  }

  // Additional channel format validation
  if (encoder.channel && !/^\d+\.\d+$/.test(encoder.channel)) {
    errors.channel = 'Channel must be in xx.xx format (e.g., 24.42)';
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

/**
 * Parse a form value into the correct type for storage.
 * @param {object} meta - Setting metadata
 * @param {*} value - Raw value from form
 * @returns {*} - Parsed value
 */
function parseFormValue(meta, value) {
  if (value === '' || value === undefined) {
    return meta.default !== undefined ? meta.default : null;
  }

  switch (meta.type) {
    case 'boolean':
      return value === true || value === 'true';
    case 'integer':
    case 'port':
      return parseInt(value, 10);
    case 'float':
      return parseFloat(value);
    default:
      return value;
  }
}

/**
 * Check if a value equals its default.
 * @param {*} value - Current value
 * @param {*} defaultValue - Default value
 * @returns {boolean}
 */
function isDefault(value, defaultValue) {
  if (value === null && defaultValue === null) return true;
  if (value === undefined && defaultValue === undefined) return true;
  return String(value) === String(defaultValue);
}

/**
 * Load config from file.
 * @param {string} configPath - Path to config.json
 * @returns {object} - { config: object, parseError: boolean, errorMessage: string|null }
 */
function loadConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) {
      return { config: {}, parseError: false, errorMessage: null };
    }
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    return { config, parseError: false, errorMessage: null };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { config: {}, parseError: true, errorMessage: error.message };
    }
    return { config: {}, parseError: true, errorMessage: error.message };
  }
}

/**
 * Save config to file, only persisting values that differ from defaults.
 * @param {string} configPath - Path to config.json
 * @param {object} newConfig - Configuration values to save
 * @returns {object} - { success: boolean, error: string|null }
 */
function saveConfig(configPath, newConfig) {
  try {
    // Ensure the directory exists
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Build a clean config object, filtering defaults for scalar settings
    const filtered = {};

    // Process settings from CONFIG_METADATA
    for (const settings of Object.values(CONFIG_METADATA)) {
      for (const meta of settings) {
        const value = newConfig[meta.path];
        if (value !== undefined && !isDefault(value, meta.default)) {
          filtered[meta.path] = value;
        } else if (meta.required && value !== undefined) {
          // Always save required fields
          filtered[meta.path] = value;
        }
      }
    }

    // Always save encoders if present
    if (newConfig.encoders && Array.isArray(newConfig.encoders)) {
      filtered.encoders = newConfig.encoders;
    }

    // Write pretty-printed JSON
    const content = JSON.stringify(filtered, null, 2);
    fs.writeFileSync(configPath, content + '\n', 'utf8');

    logTS(`Configuration saved to ${configPath}`);
    return { success: true, error: null };
  } catch (error) {
    logTS(`Failed to save configuration: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Validate all settings from a form submission.
 * @param {object} values - Key-value pairs of setting paths to values
 * @returns {object} - { valid: boolean, errors: object, parsed: object }
 */
function validateAllSettings(values) {
  const errors = {};
  const parsed = {};

  for (const settings of Object.values(CONFIG_METADATA)) {
    for (const meta of settings) {
      const rawValue = values[meta.path];
      const error = validateSetting(meta, rawValue);
      if (error) {
        errors[meta.path] = error;
      } else {
        parsed[meta.path] = parseFormValue(meta, rawValue);
      }
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    parsed
  };
}

/**
 * Get all setting defaults as a flat object.
 * @returns {object} - Default values keyed by path
 */
function getDefaults() {
  const defaults = {};
  for (const settings of Object.values(CONFIG_METADATA)) {
    for (const meta of settings) {
      defaults[meta.path] = meta.default !== undefined ? meta.default : null;
    }
  }
  return defaults;
}

module.exports = {
  CONFIG_METADATA,
  ENCODER_FIELDS,
  validateSetting,
  validateEncoder,
  validateAllSettings,
  parseFormValue,
  isDefault,
  loadConfig,
  saveConfig,
  getDefaults
};
