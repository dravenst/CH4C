'use strict';

/**
 * credentials-store.js
 * Encrypted persistent storage for Login Manager credentials.
 *
 * Encryption: AES-256-GCM (authenticated encryption — detects tampering).
 * Key:        32 random bytes, generated once and stored in <DATA_DIR>/login-credentials.key.
 *             The key file is the only thing that needs protecting; the encrypted store file
 *             alone cannot be decrypted without it.
 * Store:      <DATA_DIR>/login-credentials.json — one encrypted envelope per site ID.
 *             Each envelope holds the entire credentials object as a single JSON blob,
 *             so username, password, TV provider name, and provider credentials are all
 *             encrypted together.
 *
 * Usage:
 *   const store = require('./credentials-store');
 *   store.init(Constants.DATA_DIR);           // call once at startup
 *   store.saveCredentials('nbc', { ... });
 *   const creds = store.getCredentials('nbc'); // null if not saved
 *   store.clearCredentials('nbc');
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const ALGORITHM  = 'aes-256-gcm';
const KEY_BYTES  = 32; // 256-bit key
const IV_BYTES   = 12; // 96-bit IV (GCM standard)

let _dataDir = 'data';

function keyFilePath()   { return path.join(_dataDir, 'login-credentials.key'); }
function storeFilePath() { return path.join(_dataDir, 'login-credentials.json'); }

/** Load or generate the encryption key. */
function getOrCreateKey() {
  const kf = keyFilePath();
  if (fs.existsSync(kf)) {
    const raw = fs.readFileSync(kf, 'utf8').trim();
    return Buffer.from(raw, 'base64');
  }
  // First use — generate a random key and persist it
  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(kf), { recursive: true });
  // mode 0o600: owner read/write only (no effect on Windows, but correct on Linux/Mac)
  fs.writeFileSync(kf, key.toString('base64'), { encoding: 'utf8', mode: 0o600 });
  return key;
}

/** Encrypt a plain JS object; returns a serialisable envelope. */
function encryptJson(obj, key) {
  const iv      = crypto.randomBytes(IV_BYTES);
  const cipher  = crypto.createCipheriv(ALGORITHM, key, iv);
  const plain   = JSON.stringify(obj);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return {
    iv:   iv.toString('base64'),
    tag:  cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
}

/** Decrypt an envelope produced by encryptJson; returns the original object. */
function decryptJson(envelope, key) {
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

/** Load the on-disk store; returns {} on missing or corrupt file. */
function loadStore() {
  const sf = storeFilePath();
  if (!fs.existsSync(sf)) return {};
  try {
    return JSON.parse(fs.readFileSync(sf, 'utf8'));
  } catch (_) {
    return {};
  }
}

/** Persist the store object to disk as formatted JSON. */
function saveStore(store) {
  const sf = storeFilePath();
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  fs.writeFileSync(sf, JSON.stringify(store, null, 2), 'utf8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise the store with the app's data directory.
 * Must be called once before any other function.
 * @param {string} dir  Path to the CH4C data directory (e.g. Constants.DATA_DIR).
 */
function init(dir) {
  _dataDir = dir || 'data';
}

/**
 * Return the decrypted credentials for siteId, or null if none are saved.
 * Returns null (not throws) on any error so callers don't need try/catch.
 * @param {string} siteId
 * @returns {{ username?, password?, tveProviderName?, tveProviderUsername?, tveProviderPassword? } | null}
 */
function getCredentials(siteId) {
  try {
    const store = loadStore();
    const entry = store[siteId];
    if (!entry) return null;
    return decryptJson(entry, getOrCreateKey());
  } catch (_) {
    // Corrupted entry or mismatched key — treat as not found
    return null;
  }
}

/**
 * Encrypt and save credentials for siteId.
 * Pass only the fields that are relevant; empty strings are stored as-is.
 * @param {string} siteId
 * @param {{ username?, password?, tveProviderName?, tveProviderUsername?, tveProviderPassword? }} creds
 */
function saveCredentials(siteId, creds) {
  const store = loadStore();
  store[siteId] = encryptJson(creds, getOrCreateKey());
  saveStore(store);
}

/**
 * Remove saved credentials for siteId.
 * No-op if none exist.
 * @param {string} siteId
 */
function clearCredentials(siteId) {
  const store = loadStore();
  if (siteId in store) {
    delete store[siteId];
    saveStore(store);
  }
}

module.exports = { init, getCredentials, saveCredentials, clearCredentials };
