'use strict';

/**
 * login-check-scheduler.js
 * Periodically verifies that streaming services opted in to the automatic check are still
 * logged in on each running encoder, and logs back in immediately if not.
 *
 * Opt-in: a site only runs in the automatic check if the user has explicitly marked it
 * "Include in Automatic Login Check" (see includedSites below) — saving the shared "All
 * TVE Services" credential does NOT opt every TVE site in; each one must be selected in
 * the Login Manager dropdown and opted in individually.
 *
 * Scheduling: runs once every `frequencyWeeks`, only during the low-usage window of
 * 1 AM - 3 AM local time. A background poll (every 10 minutes) checks whether the next
 * scheduled run is due and the current time falls inside that window; if the window is
 * missed (e.g. CH4C was offline), the run waits for the next occurrence of the window
 * rather than firing immediately outside it.
 *
 * Retries: if a login attempt fails, it is retried once after a 30 s pause (RETRY_DELAY_MS)
 * before being recorded as a failure.
 *
 * Persistence: settings and the outcome of the last run are stored in
 * <DATA_DIR>/login-check-status.json so the admin page can show the last result across
 * restarts. `stickyFailure` stays true (keeping the failure banner visible) across any
 * number of scheduled runs — it is only cleared when the user manually triggers a check.
 */

const fs = require('fs');
const path = require('path');
const { logTS } = require('./logger');
const credentialsStore = require('./credentials-store');
const { LOGIN_SITES, loginEncoders } = require('./login-manager');

const POLL_INTERVAL_MS = 10 * 60 * 1000; // check every 10 minutes whether a run is due
const RETRY_DELAY_MS = 30 * 1000; // pause before a single retry of a failed login
const WINDOW_START_HOUR = 1; // 1 AM local time
const WINDOW_END_HOUR = 3;   // 3 AM local time (exclusive)

const DEFAULT_STATE = {
  enabled: false,
  frequencyWeeks: 1,
  nextCheckAt: null,
  stickyFailure: false,
  lastRun: null, // { startedAt, finishedAt, trigger, results, succeeded, failed, total, allSuccessful }
  includedSites: {}, // { [siteId]: true|false } — explicit per-site opt-in, set via the Login Manager checkbox
};

let _dataDir = 'data';
let _getContext = () => ({ encoders: [], browsers: new Map(), activeStreams: null });
let _state = { ...DEFAULT_STATE };
let _running = false;
let _pollTimer = null;

function statusFilePath() {
  return path.join(_dataDir, 'login-check-status.json');
}

function loadState() {
  try {
    const f = statusFilePath();
    if (fs.existsSync(f)) {
      _state = { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(f, 'utf8')) };
    }
  } catch (e) {
    logTS(`login-check-scheduler: failed to load state: ${e.message}`);
  }
}

function saveState() {
  try {
    fs.mkdirSync(_dataDir, { recursive: true });
    fs.writeFileSync(statusFilePath(), JSON.stringify(_state, null, 2), 'utf8');
  } catch (e) {
    logTS(`login-check-scheduler: failed to save state: ${e.message}`);
  }
}

// Next occurrence of the low-usage window's start (today if it hasn't started yet, else tomorrow).
function computeNextWindowStart(fromDate) {
  const d = new Date(fromDate);
  d.setHours(WINDOW_START_HOUR, 0, 0, 0);
  if (d <= fromDate) d.setDate(d.getDate() + 1);
  return d;
}

// `frequencyWeeks` after fromDate, snapped to that day's window start.
function computeNextCheckAt(fromDate, frequencyWeeks) {
  const target = new Date(fromDate.getTime() + frequencyWeeks * 7 * 24 * 60 * 60 * 1000);
  target.setHours(WINDOW_START_HOUR, 0, 0, 0);
  return target;
}

function isInWindow(date) {
  const h = date.getHours();
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

/**
 * @param {string} dataDir - CH4C data directory (persists settings/status here).
 * @param {() => {encoders, browsers, activeStreams}} getContext - returns the live
 *   encoders/browsers/activeStreams needed by loginEncoders, evaluated lazily at run time.
 */
function init(dataDir, getContext) {
  _dataDir = dataDir || 'data';
  _getContext = getContext;
  loadState();
  if (_state.enabled && !_state.nextCheckAt) {
    _state.nextCheckAt = computeNextWindowStart(new Date()).toISOString();
    saveState();
  }
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => { maybeRunScheduled(); }, POLL_INTERVAL_MS);
}

function getState() {
  return { ..._state, running: _running };
}

