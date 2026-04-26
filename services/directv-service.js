const { BaseService } = require('./base-service');

const DIRECTV_GUIDE_URL = 'https://stream.directv.com/guide';
const TUNE_TIMEOUT = 8000;

// Module-level channel cache — persists across fetchChannels calls within a session.
// Keyed by normalized channel name; value is the full channel entry from Redux state.
const directvChannelCache = new Map();
let directvFullyDiscovered = false;

/**
 * Clears the DirecTV channel cache and fully-discovered flag.
 * Called when the browser restarts so stale cached state doesn't carry over.
 */
function clearDirectvCache() {
  directvChannelCache.clear();
  directvFullyDiscovered = false;
}

// ─── DirecTV Service Class ────────────────────────────────────────────────────

class DirecTVService extends BaseService {
  constructor(browsers, Constants) {
    super('directv');
    this.browsers = browsers;
    this.Constants = Constants;
  }

  /**
   * Discovers the full DirecTV Stream channel lineup by navigating to the guide and
   * extracting the Redux store's channel array via page.evaluate.
   *
   * Uses page.waitForFunction + page.evaluate instead of evaluateOnNewDocument + console
   * bridging because rebrowser-puppeteer-core suppresses Runtime.enable (needed for
   * console event forwarding). Runtime.evaluate (used here) is unaffected.
   */
  async fetchChannels() {
    console.log('[DirecTVService] Fetching channels via Redux store extraction');

    // Always re-discover on each explicit refresh. The tune path uses page.evaluate
    // directly and does not depend on this cache, so clearing it is safe.
    directvFullyDiscovered = false;
    directvChannelCache.clear();

    const browserEntry = Array.from(this.browsers.entries())[0];
    if (!browserEntry) throw new Error('[DirecTVService] No browser available in pool');

    const [encoderUrl, browser] = browserEntry;
    if (!browser || !browser.isConnected()) throw new Error('[DirecTVService] Browser not connected');

    let page;
    try {
      console.log(`[DirecTVService] Using browser from encoder: ${encoderUrl}`);
      const pages = await browser.pages();
      page = pages.length > 0 ? pages[0] : await browser.newPage();
      if (!page) throw new Error('Failed to get browser page');

      // Step 1: Navigate and check login (domcontentloaded is fast; we poll for channels after)
      console.log('[DirecTVService] Checking login state and loading guide...');
      try {
        await page.goto(DIRECTV_GUIDE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (navErr) {
        throw new Error(`Could not reach DirecTV Stream: ${navErr.message}`);
      }

      const landedUrl = page.url();
      if (!landedUrl.includes('stream.directv.com')) {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        throw new Error(
          `Not logged in to DirecTV Stream (redirected to ${landedUrl}). ` +
          'Please log in via the Login Manager first, then refresh again.'
        );
      }
      console.log('[DirecTVService] Login confirmed — waiting for Redux channel data...');

      // Step 2: Poll for Redux store + channels. Channels are fetched async by the SPA
      // after the store initialises, so we poll until the array is non-empty (up to 20s).
      const channelsReadyFn = () => {
        const PREFIXES = ['__reactContainer$', '__reactFiber$', '__reactInternalInstance$'];
        const findKey = (el) => Object.keys(el).find(k => PREFIXES.some(p => k.startsWith(p)));
        let mountEl = document.getElementById('app-root');
        let rk = mountEl ? findKey(mountEl) : null;
        if (!rk) {
          mountEl = null;
          for (const c of Array.from(document.body.children)) {
            const k = findKey(c); if (k) { mountEl = c; rk = k; break; }
          }
        }
        if (!mountEl || !rk) return false;
        const val = mountEl[rk];
        const root = val && typeof val.current === 'object' ? val.current : val;
        if (!root) return false;
        const q = [root]; let v = 0;
        while (q.length && v < 5000) {
          const n = q.shift(); if (!n) break; v++;
          const p = n.pendingProps;
          const candidate = p && (p.store || (p.value && p.value.store));
          if (candidate && typeof candidate.getState === 'function') {
            const st = candidate.getState();
            const cs = st.channels;
            if (cs) {
              const arr = cs.channelArrays || cs.lineup || cs.channels || cs.allChannels;
              if (Array.isArray(arr) && arr.length > 0) return true;
            }
            return false;
          }
          if (n.child) q.push(n.child);
          if (n.sibling) q.push(n.sibling);
        }
        return false;
      };

      let channelsReady = false;
      try {
        await page.waitForFunction(channelsReadyFn, { timeout: 20000, polling: 400 });
        channelsReady = true;
      } catch (waitErr) {
        // SPA may do a full-document reload (guide → player); handle destroyed context
        if (waitErr.message && (waitErr.message.includes('context') || waitErr.message.includes('navigation'))) {
          try {
            await page.waitForFunction(channelsReadyFn, { timeout: 10000, polling: 400 });
            channelsReady = true;
          } catch { /* fall through */ }
        }
      }

      if (!channelsReady) {
        throw new Error(
          'DirecTV channel discovery timed out. The guide page loaded but the Redux store ' +
          'channel lineup was not found — the page may still be loading or the site structure may have changed.'
        );
      }

      // Step 3: Extract the full channel array from the Redux store
      const evaluateResult = await page.evaluate(() => {
        const PREFIXES = ['__reactContainer$', '__reactFiber$', '__reactInternalInstance$'];
        const findKey = (el) => Object.keys(el).find(k => PREFIXES.some(p => k.startsWith(p)));
        let mountEl = document.getElementById('app-root');
        let rk = mountEl ? findKey(mountEl) : null;
        if (!rk) {
          mountEl = null;
          for (const c of Array.from(document.body.children)) {
            const k = findKey(c); if (k) { mountEl = c; rk = k; break; }
          }
        }
        if (!mountEl || !rk) return [];
        const val = mountEl[rk];
        const root = val && typeof val.current === 'object' ? val.current : val;
        if (!root) return [];
        const q = [root]; let store = null; let v = 0;
        while (q.length && v < 5000) {
          const n = q.shift(); if (!n) break; v++;
          const p = n.pendingProps;
          const candidate = p && (p.store || (p.value && p.value.store));
          if (candidate && typeof candidate.getState === 'function') { store = candidate; break; }
          if (n.child) q.push(n.child);
          if (n.sibling) q.push(n.sibling);
        }
        if (!store) return [];
        const state = store.getState();
        let channels = [];
        if (state.channels) {
          const cs = state.channels;
          channels = cs.channelArrays || cs.lineup || cs.channels || cs.allChannels || [];
        }
        if (!channels.length && state.channelLineup) {
          const li = state.channelLineup;
          channels = li.channelArrays || li.channels || [];
        }
        // Pick the best logo from imageList — prefer color guide logo, fall back to first entry
        const pickLogo = (imageList) => {
          if (!Array.isArray(imageList) || imageList.length === 0) return '';
          const preferred = ['chlogo-clb-guide', 'chlogo-cdb-gcd', 'chlogo-bwdb-player'];
          for (const type of preferred) {
            const entry = imageList.find(img => img.imageType === type);
            if (entry && entry.imageUrl) return entry.imageUrl;
          }
          return imageList[0].imageUrl || '';
        };

        const channelData = channels
          .filter(ch => ch.channelName && ch.ccid)
          .map(ch => ({
            callSign: ch.callSign || '',
            channelId: ch.ccid || '',
            channelName: ch.channelName || '',
            resourceId: ch.resourceId || '',
            channelNumber: ch.channelNumber || '',
            // externalListingId is DirecTV's TMS/Gracenote station ID — used for EPG matching
            stationId: ch.externalListingId || ch.stationId || ch.tmsId || '',
            logo: pickLogo(ch.imageList)
          }));

        // Favorites investigation: guideContainer (has "My Channels" guide tab) and cachedChannels
        const guideContainer = state.guideContainer;
        const cachedChannels = state.channels && state.channels.cachedChannels;

        return {
          channelData,
          diag: {
            channelArraysCount: channels.length,
            // guideContainer — drives the guide's "My Channels" filter tab
            guideContainerKeys: guideContainer && typeof guideContainer === 'object' ? Object.keys(guideContainer) : [],
            guideContainerSample: guideContainer ? JSON.stringify(guideContainer).slice(0, 600) : null,
            // cachedChannels — may be user's pinned/favorited channel set
            cachedChannelsType: cachedChannels != null ? (Array.isArray(cachedChannels) ? 'array:' + cachedChannels.length : typeof cachedChannels) : 'null',
            cachedChannelsSample: cachedChannels ? JSON.stringify(cachedChannels).slice(0, 400) : null
          }
        };
      });

      const { channelData, diag } = evaluateResult;

      console.log(`[DirecTV-DIAG] channelArrays count: ${diag.channelArraysCount}`);
      console.log(`[DirecTV-DIAG] guideContainer keys: ${diag.guideContainerKeys.join(', ') || '(none)'}`);
      if (diag.guideContainerSample) console.log(`[DirecTV-DIAG] guideContainer sample: ${diag.guideContainerSample}`);
      console.log(`[DirecTV-DIAG] cachedChannels type: ${diag.cachedChannelsType}`);
      if (diag.cachedChannelsSample) console.log(`[DirecTV-DIAG] cachedChannels sample: ${diag.cachedChannelsSample}`);

      if (!channelData || channelData.length === 0) {
        throw new Error('DirecTV channel extraction returned empty results — Redux state shape may have changed.');
      }

      // Populate module-level cache
      const LOCAL_NETWORKS = new Set(['abc', 'cbs', 'cw', 'fox', 'nbc', 'pbs']);
      for (const network of LOCAL_NETWORKS) directvChannelCache.delete(network);

      for (const ch of channelData) {
        const normalized = ch.channelName.trim().replace(/\s+/g, ' ').toLowerCase();
        directvChannelCache.set(normalized, {
          callSign: ch.callSign,
          channelId: ch.channelId,
          displayName: ch.channelName,
          resourceId: ch.resourceId,
          channelNumber: ch.channelNumber || '',
          stationId: ch.stationId || '',
          logo: ch.logo || ''
        });
      }

      for (const network of LOCAL_NETWORKS) {
        if (directvChannelCache.has(network)) continue;
        const affiliates = [];
        for (const [key, entry] of directvChannelCache) {
          if (key.startsWith(network + '-')) affiliates.push({ key, entry });
        }
        if (affiliates.length > 0) {
          affiliates.sort((a, b) => a.key.localeCompare(b.key));
          directvChannelCache.set(network, affiliates[0].entry);
          console.log(`[DirecTV] Cache cross-reference: ${network} → ${affiliates[0].entry.displayName}`);
        }
      }

      directvFullyDiscovered = true;
      console.log(`[DirecTVService] Discovery complete: ${directvChannelCache.size} channels`);

      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
      return this._buildChannelArray();

    } catch (error) {
      console.error('[DirecTVService] Error fetching channels:', error.message);
      if (page) await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
      throw error;
    }
  }

  /**
   * Converts the channel cache to a normalized array sorted by display name.
   */
  _buildChannelArray() {
    const seen = new Set();
    const channels = [];

    for (const entry of directvChannelCache.values()) {
      if (seen.has(entry.displayName)) continue;
      seen.add(entry.displayName);

      const channelId = entry.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const normalized = this.normalizeChannel({
        name: entry.displayName,
        displayName: entry.displayName,
        id: `directv-${channelId}`,
        // All DirecTV channels share the same guide URL; the channel name is stored in cc
        // and passed as &channel= in the M3U URL so the stream endpoint can tune correctly.
        streamUrl: DIRECTV_GUIDE_URL,
        callSign: entry.callSign || entry.displayName,
        category: this.categorizeChannel(entry.displayName),
        channelNumber: entry.channelNumber || null,
        logo: entry.logo || ''
      });

      // cc stores the channel display name — used as the &channel= query param in the M3U URL.
      normalized.cc = entry.displayName;
      // stationId enables tvc-guide-stationid in the M3U for Channels DVR EPG matching.
      if (entry.stationId) normalized.stationId = entry.stationId;

      channels.push(normalized);
    }

    channels.sort((a, b) => a.name.localeCompare(b.name));
    return channels;
  }

  getFallbackChannels() {
    console.log('[DirecTVService] Using fallback placeholder channels');

    const placeholders = [
      { name: 'CNN', callSign: 'CNN', category: 'News' },
      { name: 'Fox News Channel', callSign: 'FNC', category: 'News' },
      { name: 'MSNBC', callSign: 'MSNBC', category: 'News' },
      { name: 'ESPN', callSign: 'ESPN', category: 'Sports' },
      { name: 'ESPN2', callSign: 'ESPN2', category: 'Sports' },
      { name: 'FS1', callSign: 'FS1', category: 'Sports' },
      { name: 'NFL Network', callSign: 'NFLN', category: 'Sports' },
      { name: 'TNT', callSign: 'TNT', category: 'Drama' },
      { name: 'TBS', callSign: 'TBS', category: 'Drama' },
      { name: 'USA Network', callSign: 'USA', category: 'Drama' },
      { name: 'AMC', callSign: 'AMC', category: 'Movies' },
      { name: 'HGTV', callSign: 'HGTV', category: 'Drama' },
      { name: 'Food Network', callSign: 'FOOD', category: 'Drama' },
      { name: 'Discovery', callSign: 'DSC', category: 'Drama' },
    ];

    return placeholders.map((ch, i) => {
      const channelId = ch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const normalized = this.normalizeChannel({
        name: ch.name,
        displayName: ch.name,
        id: `directv-${channelId}`,
        streamUrl: DIRECTV_GUIDE_URL,
        callSign: ch.callSign,
        category: ch.category
      });
      normalized.cc = ch.name;
      return normalized;
    });
  }

  categorizeChannel(name) {
    const n = name.toLowerCase();
    if (/nfl|nba|mlb|nhl|espn|fox sports|fs1|fs2|btn|golf|bein|acc|big ten|sec network|nascar|olympic/i.test(n)) return 'Sports';
    if (/cnn|fox news|msnbc|cnbc|headline|bloomberg|al jazeera|pbs newshour/i.test(n)) return 'News';
    if (/hbo|showtime|starz|mgm|amc|movie|cinema|paramount network/i.test(n)) return 'Movies';
    if (/bravo|fx$|fxm|fxx|hallmark|lifetime|a&e|aetv|history|investigation/i.test(n)) return 'Drama';
    if (/nick|disney|cartoon|boomerang|kids|family/i.test(n)) return 'Kids';
    return 'Other';
  }
}

module.exports = {
  DirecTVService,
  clearDirectvCache,
  DIRECTV_GUIDE_URL,
  TUNE_TIMEOUT
};