function updateSettings({ enabled, frequencyWeeks }) {
  if (typeof enabled === 'boolean') _state.enabled = enabled;
  if (frequencyWeeks !== undefined) {
    const n = parseInt(frequencyWeeks, 10);
    if (Number.isInteger(n) && n >= 1) _state.frequencyWeeks = n;
  }
  if (_state.enabled && !_state.nextCheckAt) {
    _state.nextCheckAt = computeNextWindowStart(new Date()).toISOString();
  } else if (!_state.enabled) {
    _state.nextCheckAt = null;
  }
  saveState();
  return getState();
}

async function maybeRunScheduled() {
  if (!_state.enabled || _running || !_state.nextCheckAt) return;
  const now = new Date();
  if (now >= new Date(_state.nextCheckAt) && isInWindow(now)) {
    await runCheck('scheduled');
  }
}

// Credentials to log in with: site-specific if saved, else (for TVE sites) the shared
// "All TVE Services" provider credential. Which sites this is actually allowed to run for
// is controlled separately by includedSites — see getActiveSites().
function getEffectiveCredentials(siteConfig) {
  const siteCreds = credentialsStore.getCredentials(siteConfig.id);
  if (siteCreds) return siteCreds;
  if (siteConfig.type === 'tve') {
    return credentialsStore.getCredentials('_tve_provider');
  }
  return null;
}

// Explicit per-site opt-in state: true/false once the user has set it via the Login
// Manager checkbox, or null if never set. A site with no explicit record is excluded from
// automatic checks — merely having a (possibly shared) credential available is not enough.
function getIncluded(siteId) {
  const v = _state.includedSites[siteId];
  return v === undefined ? null : !!v;
}

function setIncluded(siteId, included) {
  _state.includedSites[siteId] = !!included;
  saveState();
  return getIncluded(siteId);
}

function getActiveSites() {
  return LOGIN_SITES.filter(s => getIncluded(s.id) === true && getEffectiveCredentials(s) !== null);
}

/**
 * Runs a login check across all sites with saved credentials, on every running encoder.
 * @param {'scheduled'|'manual'} trigger
 * @param {(event: object) => void} [statusCallback]
 */
async function runCheck(trigger, statusCallback = () => {}) {
  if (_running) {
    statusCallback({ type: 'error', message: 'A login check is already running.' });
    return getState();
  }
  _running = true;
  if (trigger === 'manual') _state.stickyFailure = false;

  const startedAt = new Date().toISOString();
  const sites = getActiveSites();
  const results = [];
  let succeeded = 0, failed = 0;

  statusCallback({ type: 'start', total: sites.length, trigger });

  const { encoders, browsers, activeStreams } = _getContext();

  for (const siteConfig of sites) {
    const creds = getEffectiveCredentials(siteConfig);
    statusCallback({ type: 'site-start', siteId: siteConfig.id, siteName: siteConfig.name });

    let siteFailCount = 0;
    const siteMessages = [];

    try {
      await loginEncoders({
        siteId: siteConfig.id,
        ...creds,
        encoders,
        browsers,
        activeStreams,
        retryDelayMs: RETRY_DELAY_MS,
        statusCallback: (ev) => {
          // loginEncoders emits its own 'start'/'complete' (per-site, across that site's
          // encoders) — skip forwarding those since they'd collide with this module's own
          // 'start'/'complete' events (whole-run, across all sites) of the same type name.
          // 'site-start'/'site-complete' above already cover the per-site boundary.
          if (ev.type === 'start' || ev.type === 'complete') return;
          statusCallback({ ...ev, siteId: siteConfig.id, siteName: siteConfig.name });
          if (ev.type === 'error') {
            siteFailCount++;
            siteMessages.push(ev.message);
          }
        },
      });
    } catch (e) {
      siteFailCount++;
      siteMessages.push(e.message);
    }

    const siteOk = siteFailCount === 0;
    if (siteOk) succeeded++; else failed++;
    results.push({ siteId: siteConfig.id, siteName: siteConfig.name, success: siteOk, message: siteMessages.join('; ') || null });
    statusCallback({ type: 'site-complete', siteId: siteConfig.id, siteName: siteConfig.name, success: siteOk });
  }

  const finishedAt = new Date().toISOString();
  const allSuccessful = failed === 0;

  _state.lastRun = { startedAt, finishedAt, trigger, results, succeeded, failed, total: sites.length, allSuccessful };
  if (!allSuccessful) _state.stickyFailure = true;
  if (trigger === 'scheduled') {
    _state.nextCheckAt = computeNextCheckAt(new Date(), _state.frequencyWeeks).toISOString();
  }
  _running = false;
  saveState();

  logTS(`login-check-scheduler: ${trigger} run complete — ${succeeded}/${sites.length} service(s) OK`);
  statusCallback({ type: 'complete', succeeded, failed, total: sites.length, allSuccessful });
  return getState();
}

module.exports = { init, getState, updateSettings, runCheck, getIncluded, setIncluded };
