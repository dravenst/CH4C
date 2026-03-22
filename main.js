// Handle service commands before loading the full application
if (process.argv[2] === 'service') {
  const { handleServiceCommand } = require('./service-manager');
  handleServiceCommand(process.argv.slice(3));
}

const express = require('express');
const puppeteer = require('rebrowser-puppeteer-core');
const { existsSync } = require('fs');
const { Readable } = require('stream');
const { execSync } = require('child_process');
const Constants = require('./constants.js');
const fetch = require('node-fetch');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { exec } = require('child_process');
const https = require('https');
const selfsigned = require('selfsigned');
const { logTS, getLogBuffer } = require('./logger');

const {
  EncoderHealthMonitor,
  BrowserHealthMonitor,
  BrowserRecoveryManager,
  StreamMonitor,
  validateEncoderConnection,
  setupBrowserCrashHandlers,
  safeStreamOperation,
  initializeBrowserPoolWithValidation
} = require('./error-handling');

const { AudioDeviceManager, DisplayManager } = require('./audio-device-manager');
const { CONFIG_METADATA, ENCODER_FIELDS, validateAllSettings, validateEncoder, saveConfig, loadConfig, getDefaults } = require('./config-manager');
const { LOGIN_SITES, loginEncoders } = require('./login-manager');
const credentialsStore = require('./credentials-store');

let chromeDataDir, chromePath;
let browsers = new Map(); // key: encoderUrl, value: {browser, page}
let launchMutex = new Map(); // key: encoderUrl, value: promise to prevent concurrent launches
const encoderDurationTimers = new Map(); // key: encoderUrl, value: setTimeout handle

function setEncoderDurationTimer(encoderUrl, fn, ms) {
  clearEncoderDurationTimer(encoderUrl);
  const handle = setTimeout(fn, ms);
  encoderDurationTimers.set(encoderUrl, handle);
}

function clearEncoderDurationTimer(encoderUrl) {
  const handle = encoderDurationTimers.get(encoderUrl);
  if (handle !== undefined) {
    clearTimeout(handle);
    encoderDurationTimers.delete(encoderUrl);
  }
}

/**
 * Cleanup all browsers on exit - prevents orphaned Chrome processes
 */
async function cleanupAllBrowsers() {
  if (browsers.size === 0) return;

  logTS(`Cleaning up ${browsers.size} browser(s) before exit...`);

  for (const [encoderUrl, browserInfo] of browsers) {
    try {
      if (browserInfo && browserInfo.browser) {
        await browserInfo.browser.close();
        logTS(`Closed browser for encoder: ${encoderUrl}`);
      }
    } catch (e) {
      logTS(`Error closing browser for ${encoderUrl}: ${e.message}`);
    }
  }
  browsers.clear();
}

// Handle uncaught exceptions - cleanup browsers before exit
process.on('uncaughtException', async (err) => {
  console.error('Uncaught Exception:', err);
  logTS(`FATAL: Uncaught exception: ${err.message}`);
  await cleanupAllBrowsers();
  process.exit(1);
});

// Handle unhandled promise rejections - cleanup browsers before exit
process.on('unhandledRejection', async (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  logTS(`FATAL: Unhandled promise rejection: ${reason}`);
  await cleanupAllBrowsers();
  process.exit(1);
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Search Prime Video for content and return the detail page URL.
 * Opens a new tab in the provided browser instance, navigates to the Prime Video
 * storefront, performs the search, clicks the first content result, and returns
 * the resulting page URL.
 */
/**
 * Parse a human-readable duration string (e.g. "53min", "1hr 30min") into minutes.
 */
function parseDurationMinutes(str) {
  if (!str) return null;
  // ISO 8601: PT2H30M, PT1H48M44S
  const isoMatch = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
  if (isoMatch && (isoMatch[1] || isoMatch[2])) {
    return (parseInt(isoMatch[1] || '0', 10) * 60 + parseInt(isoMatch[2] || '0', 10)) || null;
  }
  const hrMatch  = str.match(/(\d+)\s*h(?:r|our)?s?\b/i);
  const minMatch = str.match(/(\d+)\s*m(?:in|inutes?)?\b/i);
  const hours = hrMatch  ? parseInt(hrMatch[1],  10) : 0;
  const mins  = minMatch ? parseInt(minMatch[1], 10) : 0;
  return (hours * 60 + mins) || null;
}

async function searchPrimeVideo(page, query) {
  // Parse optional S#E# episode specifier from the query (e.g. "young sherlock s1 e1")
  const episodeMatch = query.match(/\bs(\d+)\s*e(\d+)\b/i);
  const targetSeason  = episodeMatch ? parseInt(episodeMatch[1], 10) : null;
  const targetEpisode = episodeMatch ? parseInt(episodeMatch[2], 10) : null;
  // Strip the S#E# token from the search term sent to Prime Video
  const searchTerm = query.replace(/\bs\d+\s*e\d+\b/i, '').trim();

  logTS(`Searching Prime Video for: "${searchTerm}"${targetSeason !== null ? ` (S${targetSeason} E${targetEpisode})` : ''}`);

  await page.goto('https://www.amazon.com/gp/video/storefront', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(2000);

  // Open the search dropdown
  await page.waitForSelector('[data-testid="pv-nav-search-dropdown-trigger"]', { timeout: 10000 });
  await page.click('[data-testid="pv-nav-search-dropdown-trigger"]');

  // Wait for the search input to appear
  await page.waitForSelector('#pv-search-nav', { timeout: 5000 });
  await delay(300);

  // Type the query and submit
  await page.type('#pv-search-nav', searchTerm, { delay: 40 });
  await page.keyboard.press('Enter');

  // Wait for the search results main container
  await page.waitForSelector('[data-testid="search"]', { timeout: 20000 });
  await delay(1000);

  // Find the first content result link scoped to search results container, avoiding promotional banners
  const firstResultLink = await page.$('[data-testid="search"] a[href*="/gp/video/detail/"]');
  if (!firstResultLink) {
    logTS(`No Prime Video results found for: "${searchTerm}"`);
    return null;
  }

  // Capture image from the first search result card's JPEG srcset (highest-res entry)
  const searchResultImageUrl = await page.evaluate(() => {
    const article = document.querySelector('[data-testid="search"] article');
    const srcSet = article?.querySelector('picture source[type="image/jpeg"]')?.srcset;
    if (!srcSet) return null;
    const entries = srcSet.trim().split(/,\s+/);
    const last = entries[entries.length - 1];
    return last ? last.split(' ')[0] : null;
  });

  const resultHref = await page.evaluate(el => el.href, firstResultLink);
  logTS(`Navigating to Prime Video detail page: ${resultHref}`);

  // Navigate to the detail page
  await page.goto(resultHref, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Holds episode metadata if found in list but play URL unavailable (used in ATF fallback)
  let foundEpisodeMeta = null;

  // If a specific season/episode was requested, find it in the episode list
  if (targetSeason !== null) {
    // Wait for episode list to appear before checking season selector
    await page.waitForSelector('li[data-testid="episode-list-item"]', { timeout: 10000 }).catch(() => {});

    // Check for a season selector and navigate to the correct season if needed.
    // Season links reliably use href pattern "season_select_sN" regardless of the
    // dropdown element's ID, which varies across shows.
    const targetSeasonLink = await page.$(`a[href*="season_select_s${targetSeason}"]`);
    if (targetSeasonLink) {
      const seasonHref = await page.evaluate(el => el.href, targetSeasonLink);
      logTS(`Season selector found — navigating to Season ${targetSeason}`);
      await page.goto(seasonHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('li[data-testid="episode-list-item"]', { timeout: 10000 }).catch(() => {});
    }

    // Scroll to reveal later episodes that may be lazy-loaded
    await page.evaluate(() => window.scrollBy(0, 800));

    // Episode list uses 0-based IDs: av-ep-episode-0 = E1, av-ep-episode-5 = E6, etc.
    const episodeItemId = `av-ep-episode-${targetEpisode - 1}`;
    await page.waitForSelector(`li[id="${episodeItemId}"]`, { timeout: 8000 }).catch(() => {});
    // Also wait for a proper play link to appear inside the episode item (JS may render it after the item)
    await page.waitForSelector(`li[id="${episodeItemId}"] a[href*="/gp/video/detail/"]`, { timeout: 5000 }).catch(() => {});

    const episodeData = await page.evaluate((itemId) => {
      const item = document.querySelector(`li[id="${itemId}"]`);
      if (!item) return null;
      const allItemLinks = [...item.querySelectorAll('a[href]')];
      const allPlayBtns  = allItemLinks.filter(a =>
        a.dataset.testid === 'episodes-playbutton' || a.dataset.testid === 'episode-play-button'
      );
      // Prefer a /gp/video/detail/ play link that is not a download
      const btn = allPlayBtns.find(a => a.href.includes('/gp/video/detail/') && !a.href.includes('action=download'))
               || allPlayBtns.find(a => a.href.startsWith('https://') && !a.href.includes('action=download'))
               || allItemLinks.find(a => a.href.includes('/gp/video/detail/') && !a.href.includes('action=download'));
      const epTitleEl   = item.querySelector('span.TuMJlk');
      const durationEl  = item.querySelector('[data-testid="episode-runtime"]');
      const synopsisEl  = item.querySelector('[data-automation-id^="synopsis-"] div[dir="auto"]');
      let imageUrl = null;
      const srcSet = item.querySelector('[data-testid="episode-packshot"] picture source[type="image/jpeg"]')?.srcset;
      if (srcSet) {
        const entries = srcSet.trim().split(/,\s+/);
        const last = entries[entries.length - 1];
        imageUrl = last ? last.split(' ')[0] : null;
      }
      return {
        href:         btn ? btn.href : null,
        episodeTitle: epTitleEl   ? epTitleEl.textContent.trim()    : null,
        durationStr:  durationEl  ? durationEl.textContent.trim()   : null,
        summary:      synopsisEl  ? synopsisEl.textContent.trim()   : null,
        imageUrl,
      };
    }, episodeItemId);

    logTS(`Prime Video episode lookup: itemId="${episodeItemId}" found=${episodeData !== null} href=${episodeData?.href || 'null'} title="${episodeData?.episodeTitle || ''}" duration="${episodeData?.durationStr || ''}"`);

    // Stash metadata for use in ATF fallback if we can't get a direct play URL
    if (episodeData) {
      foundEpisodeMeta = {
        episodeTitle:    episodeData.episodeTitle,
        durationStr:     episodeData.durationStr,
        summary:         episodeData.summary,
        imageUrl:        episodeData.imageUrl,
      };
    }

    // If no direct play URL found, click the episode packshot to navigate to the episode detail page
    // and use the ATF play button from there (same approach as the committed fallback)
    if (episodeData && !episodeData.href) {
      const packshot = await page.$(`li[id="${episodeItemId}"] [data-testid="episode-packshot"]`)
                    || await page.$(`li[id="${episodeItemId}"] h3`);
      if (packshot) {
        logTS(`Prime Video: no direct play URL — clicking episode to navigate to detail page`);
        const preClickUrl = page.url();
        await packshot.click().catch(() => {});
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        const episodePage = page.url();
        if (episodePage !== preClickUrl && episodePage.includes('/gp/video/detail/')) {
          logTS(`Prime Video: navigated to episode detail page: ${episodePage}`);
          const atfBtn = await page.$('a[data-testid="dp-atf-play-button"]');
          episodeData.href = atfBtn
            ? await page.evaluate(el => el.href, atfBtn)
            : episodePage + (episodePage.includes('?') ? '&' : '?') + 'autoplay=1&t=0';
        }
      }
    }

    if (episodeData && episodeData.href) {
      // Grab show title from the detail page
      const epShowTitle = await page.evaluate(() => {
        const raw = document.querySelector('meta[property="og:title"]')?.content
          || document.querySelector('h1[data-automation-id="title"]')?.textContent?.trim()
          || document.title || '';
        return raw.replace(/^Watch\s+/i, '')
                  .replace(/\s*[-|]\s*(Amazon|Prime\s*Video|Watch|Stream).*$/i, '')
                  .replace(/\s*[-–]\s*Season\s+\d+\s*$/i, '')
                  .trim() || null;
      });
      logTS(`Found Prime Video episode S${targetSeason} E${targetEpisode} URL: ${episodeData.href} | showTitle: "${epShowTitle}" | durationStr: "${episodeData.durationStr}" | durationMinutes: ${parseDurationMinutes(episodeData.durationStr)}`);
      return {
        url:             episodeData.href,
        title:           epShowTitle,
        episodeTitle:    episodeData.episodeTitle,
        seasonNumber:    targetSeason,
        episodeNumber:   targetEpisode,
        durationMinutes: parseDurationMinutes(episodeData.durationStr),
        summary:         episodeData.summary,
        imageUrl:        episodeData.imageUrl || searchResultImageUrl,
      };
    }
    logTS(`Episode S${targetSeason} E${targetEpisode} not found in episode list, falling back to ATF play button`);
  }

  // No episode specified (or episode not found) — use the ATF play button or circular watch button
  // Covers Watch Now, Continue Watching, Resume, and live event buttons
  await page.waitForSelector(
    'a[data-testid="dp-atf-play-button"], a[data-testid="circular-playbutton"], a[href*="atv_plr_detail"]',
    { timeout: 8000 }
  ).catch(() => {});
  const watchLink = await page.$(
    'a[data-testid="dp-atf-play-button"], a[data-testid="circular-playbutton"], ' +
    'a[href*="atv_plr_detail_play"], a[href*="atv_plr_detail"]'
  );
  if (watchLink) {
    // Grab page metadata before clicking (still visible behind any modal)
    const { rawTitle, durationStr, summary } = await page.evaluate(() => {
      return {
        rawTitle:    document.querySelector('meta[property="og:title"]')?.content
                     || document.querySelector('h1[data-automation-id="title"]')?.textContent?.trim()
                     || document.title || '',
        durationStr: document.querySelector('[data-automation-id="runtime-badge"]')?.textContent?.trim()
                     || document.querySelector('[data-testid="runtime"]')?.textContent?.trim() || null,
        summary:     document.querySelector('.dv-dp-node-synopsis span._1H6ABQ')?.textContent?.trim()
                     || document.querySelector('.dv-dp-node-synopsis')?.textContent?.trim()
                     || document.querySelector('span._1H6ABQ')?.textContent?.trim()
                     || null,
      };
    });
    const showTitle = rawTitle.replace(/^Watch\s+/i, '')
                              .replace(/\s*[-|]\s*(Amazon|Prime\s*Video|Watch|Stream).*$/i, '')
                              .trim() || null;

    // Get raw href (null if button has no href, e.g. circular-playbutton)
    const watchHref = await page.evaluate(el => el.getAttribute('href')
      ? el.href  // full resolved URL
      : null, watchLink);

    // Click the button and check if a live event modal appears
    const preClickUrl = page.url();
    await watchLink.click();
    await page.waitForSelector('[data-testid="stream-selector-content"]', { timeout: 3000 }).catch(() => {});

    const liveHref = await page.evaluate(() => {
      // Prefer "Watch from beginning" (t=0); fall back to any play link in the modal
      const wfbLink = document.querySelector('[data-testid="stream-selector-content"] a[href*="t=0"]')
        || document.querySelector('[data-testid="stream-selector-content"] a[data-testid="play"]');
      return wfbLink?.href || null;
    });

    // If no modal and no href, check if clicking navigated us to a playback page
    const postClickUrl = page.url();
    const navigatedUrl = (postClickUrl !== preClickUrl) ? postClickUrl : null;

    const finalUrl = liveHref || watchHref || navigatedUrl || preClickUrl;
    logTS(`Found Prime Video Watch URL: ${finalUrl} | showTitle: "${showTitle}" | live modal: ${!!liveHref}`);
    return {
      url:             finalUrl,
      title:           showTitle,
      episodeTitle:    foundEpisodeMeta?.episodeTitle    || null,
      seasonNumber:    foundEpisodeMeta ? targetSeason   : null,
      episodeNumber:   foundEpisodeMeta ? targetEpisode  : null,
      durationMinutes: parseDurationMinutes(foundEpisodeMeta?.durationStr || durationStr),
      summary:         foundEpisodeMeta?.summary         || summary,
      imageUrl:        foundEpisodeMeta?.imageUrl        || searchResultImageUrl,
    };
  }

  // Fallback: return the detail page URL itself with whatever title we can get
  const fallbackTitle = await page.evaluate(() => document.querySelector('meta[property="og:title"]')?.content || null);
  logTS(`Watch Now button not found, returning detail page URL: ${page.url()}`);
  return { url: page.url(), title: fallbackTitle, episodeTitle: null, seasonNumber: null, episodeNumber: null, durationMinutes: null, imageUrl: searchResultImageUrl };
}

/**
 * Search Disney+ for content and return the watch URL.
 */
async function searchDisneyPlus(page, query) {
  const episodeMatch  = query.match(/\bs(\d+)\s*e(\d+)\b/i);
  const targetSeason  = episodeMatch ? parseInt(episodeMatch[1], 10) : null;
  const targetEpisode = episodeMatch ? parseInt(episodeMatch[2], 10) : null;
  const searchTerm    = query.replace(/\bs\d+\s*e\d+\b/i, '').trim();

  logTS('Navigating to Disney+');
  await page.goto('https://www.disneyplus.com/home', { waitUntil: 'networkidle2', timeout: 30000 });

  // Click the search icon in the nav
  await page.waitForSelector('a[data-testid="navigation-item-search"]', { timeout: 10000 });
  await page.click('a[data-testid="navigation-item-search"]');

  // Type search query
  logTS(`Disney+: searching for "${searchTerm}"`);
  const searchInput = await page.waitForSelector('input#searchInput, input[name="search input"]', { timeout: 10000 });
  await searchInput.click({ clickCount: 3 });
  // Grab the current first result so we can wait for it to change after typing
  const initialFirstItemId = await page.evaluate(() =>
    document.querySelector('a[data-testid="set-item"]')?.getAttribute('data-item-id') || ''
  );

  await searchInput.type(searchTerm, { delay: 60 });

  // Wait for search debounce + network round-trip, then confirm results updated
  await delay(3000);
  await page.waitForFunction(
    (prevId) => {
      const el = document.querySelector('a[data-testid="set-item"]');
      return el && el.getAttribute('data-item-id') !== prevId;
    },
    { timeout: 10000 },
    initialFirstItemId
  ).catch(() => { /* proceed anyway if still timed out */ });

  // Capture first result title and image before clicking
  const { firstResultTitle, searchResultImageUrl } = await page.evaluate(() => {
    const el = document.querySelector('a[data-testid="set-item"]');
    if (!el) return { firstResultTitle: null, searchResultImageUrl: null };
    const ariaLabel = el.getAttribute('aria-label') || '';
    // Strip leading badge prefixes ("Season Finale Badge ", "New Episode Badge ", etc.)
    const cleaned = ariaLabel.replace(/^(?:[\w\s]+?\s+Badge\s+)+/i, '');
    const title = cleaned.replace(/\s+(Disney\+?|FOX|ABC|ESPN|Hulu|FX|Nat\s*Geo|Rated|Released|Select|Unrated).*$/i, '').trim() || null;
    const imgEl = el.querySelector('img');
    let imageUrl = null;
    const srcset = imgEl?.getAttribute('srcset') || '';
    if (srcset) {
      const entries = srcset.trim().split(/,\s+/);
      const last = entries[entries.length - 1];
      imageUrl = last ? last.split(' ')[0] : null;
    }
    if (!imageUrl) imageUrl = imgEl?.getAttribute('src') || null;
    return { firstResultTitle: title, searchResultImageUrl: imageUrl };
  });
  logTS(`Disney+: first result: "${firstResultTitle}"`);

  // Click first result and navigate to detail page
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    page.click('a[data-testid="set-item"]'),
  ]);

  const detailUrl = page.url();
  logTS(`Disney+ navigated to detail page: ${detailUrl}`);

  // Extract show title — prefer h1 on the page, fall back to firstResultTitle
  // og:title on Disney+ entity pages returns the generic "Disney+ | Movies and Shows"
  const showTitle = await page.evaluate(() => {
    // Title treatment image alt is most reliable (e.g. alt="The Beauty"), avoids badge text
    const titleImg = document.querySelector('[data-testid="details-title-treatment"] img[alt]')?.getAttribute('alt')?.trim();
    if (titleImg) return titleImg;
    const h1 = document.querySelector('h1')?.textContent?.trim() || null;
    if (h1 && !h1.toLowerCase().includes('disney')) return h1;
    return null;
  }) || firstResultTitle;

  if (targetSeason && targetEpisode) {
    // Wait for episode items to load (they have /play/ hrefs)
    await page.waitForSelector('a[data-testid="set-item"][href^="/play/"]', { timeout: 10000 })
              .catch(() => logTS('Disney+: timed out waiting for episode list'));

    // Switch to the correct season if needed
    const currentSeason = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="dropdown-button"]');
      return btn ? parseInt(btn.textContent?.match(/Season\s+(\d+)/i)?.[1] || '1', 10) : 1;
    });

    if (currentSeason !== targetSeason) {
      logTS(`Disney+: switching from Season ${currentSeason} to Season ${targetSeason}`);
      await page.click('[data-testid="dropdown-button"]');
      await page.waitForSelector('[role="option"]', { timeout: 5000 });
      const clicked = await page.evaluate((season) => {
        const options = document.querySelectorAll('[role="option"]');
        for (const opt of options) {
          if (opt.textContent?.includes(`Season ${season}`)) {
            opt.click();
            return true;
          }
        }
        return false;
      }, targetSeason);
      if (!clicked) {
        logTS(`Disney+: Season ${targetSeason} not found in dropdown`);
      } else {
        // Wait for the episode list to reload after season change
        await page.waitForSelector('a[data-testid="set-item"][href^="/play/"]', { timeout: 8000 })
                  .catch(() => {});
      }
    }

    logTS(`Disney+: looking for S${targetSeason}E${targetEpisode} in episode list`);

    // Find the target episode
    const episodeData = await page.evaluate((season, episode) => {
      const label = `Season ${season} Episode ${episode}`;
      const items = document.querySelectorAll('a[data-testid="set-item"]');
      for (const item of items) {
        const ariaLabel = item.getAttribute('aria-label') || '';
        if (!ariaLabel.includes(label)) continue;
        const href = item.getAttribute('href') || '';
        const uuid = href.replace('/play/', '') || null;
        // Episode title: strip leading "N. " number prefix
        const rawTitle = item.querySelector('[data-testid="standard-regular-list-item-title"] div')
                             ?.textContent?.trim() || null;
        const episodeTitle = rawTitle?.replace(/^\d+\.\s*/, '') || null;
        const description = item.querySelector('[data-testid="standard-regular-list-item-description"]')
                                ?.textContent?.trim() || null;
        // Duration: accessible span "24 Minutes,57s"
        const durText = item.querySelector('span.ldzmls0')?.textContent?.trim() || null;
        const imgEl = item.querySelector('img');
        let imageUrl = null;
        const srcset = imgEl?.getAttribute('srcset') || '';
        if (srcset) {
          const entries = srcset.trim().split(/,\s+/);
          const last = entries[entries.length - 1];
          imageUrl = last ? last.split(' ')[0] : null;
        }
        if (!imageUrl) imageUrl = imgEl?.getAttribute('src') || null;
        return { uuid, episodeTitle, description, durText, imageUrl };
      }
      return null;
    }, targetSeason, targetEpisode);

    if (episodeData?.uuid) {
      const watchUrl = `https://www.disneyplus.com/play/${episodeData.uuid}`;
      // Parse "24 Minutes,57s" or "1 Hours,24 Minutes,30s" using existing helper
      const durationMinutes = parseDurationMinutes(episodeData.durText);
      logTS(`Disney+: found S${targetSeason}E${targetEpisode} uuid="${episodeData.uuid}"`);
      return {
        url:             watchUrl,
        title:           showTitle || firstResultTitle,
        episodeTitle:    episodeData.episodeTitle,
        seasonNumber:    targetSeason,
        episodeNumber:   targetEpisode,
        durationMinutes,
        summary:         episodeData.description,
        imageUrl:        episodeData.imageUrl || searchResultImageUrl,
      };
    }
    logTS(`Disney+: episode S${targetSeason} E${targetEpisode} not found`);
  }

  // No episode specified — wait for masthead to load, then grab play URL and duration
  await page.waitForSelector('[data-testid="masthead-metadata"]', { timeout: 8000 }).catch(() => {});

  const { playHref, movieDurText, movieSummary } = await page.evaluate(() => {
    const btn = document.querySelector('a[data-testid="playback-action-button"][href^="/play/"]');
    // Duration is in span.ldzmls0 inside masthead-metadata, e.g. "2 Hours,34s • Action..."
    const durRaw = document.querySelector('[data-testid="masthead-metadata"] span.ldzmls0')
                           ?.textContent?.trim() || null;
    const durText = durRaw ? durRaw.split('•')[0].trim() : null;
    const summary = document.querySelector('[data-testid="details-featured-description"]')
                             ?.textContent?.trim() || null;
    return { playHref: btn?.getAttribute('href') || null, movieDurText: durText, movieSummary: summary };
  });

  const playUrl = playHref ? `https://www.disneyplus.com${playHref}` : detailUrl;
  const durationMinutes = parseDurationMinutes(movieDurText);
  logTS(`Disney+ movie: url="${playUrl}" duration="${movieDurText}" (${durationMinutes} min)`);

  return {
    url:             playUrl,
    title:           showTitle || firstResultTitle,
    episodeTitle:    null,
    seasonNumber:    targetSeason,
    episodeNumber:   targetEpisode,
    durationMinutes,
    summary:         movieSummary,
    imageUrl:        searchResultImageUrl,
  };
}

/**
 * Search Max (HBO Max) for content and return the watch URL.
 */
async function searchMax(page, query) {
  const episodeMatch  = query.match(/\bs(\d+)\s*e(\d+)\b/i);
  const targetSeason  = episodeMatch ? parseInt(episodeMatch[1], 10) : null;
  const targetEpisode = episodeMatch ? parseInt(episodeMatch[2], 10) : null;
  const searchTerm    = query.replace(/\bs\d+\s*e\d+\b/i, '').trim();

  logTS(`Searching Max for: "${searchTerm}"${targetSeason !== null ? ` (S${targetSeason} E${targetEpisode})` : ''}`);

  // Navigate to Max/HBO Max home, click search, type query
  await page.goto('https://play.hbomax.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('[data-testid="search_button"]', { timeout: 10000 });
  await page.click('[data-testid="search_button"]');

  const searchInput = await page.waitForSelector('[data-testid="searchBar_field"]', { timeout: 8000 });
  await searchInput.click({ clickCount: 3 });
  await searchInput.type(searchTerm, { delay: 60 });

  // Wait for search results — tiles use data-testid ending in "_tile"
  await page.waitForSelector('a[data-testid$="_tile"]', { timeout: 15000 }).catch(() => {});
  await delay(1000);

  // Capture first result title, image, and href
  const { firstResultTitle, searchResultImageUrl, firstResultHref } = await page.evaluate(() => {
    const tile = document.querySelector('a[data-testid$="_tile"]');
    if (!tile) return { firstResultTitle: null, searchResultImageUrl: null, firstResultHref: null };
    // Use aria-label for title (more reliable than span which may contain badge text)
    // Fall back to last span[dir="auto"] that isn't a known badge phrase
    // aria-label format: "Industry. Row 1 of 13, Column 1 of 4. New Episode. Rated TV-MA. 4 Seasons"
    // Strip Unicode chars then take everything before the ". Row " grid position suffix
    let title = tile.getAttribute('aria-label')?.replace(/[\u2066-\u2069]/g, '').replace(/\.\s*Row\s+\d+.*$/i, '').trim() || null;
    const href = tile.getAttribute('href') || null;
    const imgEl = tile.querySelector('img');
    let imageUrl = null;
    const srcset = imgEl?.getAttribute('srcset') || '';
    if (srcset) {
      // Max srcset entries are comma-separated without spaces: "url 200w,url 250w,..."
      const entries = srcset.trim().split(',');
      const last = entries[entries.length - 1].trim();
      imageUrl = last ? last.split(' ')[0] : null;
    }
    if (!imageUrl) imageUrl = imgEl?.getAttribute('src') || null;
    return { firstResultTitle: title, searchResultImageUrl: imageUrl, firstResultHref: href };
  });
  logTS(`Max: first result: "${firstResultTitle}"`);

  if (!firstResultHref) {
    throw new Error(`No Max results found for: "${searchTerm}"`);
  }

  // Normalize URL — always use play.hbomax.com (the active streaming domain)
  const normalizeMaxUrl = (href) => {
    let url = href.startsWith('http') ? href : `https://play.hbomax.com${href}`;
    return url.replace(/\/\/(?:www\.)?(?:hbomax|max)\.com/, '//play.hbomax.com');
  };

  const detailUrl = normalizeMaxUrl(firstResultHref);
  await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  // Extract show title from page
  const showTitle = await page.evaluate(() => {
    return document.querySelector('h1[data-testid="title"], h1[class*="Title"], h1')?.textContent?.trim() || null;
  }) || firstResultTitle;

  // If a specific season/episode was requested, find it in the episode list
  if (targetSeason !== null) {
    // Scroll down to trigger lazy-load of episode tiles (only needed for shows)
    await page.evaluate(() => window.scrollBy(0, 800));
    await delay(1500);
    await page.waitForSelector('a[data-testid$="_tile"][data-sonic-type="video"]', { timeout: 10000 }).catch(() => {});
    // Use the specific episodes tab season dropdown (not tile action menu dropdowns)
    const seasonDropdownSel = '[data-testid="generic-show-page-rail-episodes-tabbed-content_dropdown"] button[aria-haspopup]';

    // Read currently displayed season
    const currentSeason = await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      const text = btn?.querySelector('span')?.textContent?.trim() || '';
      return parseInt(text.match(/\d+/)?.[0] || '1', 10);
    }, seasonDropdownSel);

    logTS(`Max: page is on Season ${currentSeason}, target is Season ${targetSeason}`);

    if (currentSeason !== targetSeason) {
      logTS(`Max: switching to Season ${targetSeason}`);
      // Click the season dropdown to open it
      await page.click(seasonDropdownSel).catch(() => {});
      await delay(1000);
      // Click the matching season option — options may use role="option", li, or button
      const clicked = await page.evaluate((season) => {
        const candidates = document.querySelectorAll('[role="option"], [role="listbox"] li, [role="listbox"] button, ul[role="menu"] li, ul[role="menu"] button');
        for (const opt of candidates) {
          if (opt.textContent?.trim().includes(`Season ${season}`)) {
            opt.click();
            return true;
          }
        }
        return false;
      }, targetSeason);
      if (clicked) {
        // Scroll and wait for new season tiles to load
        await delay(1000);
        await page.evaluate(() => window.scrollBy(0, 800));
        await delay(1000);
        await page.waitForSelector('a[data-testid$="_tile"][data-sonic-type="video"]', { timeout: 10000 }).catch(() => {});
      }
    }

    // Log how many episode tiles are visible for debugging
    const tileCount = await page.evaluate(() =>
      document.querySelectorAll('a[data-testid$="_tile"][data-sonic-type="video"]').length
    );
    logTS(`Max: found ${tileCount} episode tile(s) on page`);

    // Find target episode tile using aria-label matching
    const episodeData = await page.evaluate((season, episode) => {
      const matchLabel = `Season ${season}, Episode ${episode}:`;
      const tiles = document.querySelectorAll('a[data-testid$="_tile"][data-sonic-type="video"]');
      for (const tile of tiles) {
        const ariaLabel = tile.getAttribute('aria-label') || '';
        // Strip Unicode directional embedding chars for matching
        const cleanLabel = ariaLabel.replace(/[\u2066-\u2069]/g, '');
        if (!cleanLabel.includes(matchLabel)) continue;

        const href = tile.getAttribute('href') || null;

        // Title: strip "E{N}: " prefix and Unicode embedding chars
        let episodeTitle = null;
        const titleSpan = tile.querySelector('span[dir="auto"]');
        if (titleSpan) {
          episodeTitle = titleSpan.textContent
            .replace(/[\u2066-\u2069]/g, '')
            .replace(/^E\d+:\s*/, '')
            .trim() || null;
        }

        // Duration from metadata_duration span
        const durationStr = tile.querySelector('span[data-testid="metadata_duration"]')?.textContent?.trim() || null;

        // Description from last p[dir="auto"]
        const descEls = tile.querySelectorAll('p[dir="auto"]');
        const summary = descEls.length ? descEls[descEls.length - 1].textContent?.trim() || null : null;

        // Image from srcset (Max: comma-separated without spaces)
        const imgEl = tile.querySelector('img');
        let imageUrl = null;
        const srcset = imgEl?.getAttribute('srcset') || '';
        if (srcset) {
          const entries = srcset.trim().split(',');
          const last = entries[entries.length - 1].trim();
          imageUrl = last ? last.split(' ')[0] : null;
        }
        if (!imageUrl) imageUrl = imgEl?.getAttribute('src') || null;

        return { href, episodeTitle, durationStr, summary, imageUrl };
      }
      return null;
    }, targetSeason, targetEpisode);

    if (episodeData?.href) {
      const watchUrl = normalizeMaxUrl(episodeData.href);
      logTS(`Max: found S${targetSeason}E${targetEpisode} url="${watchUrl}"`);
      return {
        url:             watchUrl,
        title:           showTitle,
        episodeTitle:    episodeData.episodeTitle,
        seasonNumber:    targetSeason,
        episodeNumber:   targetEpisode,
        durationMinutes: parseDurationMinutes(episodeData.durationStr),
        summary:         episodeData.summary,
        imageUrl:        episodeData.imageUrl || searchResultImageUrl,
      };
    }
    logTS(`Max: episode S${targetSeason}E${targetEpisode} not found in episode list`);
  }

  // Movie or show without episode — extract metadata and click the main play button
  const { durationStr, movieSummary } = await page.evaluate(() => {
    // Duration uses same testid as episode tiles
    const durEl = document.querySelector('span[data-testid="metadata_duration"]');
    // Description is a direct child p[dir="auto"] of the info block (not the hidden metadata label)
    const descEl = document.querySelector('[data-testid="infoBlockFullContent"] > p[dir="auto"]');
    return {
      durationStr:  durEl?.textContent?.trim() || null,
      movieSummary: descEl?.textContent?.trim() || null,
    };
  });

  // Click the main watch button (not the trailer button) and capture the resulting URL.
  // The main button is inside div[data-capability="default"], the trailer button is not.
  let playUrl = detailUrl;
  const playBtnExists = await page.$('div[data-capability="default"] button[data-testid="play_button"]').then(el => !!el).catch(() => false);
  if (playBtnExists) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {}),
      page.click('div[data-capability="default"] button[data-testid="play_button"]').catch(() => {}),
    ]);
    playUrl = page.url();
    if (!playUrl || playUrl === 'about:blank') playUrl = detailUrl;
  } else {
    // Fallback: look for a direct video anchor link
    const videoHref = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/video/watch/"]');
      return a?.getAttribute('href') || null;
    });
    if (videoHref) playUrl = videoHref.startsWith('http') ? videoHref : `https://www.max.com${videoHref}`;
  }

  logTS(`Max: url="${playUrl}" duration="${durationStr}"`);

  return {
    url:             playUrl,
    title:           showTitle,
    episodeTitle:    null,
    seasonNumber:    targetSeason,
    episodeNumber:   targetEpisode,
    durationMinutes: parseDurationMinutes(durationStr),
    summary:         movieSummary,
    imageUrl:        searchResultImageUrl,
  };
}

/**
 * Search Peacock TV for content and return the watch URL.
 */
async function searchPeacock(page, query) {
  const episodeMatch  = query.match(/\bs(\d+)\s*e(\d+)\b/i);
  const targetSeason  = episodeMatch ? parseInt(episodeMatch[1], 10) : null;
  const targetEpisode = episodeMatch ? parseInt(episodeMatch[2], 10) : null;
  const searchTerm    = query.replace(/\bs\d+\s*e\d+\b/i, '').trim();

  // Navigate to Peacock home
  logTS('Navigating to Peacock TV');
  await page.goto('https://www.peacocktv.com', { waitUntil: 'networkidle2', timeout: 30000 });

  // Handle profile selection page if redirected (URL contains /watch/profiles)
  if (page.url().includes('/watch/profiles')) {
    logTS('Peacock profile selection page detected — selecting first profile');
    // The profile avatar is a div.profiles__avatar--image[role="button"]
    const profileSel = '.profiles__avatar--image[role="button"]';
    try {
      const profileEl = await page.waitForSelector(profileSel, { timeout: 8000 });
      await profileEl.click();
      await page.waitForFunction(() => !window.location.href.includes('/watch/profiles'), { timeout: 15000 });
      logTS(`Peacock profile selected — now at: ${page.url()}`);
    } catch (e) {
      logTS(`Peacock: could not click profile — ${e.message}`);
      throw new Error('Peacock profile selection failed. Check that a profile is set up in the browser.');
    }
  }

  // Navigate to search page and type query
  logTS(`Peacock: searching for "${searchTerm}"`);
  await page.goto(`https://www.peacocktv.com/watch/search`, { waitUntil: 'networkidle2', timeout: 20000 });

  // If redirected to profiles again, something went wrong
  if (page.url().includes('/watch/profiles')) {
    throw new Error('Peacock redirected to profile page after selection — login may have been lost.');
  }

  // Find the search input and type the query
  const searchInput = await page.waitForSelector(
    'input[type="search"], input[aria-label*="search" i], input[placeholder*="search" i], input[data-testid*="search" i]',
    { timeout: 10000 }
  );
  await searchInput.click({ clickCount: 3 });
  await delay(500); // ensure input is focused and ready

  // Capture the initial first result title (default/trending results) so we can detect the update
  const initialFirstTitle = await page.evaluate(() => {
    const el = document.querySelector('ul[data-testid="search-results-grid"] li[data-testid="collection-tile"] h4[data-testid="title"]');
    return el ? el.textContent.trim() : '__none__';
  });

  await searchInput.type(searchTerm, { delay: 60 });

  // Wait for results to update away from the initial default results
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector('ul[data-testid="search-results-grid"] li[data-testid="collection-tile"] h4[data-testid="title"]');
      return el && el.textContent.trim() !== prev;
    },
    { timeout: 15000 },
    initialFirstTitle
  ).catch(() => {});

  // Wait for results grid (in case it wasn't present initially)
  await page.waitForSelector('ul[data-testid="search-results-grid"] li[data-testid="collection-tile"]', { timeout: 5000 }).catch(() => {});

  // Get the title and image of the first result
  const { firstTitle, searchResultImageUrl } = await page.evaluate(() => {
    const tile = document.querySelector('ul[data-testid="search-results-grid"] li[data-testid="collection-tile"]');
    const titleEl = tile?.querySelector('h4[data-testid="title"]');
    const imgEl = tile?.querySelector('img');
    // Prefer srcset (pick highest-res entry) over src
    let imageUrl = null;
    const srcset = imgEl?.srcset;
    if (srcset) {
      const entries = srcset.trim().split(/,\s+/);
      const last = entries[entries.length - 1];
      imageUrl = last ? last.split(' ')[0] : null;
    }
    if (!imageUrl && imgEl?.src) imageUrl = imgEl.src;
    return { firstTitle: titleEl ? titleEl.textContent.trim() : null, searchResultImageUrl: imageUrl };
  });
  logTS(`Peacock search results loaded — first result: "${firstTitle}"`);

  // Intercept key Peacock API responses — set up BEFORE clicking first result
  const capturedApiResponses = [];
  const captureHandler = async (response) => {
    try {
      const url = response.url();
      if (!url.includes('atom.peacocktv.com') &&
          !url.includes('bff-ext.clients.peacocktv.com')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const json = await response.json().catch(() => null);
      if (!json) return;
      logTS(`Peacock API captured: ${url.substring(0, 100)}`);
      capturedApiResponses.push({ url, json });
    } catch (e) { /* ignore */ }
  };
  page.on('response', captureHandler);

  // Click the first result and navigate to the detail page
  const firstResult = await page.$('ul[data-testid="search-results-grid"] li[data-testid="collection-tile"] [role="link"]');
  if (!firstResult) {
    page.off('response', captureHandler);
    throw new Error('No search results found on Peacock');
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
    firstResult.click(),
  ]);

  const detailUrl = page.url();
  logTS(`Peacock navigated to detail page: ${detailUrl}`);

  // Live events navigate directly to a playback URL — skip episode tab wait
  const isPlaybackUrl = detailUrl.includes('/watch/playback/');

  // Click Episodes tab to trigger BFF rails API calls for episode list
  if (!isPlaybackUrl) {
    try {
      const episodesBtn = await page.waitForSelector('[data-testid="episodes-button"]', { timeout: 8000 });
      await episodesBtn.click();
      // Wait for episode tiles to appear in the DOM rather than a fixed delay
      await page.waitForSelector('[data-testid="episode-tile"]', { timeout: 10000 }).catch(() => {});
      logTS('Peacock: clicked Episodes tab, waiting for API responses');
    } catch (e) {
      logTS(`Peacock: episodes button not found — ${e.message}`);
    }
  } else {
    logTS('Peacock: live event — waiting for playback overlay to render');
    await page.waitForSelector(
      'h1[data-testid="metadata-title"], span[data-testid="header-title"], p[data-testid="metadata-description"]',
      { timeout: 10000 }
    ).catch(() => {});
    await delay(1000);
  }

  page.off('response', captureHandler);
  logTS(`Peacock: captured ${capturedApiResponses.length} API responses total`);

  // Extract show title — prefer title logo alt (detail pages) or metadata-title (live playback overlay)
  const showTitle = await page.evaluate(() => {
    const logoAlt = document.querySelector('img[data-shared-id="title-logo"]')?.getAttribute('alt')?.trim();
    if (logoAlt && logoAlt.length > 0) return logoAlt;
    const liveTitle = document.querySelector('h1[data-testid="metadata-title"]')?.textContent?.trim();
    if (liveTitle) return liveTitle;
    const headerTitle = document.querySelector('span[data-testid="header-title"]')?.textContent?.trim();
    if (headerTitle) return headerTitle;
    const raw = document.querySelector('meta[property="og:title"]')?.content
      || document.querySelector('h1[data-testid="title"]')?.textContent?.trim()
      || document.querySelector('h1')?.textContent?.trim()
      || document.title || '';
    return raw.replace(/\s*[|\-–]\s*Peacock.*$/i, '')
               .replace(/\s*[-–]\s*Season\s+\d+\s*$/i, '')
               .trim() || null;
  });

  // If a specific episode was requested, search captured API responses for it
  if (targetSeason && targetEpisode) {
    const findEpisode = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 10) return null;
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const r = findEpisode(item, depth + 1);
          if (r) return r;
        }
      } else {
        const sn = parseInt(obj.seasonNumber ?? obj.season_number ?? obj.season ?? -1, 10);
        const en = parseInt(obj.episodeNumber ?? obj.episode_number ?? obj.episodeNum
                         ?? obj.number ?? obj.order ?? -1, 10);
        if (sn === targetSeason && en === targetEpisode) return obj;
        // Match on episode number alone if object has title + id/slug (episode-like)
        if (sn === -1 && en === targetEpisode && (obj.title || obj.name || obj.episodeName)
            && (obj.id || obj.guid || obj.slug || obj.programmeUuid)) return obj;
        for (const val of Object.values(obj)) {
          const r = findEpisode(val, depth + 1);
          if (r) return r;
        }
      }
      return null;
    };

    // Scan the episode tile DOM for the matching episode's thumbnail image
    const episodeTileImageUrl = await page.evaluate((season, episode) => {
      const label = `S${season} E${episode}`;
      for (const tile of document.querySelectorAll('[data-testid="episode-tile"]')) {
        const seLabel = tile.querySelector('span[aria-label]');
        const seText  = tile.querySelector('span.PR1Lg1st5k');
        const matched = (seLabel && seLabel.getAttribute('aria-label').includes(`Season ${season}, Episode ${episode}`))
                     || (seText  && seText.textContent.trim() === label);
        if (!matched) continue;
        const imgEl = tile.querySelector('img');
        const srcset = imgEl?.srcset;
        if (srcset) {
          const entries = srcset.trim().split(/,\s+/);
          const last = entries[entries.length - 1];
          return last ? last.split(' ')[0] : null;
        }
        return imgEl?.src || null;
      }
      return null;
    }, targetSeason, targetEpisode);

    for (const { json } of capturedApiResponses) {
      const ep = findEpisode(json);
      if (!ep) continue;
      // Extract UUID: prefer the last path segment of the slug (= boundId used in playback URLs)
      // Fall back to known UUID-like fields
      let uuid = null;
      if (ep.slug) {
        const lastSeg = ep.slug.split('/').filter(Boolean).pop() || '';
        if (lastSeg.includes('-') && lastSeg.length > 20) uuid = lastSeg;
      }
      if (!uuid) {
        uuid = ep.id || ep.guid || ep.programmeUuid || ep.contentId || ep.episodeId
            || ep.assetId || ep.providerVariantId || ep.merlinId || ep.mediaId || null;
      }
      logTS(`Peacock: found S${targetSeason}E${targetEpisode} uuid="${uuid}"`);
      if (uuid) {
        const watchUrl = `https://www.peacocktv.com/watch/playback/vod/_/${uuid}`;
        const durationMinutes = ep.durationMilliseconds
          ? Math.round(ep.durationMilliseconds / 60000)
          : (ep.durationSeconds ? Math.round(ep.durationSeconds / 60)
          : (ep.durationMinutes || ep.runtime || null));
        const epImageUrl = ep.imageUrl || ep.image || ep.thumbnailUrl || ep.posterUrl
                         || ep.thumbnail || ep.imageHref || ep.artworkUrl || null;
        return {
          url:             watchUrl,
          title:           showTitle || firstTitle,
          episodeTitle:    ep.episodeName || ep.title || ep.name || ep.episodeTitle || null,
          seasonNumber:    targetSeason,
          episodeNumber:   targetEpisode,
          durationMinutes: durationMinutes ? parseInt(durationMinutes, 10) : null,
          summary:         ep.synopsis || ep.synopsisShort || ep.description || ep.summary || null,
          imageUrl:        episodeTileImageUrl || epImageUrl || searchResultImageUrl,
        };
      }
    }

    logTS(`Peacock: episode S${targetSeason} E${targetEpisode} not found in ${capturedApiResponses.length} captured responses`);
  }

  // No episode specified (or not found) — movie or live event direct playback
  // If already on a playback URL (live event), use it as-is; otherwise build VOD playback URL
  let moviePlayUrl;
  if (isPlaybackUrl) {
    moviePlayUrl = detailUrl;
  } else {
    const urlUuid = detailUrl.split('/').filter(Boolean).pop() || '';
    moviePlayUrl = (urlUuid.includes('-') && urlUuid.length > 20)
      ? `https://www.peacocktv.com/watch/playback/vod/_/${urlUuid}`
      : detailUrl;
  }

  // Get synopsis, duration, and image from page DOM (detail page or live playback overlay)
  const { movieSummary, durationStr, pageImageUrl } = await page.evaluate(() => {
    const synopsis = document.querySelector('p[data-testid="synopsis"]')?.textContent?.trim()
      || document.querySelector('p[data-testid="metadata-description"]')?.textContent?.trim()
      || null;
    // Detail pages: span[aria-label] with "1 Hour 58 Minutes"; live: time[data-testid="duration-time"] datetime="PT2H30M"
    const durationDatetime = document.querySelector('time[data-testid="duration-time"]')?.getAttribute('datetime') || null;
    let durLabel = null;
    if (!durationDatetime) {
      for (const span of document.querySelectorAll('span[aria-label]')) {
        if (/\d+\s*(Hour|Minute)/i.test(span.getAttribute('aria-label'))) {
          durLabel = span.getAttribute('aria-label').trim();
          break;
        }
      }
    }
    // Try page-level poster/thumbnail image
    const imgEl = document.querySelector('img[data-testid="show-image"], img[data-testid="poster-image"], img[data-testid="hero-image"]');
    const pageImageUrl = imgEl?.src || null;
    return { movieSummary: synopsis, durationStr: durationDatetime || durLabel, pageImageUrl };
  });

  return {
    url:             moviePlayUrl,
    title:           showTitle || firstTitle,
    episodeTitle:    null,
    seasonNumber:    targetSeason,
    episodeNumber:   targetEpisode,
    durationMinutes: parseDurationMinutes(durationStr),
    summary:         movieSummary,
    imageUrl:        searchResultImageUrl || pageImageUrl,
  };
}

/**
 * Check if a port is already in use
 */
async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true); // Port is in use
      } else if (err.code === 'EACCES') {
        resolve(true); // Permission denied, treat as in use
      } else {
        // Log other errors but assume port is free
        logTS(`Port check error: ${err.code}`);
        resolve(false);
      }
    });
    
    server.once('listening', () => {
      // Successfully bound to the port, so it's free
      server.close(() => {
        resolve(false); // Port is free
      });
    });
    
    // Try to bind to all interfaces (0.0.0.0) on the specified port
    server.listen(port, '0.0.0.0', () => {
      // This callback is called when server starts listening
    });
  });
}

/**
 * Alternative port check using netstat
 */
async function isPortInUseNetstat(port) {
  if (process.platform !== 'win32') {
    return false; // Fallback for non-Windows
  }
  
  return new Promise((resolve) => {
    exec(`netstat -an | findstr :${port}`, (error, stdout) => {
      if (error || !stdout) {
        resolve(false); // No output means port not in use
        return;
      }
      
      // Check if port is in LISTENING state (ignore ESTABLISHED outbound connections)
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          resolve(true); // Port is in use
          return;
        }
      }
      
      resolve(false); // Port not actively in use
    });
  });
}

/**
 * Find which process is using a port (Windows) - improved version
 */
async function findProcessUsingPort(port) {
  if (process.platform !== 'win32') {
    return null;
  }
  
  return new Promise((resolve) => {
    // Use netstat -anob to get process names directly (requires admin) or -ano (no admin)
    exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      
      // Parse the output to find PID
      const lines = stdout.split('\n');
      for (const line of lines) {
        // Look for lines with our port that are LISTENING
        if (line.includes(`:${port}`) && line.includes('LISTENING')) {
          const parts = line.trim().split(/\s+/);
          const pid = parts[parts.length - 1];
          
          if (!pid || pid === '0') {
            resolve({ pid: 'System', name: 'System Process' });
            return;
          }
          
          // Get process name from PID using tasklist
          exec(`tasklist /FI "PID eq ${pid}" /FO CSV`, (err, processInfo) => {
            if (!err && processInfo) {
              const lines = processInfo.split('\n');
              if (lines.length > 1) {
                // Parse CSV output
                const dataLine = lines[1];
                const match = dataLine.match(/"([^"]+)"/);
                if (match) {
                  resolve({
                    pid: pid,
                    name: match[1]
                  });
                  return;
                }
              }
            }
            resolve({ pid: pid, name: 'Unknown Process' });
          });
          return;
        }
      }
      resolve(null);
    });
  });
}


/**
 * Check if Chrome processes are actually running with our profiles
 */
async function checkForRunningChromeWithProfiles() {
  if (process.platform !== 'win32') {
    return [];
  }
  
  const runningProfiles = [];
  
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    
    // Use WMIC to find Chrome processes and their command lines
    exec('wmic process where "name=\'chrome.exe\'" get ProcessId,CommandLine /format:csv', (error, stdout) => {
      if (error || !stdout) {
        resolve([]);
        return;
      }
      
      // Check each encoder profile
      for (let i = 0; i < Constants.ENCODERS.length; i++) {
        const profileDir = path.join(chromeDataDir, `encoder_${i}`);
        const profileDirEscaped = profileDir.replace(/\\/g, '\\\\');
        
        // Check if any Chrome process is using this profile
        if (stdout.includes(profileDir) || stdout.includes(profileDirEscaped)) {
          runningProfiles.push({
            encoder: Constants.ENCODERS[i].url,
            profileDir: profileDir
          });
        }
      }
      
      resolve(runningProfiles);
    });
  });
}

/**
 * Clean up stale lock files if no Chrome is actually using them
 */
async function cleanStaleLocks(profileDir) {
  const lockFiles = ['Singleton', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];
  let cleaned = false;
  
  for (const lockFile of lockFiles) {
    const lockPath = path.join(profileDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        logTS(`Removed stale lock file: ${lockFile}`);
        cleaned = true;
      } catch (e) {
        // Can't delete - might be in use
      }
    }
  }
  
  return cleaned;
}

/**
 * Test if Chrome can launch with a profile
 */
async function testChromeLaunch(profileDir, chromePath) {
  const puppeteer = require('rebrowser-puppeteer-core');
  
  try {
    logTS(`Testing Chrome launch with profile: ${profileDir}`);
    
    // First, check if there are actual Chrome processes using this profile
    const runningWithProfile = await checkForRunningChromeWithProfiles();
    const isActuallyRunning = runningWithProfile.some(p => p.profileDir === profileDir);
    
    if (isActuallyRunning) {
      return { 
        success: false, 
        reason: 'Chrome process is actively using this profile',
        actuallyRunning: true
      };
    }
    
    // Try to launch
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      userDataDir: profileDir,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      protocolTimeout: 30000,
      timeout: 60000
    });
    
    // If we got here, Chrome launched successfully
    await browser.close();
    return { success: true };
    
  } catch (error) {
    // If it failed but no Chrome is actually using it, try cleaning stale locks
    if (error.message.includes('Failed to launch') || error.message.includes('existing browser session')) {
      const runningWithProfile = await checkForRunningChromeWithProfiles();
      const isActuallyRunning = runningWithProfile.some(p => p.profileDir === profileDir);
      
      if (!isActuallyRunning) {
        // No Chrome is actually using it, try to clean stale locks
        logTS(`No Chrome process found using ${profileDir}, cleaning stale locks...`);
        const cleaned = await cleanStaleLocks(profileDir);
        
        if (cleaned) {
          // Try to launch again after cleaning
          try {
            const browser2 = await puppeteer.launch({
              executablePath: chromePath,
              userDataDir: profileDir,
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
              protocolTimeout: 30000,
              timeout: 60000
            });
            await browser2.close();
            logTS(`Successfully launched after cleaning stale locks`);
            return { success: true };
          } catch (e2) {
            return { 
              success: false, 
              reason: 'Profile appears corrupted or locked',
              actuallyRunning: false
            };
          }
        }
      }
      
      return { 
        success: false, 
        reason: isActuallyRunning ? 'Chrome is using this profile' : 'Profile may be corrupted',
        actuallyRunning: isActuallyRunning
      };
    }
    
    return { 
      success: false, 
      reason: error.message,
      actuallyRunning: false
    };
  }
}

/**
 * Check if the application is running with Administrator privileges
 */
function isRunningAsAdmin() {
  if (process.platform === 'win32') {
    try {
      // Try to run a command that requires admin privileges
      require('child_process').execSync('net session', { stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
  }
  // On non-Windows platforms, check if running as root
  return process.getuid && process.getuid() === 0;
}

async function closeBrowser(encoderUrl) {
  logTS(`Attempting to close browser for encoder ${encoderUrl}`);
  if (browsers.has(encoderUrl)) {
    try {
      const browser = browsers.get(encoderUrl);
      if (browser && browser.isConnected()) {
        await browser.close();
        logTS(`Browser closed for encoder ${encoderUrl}`);
      }
    } catch (e) {
      logTS(`Error closing browser for ${encoderUrl}:`, e);
    } finally {
      browsers.delete(encoderUrl);
    }
  }
}

// Attempts to close browser in a safe fashion
const createCleanupManager = () => {
  let closingStates = new Map(); // Track closing state per encoder
  let activeBrowsers = new Map(); // Track active browser instances by encoder URL
  let recoveryInProgress = new Map(); // Track recovery operations to prevent duplicates
  let intentionalClose = new Map(); // Track intentional browser closes
  
  process.on('SIGINT', async () => {
    logTS('Caught interrupt signal');
    for (const [encoderUrl] of activeBrowsers) {
      intentionalClose.set(encoderUrl, true); // Mark as intentional
      await closeBrowser(encoderUrl);
    }
    process.exit();
  });
  
  process.on('SIGTERM', async () => {
    logTS('Caught termination signal');
    for (const [encoderUrl] of activeBrowsers) {
      intentionalClose.set(encoderUrl, true); // Mark as intentional
      await closeBrowser(encoderUrl);
    }
    process.exit();
  });

  return {
    cleanup: async (encoderUrl, res) => {
      if (closingStates.get(encoderUrl)) {
        logTS(`Cleanup already in progress for encoder ${encoderUrl}`);
        return;
      }
      
      // Check if recovery is already in progress from the disconnection handler
      if (recoveryInProgress.get(encoderUrl)) {
        logTS(`Recovery already in progress for encoder ${encoderUrl}, skipping cleanup recovery`);
        activeBrowsers.delete(encoderUrl); // Mark as available
        return;
      }
      
      logTS(`Starting cleanup for encoder ${encoderUrl}`);
      closingStates.set(encoderUrl, true);
      recoveryInProgress.set(encoderUrl, true); // Mark recovery as in progress
      intentionalClose.set(encoderUrl, true); // Mark this as an intentional close

      // Stop stream monitoring for this encoder
      if (global.streamMonitor) {
        global.streamMonitor.stopMonitoring(encoderUrl);
      }

      try {
        // Close the browser
        await closeBrowser(encoderUrl);
        
        if (res && !res.headersSent) {
          res.status(499).send();
          logTS(`Send http status 499 for encoder ${encoderUrl}`);
        }
      } catch (e) {
        logTS(`Error during cleanup for ${encoderUrl}:`, e);
      } finally {
        await delay(500); // Reduced from 2000ms for faster recovery
        closingStates.delete(encoderUrl); // Encoder is no longer in a "closing" state
        intentionalClose.delete(encoderUrl); // Clear the intentional close flag

        // Re-initialize the browser in the pool
        const encoderConfig = Constants.ENCODERS.find(e => e.url === encoderUrl);
        if (encoderConfig) {
          logTS(`Attempting to re-initialize browser for ${encoderUrl} in pool after cleanup.`);

          // Clear the browser from the map first to ensure launchBrowser doesn't think it exists
          browsers.delete(encoderUrl);

          // Wait for Chrome processes to fully terminate after cleanup
          // This is especially important if Chrome processes were force-killed
          await delay(2000); // Increased to 2s to ensure Chrome processes fully terminate

          try {
            const repoolSuccess = await launchBrowser("about:blank", encoderConfig, true, false);

            if (repoolSuccess) {
              logTS(`Successfully re-initialized and minimized browser for ${encoderUrl} in pool.`);

              // Re-attach crash handlers if browser was successfully created
              if (browsers.has(encoderUrl)) {
                const newBrowser = browsers.get(encoderUrl);
                // Only re-attach handlers if we have the recovery manager
                if (global.recoveryManager) {
                  setupBrowserCrashHandlers(
                    newBrowser,
                    encoderUrl,
                    global.recoveryManager,
                    encoderConfig,
                    browsers,
                    launchBrowser,
                    Constants
                  );
                }
              }

              activeBrowsers.delete(encoderUrl); // Make encoder available
            } else {
              logTS(`Failed to re-initialize browser for ${encoderUrl} in pool.`);
              // Keep in activeBrowsers to prevent immediate reuse
            }
          } catch (error) {
            logTS(`Error re-initializing browser for ${encoderUrl}: ${error.message}`);
            // Keep in activeBrowsers to prevent immediate reuse
          }
        } else {
          logTS(`Could not find encoderConfig for ${encoderUrl} to re-initialize browser.`);
        }
        
        recoveryInProgress.delete(encoderUrl); // Clear recovery flag
        logTS(`Cleanup process completed for encoder ${encoderUrl}`);
      }
    },
    canStartBrowser: (encoderUrl) => !closingStates.get(encoderUrl) && !activeBrowsers.has(encoderUrl) && !recoveryInProgress.get(encoderUrl),
    setBrowserActive: (encoderUrl) => {
      activeBrowsers.set(encoderUrl, true);
      logTS(`Browser set active for encoder ${encoderUrl}`);
    },
    setBrowserAvailable: (encoderUrl) => {
      activeBrowsers.delete(encoderUrl);
      logTS(`Browser set available (inactive) for encoder ${encoderUrl}`);
    },
    isRecoveryInProgress: (encoderUrl) => recoveryInProgress.get(encoderUrl),
    setRecoveryInProgress: (encoderUrl, value) => {
      if (value) {
        recoveryInProgress.set(encoderUrl, true);
      } else {
        recoveryInProgress.delete(encoderUrl);
      }
    },
    isIntentionalClose: (encoderUrl) => intentionalClose.get(encoderUrl),
    getState: () => ({ 
      closingStates: Array.from(closingStates.entries()),
      activeBrowsers: Array.from(activeBrowsers.keys()),
      recoveryInProgress: Array.from(recoveryInProgress.keys()),
      intentionalClose: Array.from(intentionalClose.keys())
    })
  };
};

/**
 * Handle Sling modal detection by simulating human interaction
 * @param {Page} page - Puppeteer page object
 * @returns {Promise<boolean>} - True if modal was handled successfully
 */
async function handleSlingModal(page) {
  const currentUrl = page.url();

  // Check if we're on the modal page
  if (currentUrl.includes('/modal')) {
    logTS('Detected Sling modal, skipping (will retry on next attempt)');
    // Don't wait - modal won't auto-dismiss, just return false and let retry handle it
    return false;
  } else {
    // Not on modal page, we're good
    return true;
  }
}

/**
 * Navigate to a Sling URL and handle any modals that appear
 * @param {Page} page - Puppeteer page object
 * @param {string} url - URL to navigate to
 * @param {number} maxAttempts - Maximum number of modal dismissal attempts
 * @param {string} expectedUrlPattern - Optional URL pattern to validate successful navigation (e.g., '/dashboard')
 * @param {string} encoderUrl - Encoder URL for logging purposes
 * @returns {Promise<boolean>} - True if successfully navigated past modals to expected destination
 */
async function navigateSlingWithModalHandling(page, url, maxAttempts = 10, expectedUrlPattern = null, encoderUrl = 'unknown') {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.goto(url, {
      waitUntil: 'load',
      timeout: 15000
    });

    await delay(1000 + Math.random() * 500); // 1-1.5 second delay

    // Re-inject checkForVideos function after navigation
    await page.evaluate(() => {
      window.checkForVideos = () => {
        const videos = [...document.getElementsByTagName('video')];
        const iframeVideos = [...document.getElementsByTagName('iframe')].reduce((acc, iframe) => {
          try {
            const frameVideos = iframe.contentDocument?.getElementsByTagName('video');
            return frameVideos && frameVideos.length ? [...acc, ...frameVideos] : acc;
          } catch(e) {
            return acc;
          }
        }, []);
        return [...videos, ...iframeVideos];
      };
    });

    let currentUrl = page.url();

    // Check if we're on a modal page
    if (currentUrl.includes('/modal')) {
      logTS(`[${encoderUrl}] Modal detected on attempt ${attempt}/${maxAttempts}, attempting to dismiss...`);

      // Try to dismiss modal using Tab+Enter (5 times with random delays)
      for (let dismissAttempt = 1; dismissAttempt <= 5; dismissAttempt++) {
        logTS(`[${encoderUrl}] Modal dismiss attempt ${dismissAttempt}/5 using Tab+Enter`);
        await page.keyboard.press('Tab');
        await delay(1000 + Math.random() * 1000); // 1-2 second wait
        await page.keyboard.press('Enter');
        await delay(1000 + Math.random() * 1000); // 1-2 second wait

        // Check if we're still on modal
        currentUrl = page.url();
        if (!currentUrl.includes('/modal')) {
          logTS(`[${encoderUrl}] Modal dismissed successfully on Tab+Enter attempt ${dismissAttempt}`);
          break;
        }
      }

      // If still on modal after Tab+Enter attempts, force navigate again
      if (currentUrl.includes('/modal')) {
        logTS(`[${encoderUrl}] Modal still present after Tab+Enter attempts, forcing navigation...`);
        if (attempt >= maxAttempts) {
          logTS(`[${encoderUrl}] Failed to get past modals after ${maxAttempts} attempts`);
          return false;
        }
        continue; // Try full navigation again
      }
    }

    // Re-check current URL after modal handling
    currentUrl = page.url();

    // If we have an expected URL pattern, validate we landed there
    if (expectedUrlPattern && !currentUrl.includes(expectedUrlPattern)) {
      logTS(`[${encoderUrl}] Got past modal but landed on unexpected page: ${currentUrl} (expected pattern: ${expectedUrlPattern})`);
      if (attempt >= maxAttempts) {
        return false;
      }
      continue; // Try again
    }

    // Successfully got past modals and landed on expected page
    logTS(`[${encoderUrl}] Successfully navigated to ${currentUrl}`);
    return true;
  }

  return false;
}

/**
 * Navigate to Peacock stream like a human would - start from homepage, then go to streaming URL
 * @param {Page} page - Puppeteer page object
 * @param {string} streamUrl - The final streaming URL to navigate to
 * @param {string} encoderUrl - Encoder URL for logging purposes
 * @returns {Promise<boolean>} - True if successfully navigated to stream
 */
async function navigatePeacockLikeHuman(page, streamUrl, encoderUrl = 'unknown') {
  logTS(`[${encoderUrl}] Starting Peacock navigation (direct to stream URL)`);

  // Helper function to handle profile selection - waits for page to be ready
  async function handleProfileSelection() {
    logTS(`[${encoderUrl}] Profile selection page detected, waiting for page to be ready...`);

    // Wait for the page to be fully loaded and interactive
    try {
      await page.waitForSelector('body', { timeout: 5000 });
      // Wait for profile buttons to be clickable (look for common profile page elements)
      await page.waitForFunction(() => {
        // Check if we're on profiles page and it's interactive
        return document.readyState === 'complete' &&
               document.querySelectorAll('button, [role="button"], a').length > 0;
      }, { timeout: 5000 });
    } catch (e) {
      logTS(`[${encoderUrl}] Profile page wait timeout, proceeding anyway...`);
    }

    await delay(1500); // Extra delay to ensure page is fully interactive

    logTS(`[${encoderUrl}] Sending profile selection keystrokes (3x Tab + Enter)...`);
    await page.keyboard.press('Tab');
    await delay(300);
    await page.keyboard.press('Tab');
    await delay(300);
    await page.keyboard.press('Tab');
    await delay(300);
    await page.keyboard.press('Enter');
    logTS(`[${encoderUrl}] Profile selection keystrokes sent`);

    // Wait for navigation after profile selection
    await delay(2000);
  }

  try {
    // Navigate to homepage first to establish a normal browsing session
    logTS(`[${encoderUrl}] Navigating to Peacock homepage`);
    await page.goto('https://www.peacocktv.com', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Handle profile selection if redirected on homepage load
    if (page.url().includes('/watch/profiles')) {
      logTS(`[${encoderUrl}] Profile selection page detected on homepage — selecting first profile`);
      const profileSel = '.profiles__avatar--image[role="button"]';
      try {
        const profileEl = await page.waitForSelector(profileSel, { timeout: 8000 });
        await profileEl.click();
        await page.waitForFunction(() => !window.location.href.includes('/watch/profiles'), { timeout: 15000 });
        logTS(`[${encoderUrl}] Profile selected — now at: ${page.url()}`);
      } catch (e) {
        logTS(`[${encoderUrl}] Profile selector click failed, trying keyboard fallback: ${e.message}`);
        await handleProfileSelection();
      }
    }

    // Simulate human browsing on homepage before navigating to stream
    await delay(1000);
    await page.mouse.move(300 + Math.random() * 400, 200 + Math.random() * 200);
    await delay(800 + Math.random() * 600);
    await page.mouse.move(400 + Math.random() * 300, 350 + Math.random() * 200);
    await delay(1500 + Math.random() * 1500); // 1.5-3s additional dwell time

    // Navigate to the stream URL
    logTS(`[${encoderUrl}] Navigating to streaming URL: ${streamUrl}`);
    await page.goto(streamUrl, {
      waitUntil: 'load',
      timeout: 30000
    });

    // Monitor for profile page for up to 8 seconds after initial navigation
    // Peacock does delayed JavaScript redirects
    const maxProfileChecks = 16; // 8 seconds (16 * 500ms)
    let profileHandleCount = 0;
    const maxProfileHandles = 3; // Don't get stuck in infinite loop

    for (let i = 0; i < maxProfileChecks && profileHandleCount < maxProfileHandles; i++) {
      const currentUrl = page.url();

      // If we're on the playback page, we're done!
      if (currentUrl.includes('/watch/playback')) {
        logTS(`[${encoderUrl}] On playback page, navigation complete`);
        break;
      }

      // If we're on profiles page, handle it
      if (currentUrl.includes('/watch/profiles')) {
        profileHandleCount++;
        logTS(`[${encoderUrl}] On profiles page (handle attempt ${profileHandleCount}/${maxProfileHandles})`);

        await handleProfileSelection();

        // Navigate back to stream URL
        logTS(`[${encoderUrl}] Navigating back to stream URL: ${streamUrl}`);
        await page.goto(streamUrl, {
          waitUntil: 'load',
          timeout: 30000
        });

        // Reset counter to give more time after profile handling
        i = 0;
        continue;
      }

      // Wait before checking again
      await delay(500);
    }

    logTS(`[${encoderUrl}] Successfully navigated to Peacock stream`);
    logTS(`[${encoderUrl}] Final URL: ${page.url()}`);

    return true;

  } catch (error) {
    logTS(`[${encoderUrl}] Peacock navigation error: ${error.message}`);
    return false;
  }
}

/**
 * Navigate to Sling channel with fallback strategy
 * Strategy: Try direct navigation first (fast). If that fails, go to dashboard then retry direct navigation.
 * @param {Page} page - Puppeteer page object
 * @param {string} channelWatchUrl - The final /watch URL to navigate to
 * @param {string} encoderUrl - Encoder URL for logging purposes
 * @returns {Promise<boolean>} - True if successfully navigated to watch page
 */
async function navigateSlingLikeHuman(page, channelWatchUrl, encoderUrl = 'unknown') {
  // STEP 1: Try direct navigation to watch page (fast path) - single attempt with modal handling
  logTS(`[${encoderUrl}] Attempting direct navigation to watch page (fast path)`);

  try {
    const watchSuccess = await navigateSlingWithModalHandling(
      page,
      channelWatchUrl,
      10,
      '/watch',
      encoderUrl
    );

    if (watchSuccess) {
      logTS(`[${encoderUrl}] Direct navigation successful!`);
      return true;
    }

    logTS(`[${encoderUrl}] Direct navigation failed, will try dashboard-first fallback`);

  } catch (error) {
    logTS(`[${encoderUrl}] Error during direct navigation: ${error.message}`);
  }

  // STEP 2: Direct navigation failed - try dashboard-first approach as fallback
  logTS(`[${encoderUrl}] Trying dashboard-first fallback...`);

  try {
    // Navigate to dashboard/home first
    logTS(`[${encoderUrl}] Fallback: Navigating to watch.sling.com dashboard...`);
    const homeSuccess = await navigateSlingWithModalHandling(
      page,
      'https://watch.sling.com',
      10,
      '/dashboard/home',
      encoderUrl
    );

    if (!homeSuccess) {
      logTS(`[${encoderUrl}] Fallback failed: Could not reach dashboard page`);
      return false;
    }

    logTS(`[${encoderUrl}] Fallback: Successfully reached dashboard, pausing before channel navigation...`);
    await delay(500 + Math.random() * 500); // 0.5-1s pause to mimic human behavior

    // Now try navigating to the watch page from dashboard
    logTS(`[${encoderUrl}] Fallback: Navigating from dashboard to watch page: ${channelWatchUrl}`);
    const watchSuccess = await navigateSlingWithModalHandling(
      page,
      channelWatchUrl,
      10,
      '/watch',
      encoderUrl
    );

    if (!watchSuccess) {
      logTS(`[${encoderUrl}] Fallback failed: Could not reach watch page from dashboard`);
      return false;
    }

    logTS(`[${encoderUrl}] Fallback successful: Reached watch page via dashboard!`);
    return true;

  } catch (error) {
    logTS(`[${encoderUrl}] Error during dashboard fallback: ${error.message}`);
    return false;
  }
}

async function setupBrowserAudio(page, encoderConfig, targetUrl = null) {
  // For Sling, just navigate to channel if not already there
  if (page.url().includes("watch.sling.com") && targetUrl) {
    // If not on the channel page, navigate there
    if (!page.url().endsWith('/watch')) {
      logTS(`Not on channel page, navigating to: ${targetUrl}`);
      await page.goto(targetUrl, {
        waitUntil: 'load',
        timeout: 15000
      });
    }
  }

  logTS("waiting for video to load")

  await page.evaluate(() => {

    // looks for videos in the base document or iframes
    window.checkForVideos = () => {
      const videos = [...document.getElementsByTagName('video')];
      const iframeVideos = [...document.getElementsByTagName('iframe')].reduce((acc, iframe) => {
        try {
          const frameVideos = iframe.contentDocument?.getElementsByTagName('video');
          return frameVideos && frameVideos.length ? [...acc, ...frameVideos] : acc;
        } catch(e) {
          return acc;
        }
      }, []);
      return [...videos, ...iframeVideos];
    };
  });
 
  // calls checkforvideos constantly until either at least one video is ready or the 60s timer expires
  // For Sling, we need to handle modals that may appear during video loading
  if (page.url().includes("watch.sling.com")) {
    const maxVideoWaitAttempts = 10;
    let videoFound = false;
    let tryCount = 0;
    const maxTries = 2; // Try 10 attempts, then detour to root sling.com, then 10 more attempts

    // Set up periodic activity updates during Sling video detection to prevent false "inactive" warnings
    const activityUpdateInterval = setInterval(() => {
      if (global.streamMonitor && encoderConfig && encoderConfig.url) {
        const stream = global.streamMonitor.activeStreams.get(encoderConfig.url);
        if (stream) {
          global.streamMonitor.updateActivity(encoderConfig.url);
        }
      }
    }, 10000); // Update every 10 seconds during Sling video detection

    try {
      while (!videoFound && tryCount < maxTries) {
        tryCount++;
        logTS(`Starting attempt set ${tryCount}/${maxTries} for video detection`);

      for (let attempt = 1; attempt <= maxVideoWaitAttempts && !videoFound; attempt++) {
        // Check if we're on the wrong page (modal, dashboard, or browse) before waiting for video
        // Also check if we're NOT on the expected /watch page - Sling sometimes redirects to /browse
        const currentUrl = page.url();
        const isWrongPage = currentUrl.includes('/modal') ||
                            currentUrl.includes('/dashboard') ||
                            currentUrl.includes('/browse') ||
                            (targetUrl && targetUrl.includes('/watch') && !currentUrl.includes('/watch'));
        if (isWrongPage) {
          // If we're on /browse, the show likely isn't streaming yet - wait longer to avoid rate limiting
          const isBrowsePage = currentUrl.includes('/browse');
          if (isBrowsePage) {
            logTS(`On browse page (show may not be streaming yet), waiting 15-20s before retry (set ${tryCount}, attempt ${attempt}/${maxVideoWaitAttempts})`);
            await delay(15000 + Math.random() * 5000); // Wait 15-20 seconds for /browse to avoid rate limiting
          } else {
            logTS(`On wrong page (${currentUrl}), navigating back to channel (set ${tryCount}, attempt ${attempt}/${maxVideoWaitAttempts})`);
            // Wait briefly before re-navigating to let Sling settle
            await delay(500 + Math.random() * 500);
          }

          // Navigate back to channel with modal handling
          if (targetUrl) {
            await page.goto(targetUrl, {
              waitUntil: 'load',
              timeout: 15000
            });
            await delay(1500 + Math.random() * 500); // 1.5-2 second delay between modal navigations

            // Re-inject checkForVideos function after navigation
            await page.evaluate(() => {
              window.checkForVideos = () => {
                const videos = [...document.getElementsByTagName('video')];
                const iframeVideos = [...document.getElementsByTagName('iframe')].reduce((acc, iframe) => {
                  try {
                    const frameVideos = iframe.contentDocument?.getElementsByTagName('video');
                    return frameVideos && frameVideos.length ? [...acc, ...frameVideos] : acc;
                  } catch(e) {
                    return acc;
                  }
                }, []);
                return [...videos, ...iframeVideos];
              };
            });
          }

          // Skip video wait and continue to next attempt immediately
          continue;
        }

        // Only wait for video if we're actually on the channel page
        try {
          await page.waitForFunction(() => {
            const videos = window.checkForVideos();
            return videos.length > 0 && videos.some(v => v.readyState >= 2);
          }, { timeout: 5000 }); // Shorter timeout - if modal appears it will show quickly
          videoFound = true;
          logTS("Video found and ready");
        } catch (e) {
          logTS(`Video wait attempt ${attempt}/${maxVideoWaitAttempts} (set ${tryCount}) timed out`);
          // If we timed out, wait a bit before next attempt
          await delay(500);
        }
      }

      // If we didn't find video and haven't exhausted all try sets, do the detour
      if (!videoFound && tryCount < maxTries) {
        logTS(`Failed attempt set ${tryCount}. Navigating to root sling.com with modal handling...`);

        // Use the helper function to navigate to root Sling with modal handling
        // Expect to land on /dashboard after navigating through any modals
        const detourSuccess = await navigateSlingWithModalHandling(page, 'https://watch.sling.com', 10, '/dashboard');

        if (!detourSuccess) {
          logTS(`Warning: Detour to root sling.com failed to reach dashboard after 10 attempts`);
        } else {
          logTS(`Successfully reached dashboard page`);
        }

        // Wait a bit longer to let things settle after detour
        await delay(2000 + Math.random() * 1000); // 2-3 second pause

        logTS(`Detour complete, will retry channel navigation`);
      } else if (!videoFound) {
        // Exhausted all tries
        throw new Error(`Failed to find video after ${maxTries * maxVideoWaitAttempts} total attempts across ${maxTries} attempt sets`);
      }
      }
    } finally {
      clearInterval(activityUpdateInterval);
    }
  } else if (targetUrl && targetUrl.includes("peacocktv.com")) {
    // Peacock-specific video wait with profile redirect handling
    const activityUpdateInterval = setInterval(() => {
      if (global.streamMonitor && encoderConfig && encoderConfig.url) {
        const stream = global.streamMonitor.activeStreams.get(encoderConfig.url);
        if (stream) {
          global.streamMonitor.updateActivity(encoderConfig.url);
        }
      }
    }, 10000);

    try {
      const maxWaitTime = 60000;
      const checkInterval = 500;
      const startTime = Date.now();
      let videoFound = false;
      let profileHandleCount = 0;
      const maxProfileHandles = 3;

      while (Date.now() - startTime < maxWaitTime && !videoFound) {
        // Check if we got redirected to profiles page
        let currentUrl;
        try {
          currentUrl = page.url();
        } catch (e) {
          logTS(`[${encoderConfig.url}] Error getting page URL: ${e.message}`);
          await delay(checkInterval);
          continue;
        }

        // Debug log every 5 seconds
        const elapsed = Date.now() - startTime;
        if (elapsed % 5000 < checkInterval) {
          logTS(`[${encoderConfig.url}] Peacock video wait: ${Math.round(elapsed/1000)}s elapsed, URL: ${currentUrl.substring(0, 80)}...`);
        }

        if (currentUrl.includes('/watch/profiles') && profileHandleCount < maxProfileHandles) {
          profileHandleCount++;
          logTS(`[${encoderConfig.url}] Peacock redirected to profiles during video load (attempt ${profileHandleCount})`);

          // Wait for profile elements to appear and click
          // Peacock profile selector: <div class="profiles__avatar--image" role="button" tabindex="0">
          const profileSelectors = [
            'div.profiles__avatar--image[role="button"]',
            '.profiles__avatar--image[role="button"]',
            '.profiles__avatar--image[tabindex="0"]',
            '.profiles__avatar--image'
          ];

          let profileClicked = false;

          // Wait up to 10 seconds for profile elements
          for (let waitAttempt = 0; waitAttempt < 20 && !profileClicked; waitAttempt++) {
            await delay(500);

            for (const selector of profileSelectors) {
              try {
                const element = await page.$(selector);
                if (element) {
                  const isVisible = await page.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 &&
                           style.visibility !== 'hidden' &&
                           style.display !== 'none';
                  }, element);

                  if (isVisible) {
                    logTS(`[${encoderConfig.url}] Clicking Peacock profile`);
                    await element.click();
                    profileClicked = true;
                    break;
                  }
                }
              } catch (e) {
                // Selector didn't match, continue
              }
            }
          }

          // Fallback to keyboard if no clickable profile found
          if (!profileClicked) {
            logTS(`[${encoderConfig.url}] No profile element found, trying keyboard navigation...`);
            await page.keyboard.press('Tab');
            await delay(300);
            await page.keyboard.press('Tab');
            await delay(300);
            await page.keyboard.press('Tab');
            await delay(300);
            await page.keyboard.press('Enter');
            logTS(`[${encoderConfig.url}] Profile keystrokes sent`);
          }

          // Wait for navigation after profile selection
          logTS(`[${encoderConfig.url}] Waiting for profile selection to take effect...`);
          await delay(3000);

          // Navigate back to stream URL
          logTS(`[${encoderConfig.url}] Navigating back to stream URL: ${targetUrl}`);
          await page.goto(targetUrl, {
            waitUntil: 'load',
            timeout: 30000
          });

          // Re-inject checkForVideos after navigation
          await page.evaluate(() => {
            window.checkForVideos = () => {
              const videos = [...document.getElementsByTagName('video')];
              const iframeVideos = [...document.getElementsByTagName('iframe')].reduce((acc, iframe) => {
                try {
                  const frameVideos = iframe.contentDocument?.getElementsByTagName('video');
                  return frameVideos && frameVideos.length ? [...acc, ...frameVideos] : acc;
                } catch(e) {
                  return acc;
                }
              }, []);
              return [...videos, ...iframeVideos];
            };
          });

          continue;
        }

        // Check for video
        try {
          videoFound = await page.evaluate(() => {
            const videos = window.checkForVideos();
            return videos.length > 0 && videos.some(v => v.readyState >= 2);
          });
        } catch (e) {
          // Page may be navigating, ignore error
          logTS(`[${encoderConfig.url}] Error checking for video: ${e.message}`);
        }

        if (!videoFound) {
          await delay(checkInterval);
        }
      }

      if (!videoFound) {
        throw new Error(`Peacock video not found after ${maxWaitTime}ms`);
      }
    } finally {
      clearInterval(activityUpdateInterval);
    }
  } else if (targetUrl && targetUrl.includes("disneynow.com")) {
    // DisneyNow requires clicking the play overlay before video loads
    logTS("DisneyNow detected, clicking play overlay to start video");

    // Wait for the play overlay button to appear
    for (let i = 0; i < 10; i++) {
      const found = await page.evaluate(() => {
        function querySelectorDeep(selector, root = document) {
          const element = root.querySelector(selector);
          if (element) return element;
          const allElements = root.querySelectorAll('*');
          for (const el of allElements) {
            if (el.shadowRoot) {
              const found = querySelectorDeep(selector, el.shadowRoot);
              if (found) return found;
            }
          }
          return null;
        }
        const btn = querySelectorDeep('.overlay__button button');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (found) {
        logTS("DisneyNow play overlay clicked");
        break;
      }
      await delay(500);
    }

    // Now wait for video to load after play was clicked
    const activityUpdateInterval = setInterval(() => {
      if (global.streamMonitor && encoderConfig && encoderConfig.url) {
        const stream = global.streamMonitor.activeStreams.get(encoderConfig.url);
        if (stream) {
          global.streamMonitor.updateActivity(encoderConfig.url);
        }
      }
    }, 10000);

    try {
      await page.waitForFunction(() => {
        const videos = window.checkForVideos();
        return videos.length > 0 && videos.some(v => v.readyState >= 2);
      }, { timeout: 30000 });
    } finally {
      clearInterval(activityUpdateInterval);
    }
  } else if (targetUrl && targetUrl.includes("tbs.com")) {
    // TBS requires clicking the play button before video loads
    logTS("TBS detected, clicking play button to start video");

    for (let i = 0; i < 10; i++) {
      const found = await page.evaluate(() => {
        const btn = document.querySelector('span.tui-play.tui-btn');
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (found) {
        logTS("TBS play button clicked");
        break;
      }
      await delay(500);
    }

    // Now wait for video to load after play was clicked
    const activityUpdateInterval = setInterval(() => {
      if (global.streamMonitor && encoderConfig && encoderConfig.url) {
        const stream = global.streamMonitor.activeStreams.get(encoderConfig.url);
        if (stream) {
          global.streamMonitor.updateActivity(encoderConfig.url);
        }
      }
    }, 10000);

    try {
      await page.waitForFunction(() => {
        const videos = window.checkForVideos();
        return videos.length > 0 && videos.some(v => v.readyState >= 2);
      }, { timeout: 30000 });
    } finally {
      clearInterval(activityUpdateInterval);
    }
  } else {
    // Other non-Sling sites use original logic
    const activityUpdateInterval = setInterval(() => {
      if (global.streamMonitor && encoderConfig && encoderConfig.url) {
        const stream = global.streamMonitor.activeStreams.get(encoderConfig.url);
        if (stream) {
          global.streamMonitor.updateActivity(encoderConfig.url);
        }
      }
    }, 10000); // Update every 10 seconds during video wait

    try {
      await page.waitForFunction(() => {
        const videos = window.checkForVideos();
        return videos.length > 0 && videos.some(v => v.readyState >= 2);
      }, { timeout: 60000 });
    } finally {
      clearInterval(activityUpdateInterval);
    }
  }

  // Re-inject checkForVideos before final check (page context may have changed, especially for Sling)
  await page.evaluate(() => {
    window.checkForVideos = () => {
      const videos = [...document.getElementsByTagName('video')];
      const iframeVideos = [...document.getElementsByTagName('iframe')].reduce((acc, iframe) => {
        try {
          const frameVideos = iframe.contentDocument?.getElementsByTagName('video');
          return frameVideos && frameVideos.length ? [...acc, ...frameVideos] : acc;
        } catch(e) {
          return acc;
        }
      }, []);
      return [...videos, ...iframeVideos];
    };
  });

  let videoLength = await page.evaluate(() => window.checkForVideos().length);
  logTS(`Found ${videoLength} videos`);
   
  if (encoderConfig.audioDevice) {
    logTS(`Attempting to set audio device: ${encoderConfig.audioDevice}`);
    
    await page.waitForFunction(() => {
      return navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function';
    }, { timeout: 10000 });
 
    logTS("done waiting for browser to find media")
    
    try {
      const deviceSet = await page.evaluate(async (audioDevice) => {
        async function canSetAudio() {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioDevices = devices.filter(d => d.kind === 'audiooutput');
          return audioDevices.some(d => d.label.includes(audioDevice));
        }
      
        async function setAndVerifyAudioDevice() {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const targetDevice = devices
            .filter(d => d.kind === 'audiooutput')
            .find(d => d.label.includes(audioDevice));
          
          if (!targetDevice) {
            console.log("Error no audiooutput devices found!")
            return false;
          } 
 
          const allVideos = window.checkForVideos();
          let success = false;
 
          for (const video of allVideos) {
            if (video.setSinkId) {
              try {
                await video.setSinkId(targetDevice.deviceId);
                if (video.sinkId === targetDevice.deviceId) {
                  success = true;
                }
              } catch (e) {
                console.log('Error setting sink:', e);
              }
            }
          }
          return success;
        }
 
        if (!await canSetAudio()) {
          await new Promise(resolve => setTimeout(resolve, 2000));
          if (!await canSetAudio()) return false;
        }
 
        let attempts = 0;
        while (attempts < 5) {
          if (await setAndVerifyAudioDevice()) {
            return true;
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
          attempts++;
        }
        
        return false;
      }, encoderConfig.audioDevice);
 
      if (deviceSet) {
        logTS(`Successfully configured and verified audio device: ${encoderConfig.audioDevice}`);
      } else {
        logTS(`Failed to set audio device after verification attempts`);
      }
    } catch (error) {
      logTS(`Error in audio device configuration: ${error.message}`, error);
    }
  }
 
  const audioStatus = await page.evaluate(() => {
    const videos = window.checkForVideos();
    return videos.map(v => ({
      readyState: v.readyState,
      sinkId: v.sinkId,
      hasAudio: v.mozHasAudio || Boolean(v.webkitAudioDecodedByteCount) || Boolean(v.audioTracks && v.audioTracks.length)
    }));
  });
 
  logTS('Final audio status:', audioStatus);
}

// setup and launch browser
async function launchBrowser(targetUrl, encoderConfig, startMinimized, applyStartFullScreenArg = true) {
  logTS(`starting browser for encoder ${encoderConfig.url} at position ${encoderConfig.width},${encoderConfig.height}`);

  // Check if a launch is already in progress for this encoder
  if (launchMutex.has(encoderConfig.url)) {
    logTS(`Browser launch already in progress for encoder ${encoderConfig.url}, waiting...`);
    try {
      await launchMutex.get(encoderConfig.url);
      return browsers.has(encoderConfig.url);
    } catch (e) {
      logTS(`Previous launch failed for ${encoderConfig.url}: ${e.message}`);
      // Continue with new launch attempt
    }
  }

  if (browsers.has(encoderConfig.url)) {
    logTS(`Browser already exists for encoder ${encoderConfig.url}`);
    return true;
  }

  // Create a mutex promise for this launch
  let launchResolve, launchReject;
  const launchPromise = new Promise((resolve, reject) => {
    launchResolve = resolve;
    launchReject = reject;
  });
  // Add a no-op catch to prevent unhandled rejection when the promise is rejected
  // but no one is actively waiting on it (the error is still thrown by the function)
  launchPromise.catch(() => {});
  launchMutex.set(encoderConfig.url, launchPromise);

  try {
    // Create unique user data directory for this encoder
    const encoderIndex = Constants.ENCODERS.findIndex(e => e.url === encoderConfig.url);
    const uniqueUserDataDir = path.join(chromeDataDir, `encoder_${encoderIndex}`);

    // Just ensure the directory exists, don't clean it
    if (!fs.existsSync(uniqueUserDataDir)) {
      fs.mkdirSync(uniqueUserDataDir, { recursive: true });
      logTS(`Created new user data directory: ${uniqueUserDataDir}`);
    }

    logTS(`Using user data directory: ${uniqueUserDataDir}`);

    // Prepare base launch arguments
    const launchArgs = [
      '--no-first-run',
      '--hide-crash-restore-bubble',
      '--test-type',
      '--disable-blink-features=AutomationControlled',
      '--disable-notifications',
      '--disable-session-crashed-bubble',
      '--disable-save-password-bubble',
      '--noerrdialogs',
      '--no-default-browser-check',
      //'--hide-scrollbars',
      '--allow-running-insecure-content',
      '--autoplay-policy=no-user-gesture-required',
      `--window-position=${encoderConfig.width},${encoderConfig.height}`,
      '--window-size=1280,720',  // Set explicit window size for proper rendering
      '--new-window',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-background-media-suspend',
      '--disable-backgrounding-occluded-windows',
    ];

    if (applyStartFullScreenArg) {
      launchArgs.push('--start-fullscreen');
    }

    // Add audio configuration if device specified
    // Validate audio device before adding to launch args
    if (encoderConfig.audioDevice) {
      const audioManager = new AudioDeviceManager();
      const result = await audioManager.validateDevice(encoderConfig.audioDevice);
      
      if (result.valid) {
        launchArgs.push(
          '--use-fake-ui-for-media-stream',
          `--audio-output-device=${result.deviceName}`
        );
      } else {
        logTS(`Warning: Audio device "${encoderConfig.audioDevice}" not found`);
                launchArgs.push(
          '--use-fake-ui-for-media-stream',
          `--audio-output-device=${encoderConfig.audioDevice}`
        );
      }
    }
    // Couldn't find a way to redirect sound for Google so mute it
    if (targetUrl && targetUrl.includes("photos.app.goo.gl")) {
      launchArgs.push('--mute-audio');
      logTS('Mute sound for google photos');
    }

    logTS('Launch arguments:', launchArgs);

    // Add better error handling to the launch
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: chromePath,
        userDataDir: uniqueUserDataDir,
        headless: false,
        defaultViewport: null,
        args: launchArgs,
        protocolTimeout: 30000,
        timeout: 60000,
        ignoreDefaultArgs: [
          '--enable-automation',
          '--disable-extensions',
          '--disable-default-apps',
          '--disable-component-update',
          '--disable-component-extensions-with-background-pages',
          '--enable-blink-features=IdleDetection',
        ],
        // Add dumpio to see browser console output for debugging
        dumpio: false  // Set to true temporarily to see browser output
      });
    } catch (launchError) {
      logTS(`Browser launch failed with error: ${launchError.message}`);
      
      // Check for specific error conditions
      if (launchError.message.includes('Failed to launch')) {
        logTS('Detailed launch error analysis:');
        
        // Check if Chrome exists
        if (!fs.existsSync(chromePath)) {
          logTS(`ERROR: Chrome not found at ${chromePath}`);
          throw new Error(`Chrome executable not found at: ${chromePath}`);
        } else {
          logTS(`Chrome found at ${chromePath}`);
        }
        
        // Check if we can execute Chrome
        try {
          const { execSync } = require('child_process');
          const version = execSync(`"${chromePath}" --version`, { encoding: 'utf8' });
          logTS(`Chrome version: ${version.trim()}`);
        } catch (e) {
          logTS(`Cannot execute Chrome: ${e.message}`);
        }
        
        // Check user data directory permissions
        try {
          const testFile = path.join(uniqueUserDataDir, 'test.txt');
          fs.writeFileSync(testFile, 'test');
          fs.unlinkSync(testFile);
          logTS('User data directory is writable');
        } catch (e) {
          logTS(`ERROR: Cannot write to user data directory: ${e.message}`);
          throw new Error(`Cannot write to user data directory: ${uniqueUserDataDir}`);
        }
        
        // Check if the issue might be admin-related
        if (process.platform === 'win32') {
          try {
            // Simple check - try to write to Windows directory
            const systemDir = process.env.WINDIR || 'C:\\Windows';
            const testFile = path.join(systemDir, 'ch4c_test.tmp');
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            
            // If we got here, we're running as admin
            logTS('ERROR: Running as Administrator detected!');
            throw new Error('Chrome cannot launch properly when running as Administrator. Please run as a regular user.');
          } catch (adminCheckError) {
            // If we can't write to system dir, we're NOT admin (which is good)
            if (!adminCheckError.message.includes('Administrator')) {
              logTS('Not running as Administrator (good)');
            } else {
              throw adminCheckError;
            }
          }
        }
        
        // Check for locked Chrome profile
        const lockFile = path.join(uniqueUserDataDir, 'Singleton');
        if (fs.existsSync(lockFile)) {
          logTS('WARNING: Chrome profile lock file exists. Another Chrome instance may be using this profile.');
          logTS('Attempting to remove lock file...');
          try {
            fs.unlinkSync(lockFile);
            logTS('Lock file removed');
          } catch (e) {
            logTS(`Could not remove lock file: ${e.message}`);
          }
        }
      }
      
      // Re-throw with more context
      throw new Error(`Browser launch failed: ${launchError.message}`);
    }

    // Add error event listener
    browser.on('error', (err) => {
      logTS(`Browser error for encoder ${encoderConfig.url}:`, err);
    });

    if (!browser || !browser.isConnected()) {
      throw new Error('Browser failed to launch or is not connected');
    }

    browsers.set(encoderConfig.url, browser);
    let page;
    const pages = await browser.pages();
    if (pages && pages.length > 0) {
      logTS(`Using existing page for encoder ${encoderConfig.url}`);
      page = pages[0];
    } else {
      logTS(`No existing page found, creating new page for encoder ${encoderConfig.url}`);
      page = await browser.newPage();
    }

    // Set realistic HTTP headers for better bot detection evasion
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });

    // Block requests to local network addresses to prevent permission popup
    // Skip request interception for Peacock to avoid bot detection
    const skipRequestInterception = targetUrl && targetUrl.includes("peacocktv.com");

    if (!skipRequestInterception) {
      await page.setRequestInterception(true);

      page.on('request', (request) => {
        try {
          // Skip if request is already handled
          if (request.isInterceptResolutionHandled()) {
            return;
          }

          const url = request.url();

          // Check if URL is trying to access local network
          const isLocalNetwork =
            // Private IP ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
            /^https?:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/.test(url) ||
            // Localhost
            /^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) ||
            // .local domains
            /^https?:\/\/[^\/]+\.local/.test(url) ||
            // Dish set-top box communication (dishboxes.com)
            /dishboxes\.com/.test(url);

          if (isLocalNetwork) {
            // logTS(`Blocked local network request: ${url}`); // Suppressed to reduce log noise
            request.abort('blockedbyclient');
          } else {
            request.continue();
          }
        } catch (error) {
          // Request might already be handled or page might be closing
          // Don't log errors as this is expected during navigation/cleanup
        }
      });
      logTS(`[${encoderConfig.url}] Request interception enabled for local network blocking`);
    } else {
      logTS(`[${encoderConfig.url}] Request interception skipped for Peacock to reduce bot detection signals`);
    }

    // Hide the Chrome warning banner about unsupported flags
    await page.evaluateOnNewDocument(() => {
      const style = document.createElement('style');
      style.innerHTML = `
        #unsupported-flag-banner,
        div[style*="background: rgb(255, 249, 199)"] {
          display: none !important;
        }
      `;
      document.head?.appendChild(style) || document.addEventListener('DOMContentLoaded', () => {
        document.head.appendChild(style);
      });
    });

    logTS(`loading page for encoder ${encoderConfig.url}`);

    const navigationTimeout = 30000;

    // Position window before navigating
    await page.evaluate((width, height) => {
      window.moveTo(width, height);
    }, encoderConfig.width, encoderConfig.height);
    await delay(1000);

    // Navigate the page
    if (targetUrl) {
      try {
        if (targetUrl === "about:blank") {
          await page.goto(targetUrl, { waitUntil: 'load', timeout: 5000 });
        } else {
          // Existing navigation logic for actual content URLs
          if ((targetUrl.includes("watch.sling.com")) || (targetUrl.includes("photos.app.goo.gl"))) {
            await page.goto(targetUrl, {
              waitUntil: 'load',
              timeout: 30000
            });
          } else {
            await Promise.race([
              page.goto(targetUrl, { 
                waitUntil: 'networkidle2',
                timeout: navigationTimeout 
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Navigation timeout')), navigationTimeout)
              )
            ]);
          }
        }
      } catch (error) {
        if (targetUrl === "about:blank") {
          logTS(`Error navigating to about:blank for pooling ${encoderConfig.url}: ${error.message}`);
          if (browser && browser.isConnected()) {
            try { 
              await browser.close(); 
            } catch (closeErr) { 
              logTS(`Error closing browser during about:blank nav failure: ${closeErr.message}`); 
            }
          }
          browsers.delete(encoderConfig.url);
          return false;
        }
        throw error;
      }

      logTS(`page fully loaded for encoder ${encoderConfig.url}`);

      if (startMinimized) {
        logTS(`Attempting CDP minimization for encoder ${encoderConfig.url}`);
        try {
          const session = await page.createCDPSession();
          const {windowId} = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'minimized'}});
          await session.detach();
          logTS(`Successfully minimized window via CDP for encoder ${encoderConfig.url}`);
          await delay(500);
        } catch (cdpError) {
          logTS(`Error minimizing window via CDP for ${encoderConfig.url}:`, cdpError.message);
        }
      }
      launchResolve();
      return true;
    } else {
      logTS(`targetUrl is not defined for encoder ${encoderConfig.url}. This is unexpected.`);
      launchReject(new Error('targetUrl not defined'));
      return false;
    }
  } catch (error) {
    logTS(`Error launching browser for encoder ${encoderConfig.url}:`);
    logTS(`Error type: ${error.constructor.name}`);
    logTS(`Error message: ${error.message}`);
    if (error.stack) {
      logTS(`Stack trace:\n${error.stack}`);
    }

    // Clean up any partial browser instance
    if (browsers.has(encoderConfig.url)) {
      const browser = browsers.get(encoderConfig.url);
      if (browser && browser.isConnected()) {
        try {
          await browser.close();
        } catch (closeErr) {
          logTS(`Error closing failed browser: ${closeErr.message}`);
        }
      }
      browsers.delete(encoderConfig.url);
    }

    launchReject(error);
    return false;
  } finally {
    // Always clean up the mutex
    launchMutex.delete(encoderConfig.url);
  }
}

async function hideCursor(page) {
  try {
    await Promise.race([
      page.addStyleTag({
        content: `
          *:hover{cursor:none!important}
          *{cursor:none!important}
        `
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout adding style tag')), 1000))
    ]);

    // NFL Network requires mouse wiggle to hide cursor
    const mouse = page.mouse
    await mouse.move(Math.floor(Math.random() * 101) + 300, 500);

  } catch (error) {
    // Sometimes it times out for the cursor hiding
    //console.log('timeout adding style tag');
  }
}

async function GetProperty(element, property) {
  return await (await element.getProperty(property)).jsonValue();
}

/**
 * Finds the video element in the page, searching through frames
 * Returns the frame handle and video handle if found
 * @param {Object} page - The page object to search
 * @returns {Object} Object with frameHandle and videoHandle (both null if not found)
 */
async function findVideoElement(page) {
  let frameHandle = null;
  let videoHandle = null;

  try {
    const frames = await page.frames({ timeout: 1000 });
    for (const frame of frames) {
      try {
        // Look for videos in each frame
        const videos = await frame.$$('video');

        if (videos.length > 0) {
          // If multiple videos, try to find one with audio
          if (videos.length > 1) {
            logTS(`Found ${videos.length} videos, selecting best candidate`);

            for (const video of videos) {
              const hasAudio = await frame.evaluate((v) => {
                return v.mozHasAudio || Boolean(v.webkitAudioDecodedByteCount) ||
                       Boolean(v.audioTracks && v.audioTracks.length);
              }, video);

              if (hasAudio) {
                videoHandle = video;
                frameHandle = frame;
                logTS('Selected video element with audio');
                return { frameHandle, videoHandle };
              } else if (!videoHandle) {
                // Keep first video as fallback
                videoHandle = video;
                frameHandle = frame;
              }
            }
          } else {
            // Single video, use it
            videoHandle = videos[0];
            frameHandle = frame;
            logTS('Found video frame');
          }

          if (videoHandle) {
            return { frameHandle, videoHandle };
          }
        }
      } catch (error) {
        // Continue searching other frames
      }
    }
  } catch (error) {
    logTS(`Error searching for video element: ${error.message}`);
  }

  return { frameHandle, videoHandle };
}

/**
 * Sets up an audio monitor that runs in the browser context
 * Periodically verifies and re-applies the audio sink if it gets lost
 * This helps maintain audio when multiple browser instances are running
 * @param {Object} frameHandle - The frame containing the video element
 * @param {Object} videoHandle - The video element handle
 * @param {string} audioDevice - The audio device name to maintain
 * @param {string} encoderUrl - The encoder URL for logging
 */
async function setupAudioMonitor(frameHandle, videoHandle, audioDevice, encoderUrl) {
  if (!audioDevice) {
    return;
  }

  try {
    await frameHandle.evaluate(async (video, audioDeviceName, encoderUrlForLog) => {
      // Prevent multiple monitors on the same video
      if (video.__audioMonitorActive) {
        return;
      }
      video.__audioMonitorActive = true;

      // Check and re-apply audio every 15 seconds
      setInterval(async () => {
        try {
          const currentSinkId = video.sinkId;

          // If sinkId is empty or changed unexpectedly, re-apply
          if (!currentSinkId || currentSinkId === '' || currentSinkId === 'default') {
            console.log(`[CH4C] [${encoderUrlForLog}] Audio sink lost (current: ${currentSinkId || 'none'}), re-applying...`);

            const devices = await navigator.mediaDevices.enumerateDevices();
            const targetDevice = devices
              .filter(d => d.kind === 'audiooutput')
              .find(d => d.label.includes(audioDeviceName));

            if (targetDevice && video.setSinkId) {
              await video.setSinkId(targetDevice.deviceId);
              console.log(`[CH4C] [${encoderUrlForLog}] Audio sink re-applied: ${targetDevice.label}`);
            } else {
              console.log(`[CH4C] [${encoderUrlForLog}] Could not find audio device: ${audioDeviceName}`);
            }
          }
        } catch (err) {
          console.log(`[CH4C] [${encoderUrlForLog}] Audio monitor error: ${err.message}`);
        }
      }, 15000);

      console.log(`[CH4C] [${encoderUrlForLog}] Audio monitor active - checking every 15 seconds`);
    }, videoHandle, audioDevice, encoderUrl);

    logTS(`[${encoderUrl}] Audio monitor enabled for device: ${audioDevice}`);
  } catch (error) {
    logTS(`[${encoderUrl}] Failed to setup audio monitor (non-fatal): ${error.message}`);
  }
}

/**
 * Sets up an error recovery monitor for ESPN streams.
 * Detects when the stream stops (e.g. "too many devices" error) and reloads the page to recover.
 * Runs in Node.js context (not browser context) so it can trigger page navigation.
 * @param {Object} page - The Puppeteer page object
 */
function setupESPNErrorMonitor(page, encoderConfig = null) {
  if (!Constants.ENABLE_PAUSE_MONITOR) {
    return;
  }

  const url = page.url();
  const CHECK_INTERVAL_MS = 30000;
  const FAILURES_BEFORE_RECOVERY = 2;
  const MAX_RECOVERY_ATTEMPTS = 3;

  let consecutiveFailures = 0;
  let recoveryAttempts = 0;

  const intervalId = setInterval(async () => {
    try {
      const isPlaying = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        return Array.from(videos).some(v => !v.paused && !v.ended && v.readyState >= 3);
      });

      if (isPlaying) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
        logTS(`ESPN monitor: no active video (${consecutiveFailures}/${FAILURES_BEFORE_RECOVERY})`);

        if (consecutiveFailures >= FAILURES_BEFORE_RECOVERY) {
          if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
            logTS('ESPN monitor: max recovery attempts reached, stopping');
            clearInterval(intervalId);
            return;
          }

          consecutiveFailures = 0;
          recoveryAttempts++;
          logTS(`ESPN monitor: attempting page recovery (${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS})`);
          clearInterval(intervalId);

          await delay(5000);
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await delay(6000);
            await fullScreenVideoESPN(page, encoderConfig);
            // Re-apply audio device since page reload resets video element sinkIds
            if (encoderConfig && encoderConfig.audioDevice) {
              try {
                await page.evaluate(async (audioDevice) => {
                  const devices = await navigator.mediaDevices.enumerateDevices();
                  const targetDevice = devices.filter(d => d.kind === 'audiooutput').find(d => d.label.includes(audioDevice));
                  if (!targetDevice) return;
                  const allVideos = document.querySelectorAll('video');
                  for (const video of allVideos) {
                    if (video.setSinkId) await video.setSinkId(targetDevice.deviceId).catch(() => {});
                  }
                }, encoderConfig.audioDevice);
                logTS(`ESPN monitor: re-applied audio device after recovery: ${encoderConfig.audioDevice}`);
              } catch (audioErr) {
                logTS(`ESPN monitor: failed to re-apply audio device - ${audioErr.message}`);
              }
            }
          } catch (e) {
            logTS(`ESPN monitor: recovery failed - ${e.message}`);
          }
        }
      }
    } catch (e) {
      logTS(`ESPN monitor: stopping due to error - ${e.message}`);
      clearInterval(intervalId);
    }
  }, CHECK_INTERVAL_MS);

  logTS(`ESPN error recovery monitor active (${CHECK_INTERVAL_MS / 1000}s interval, max ${MAX_RECOVERY_ATTEMPTS} recoveries)`);
}

/**
 * Sets up a pause monitor that runs in the browser context
 * Automatically resumes video playback if it gets paused
 * @param {Object} frameHandle - The frame containing the video element
 * @param {Object} videoHandle - The video element handle
 * @param {Object} page - The page object for console forwarding
 */
async function setupPauseMonitor(frameHandle, videoHandle, page) {
  if (!Constants.ENABLE_PAUSE_MONITOR) {
    return;
  }

  try {
    // Forward browser console messages to Node.js console (only [CH4C] tagged messages)
    page.on('console', msg => {
      const text = msg.text();
      if (text.startsWith('[CH4C]')) {
        logTS(text);
      }
    });

    await frameHandle.evaluate((video, intervalSeconds) => {
      // Prevent multiple monitors on the same video
      if (video.__pauseMonitorActive) {
        return;
      }
      video.__pauseMonitorActive = true;

      setInterval(() => {
        if (video.paused && !video.ended) {
          console.log('[CH4C] Video paused - attempting to resume...');
          video.play().catch(err => {
            console.log('[CH4C] Failed to resume video:', err.message);
          });
        }
      }, intervalSeconds * 1000);

      console.log(`[CH4C] Pause monitor active - checking every ${intervalSeconds} seconds`);
    }, videoHandle, Constants.PAUSE_MONITOR_INTERVAL);

    logTS(`Pause monitor enabled (interval: ${Constants.PAUSE_MONITOR_INTERVAL}s)`);
  } catch (error) {
    logTS(`Failed to setup pause monitor (non-fatal): ${error.message}`);
  }
}

async function fullScreenVideo(page) {
  let frameHandle, videoHandle

  // try every few seconds to look for the video
  // necessary since some pages take time to load the actual video
  videoSearch: for (let step = 0; step < Constants.FIND_VIDEO_RETRIES; step++) {
    // call this every loop since the page might be changing
    // e.g. during the "authorized to view with Xfinity" splash screen
    try {
      const frames = await page.frames( { timeout: 1000 })
      for (const frame of frames) {
        try {
          // Improvement 1: Smart video selection - prefer videos with audio
          const videos = await frame.$$('video');

          if (videos.length > 0) {
            // If multiple videos, try to find one with audio
            if (videos.length > 1) {
              logTS(`Found ${videos.length} videos, selecting best candidate`);

              for (const video of videos) {
                const hasAudio = await frame.evaluate((v) => {
                  return v.mozHasAudio || Boolean(v.webkitAudioDecodedByteCount) ||
                         Boolean(v.audioTracks && v.audioTracks.length);
                }, video);

                if (hasAudio) {
                  videoHandle = video;
                  frameHandle = frame;
                  logTS('Selected video element with audio');
                  break videoSearch;
                } else if (!videoHandle) {
                  // Keep first video as fallback
                  videoHandle = video;
                  frameHandle = frame;
                }
              }
            } else {
              // Single video, use it
              videoHandle = videos[0];
              frameHandle = frame;
              logTS('found video frame');
            }

            if (videoHandle) {
              break videoSearch;
            }
          }
        } catch (error) {
          // Continue searching
        }
      }
    } catch (error) {
      console.log('error looking for video', error)
      videoHandle=null
    }

    if (!videoHandle) {
      await delay(Constants.FIND_VIDEO_WAIT * 1000);
    }
  }

  if (videoHandle) {
    // Improvement 2: Less aggressive - check if already playing first
    logTS("Checking video playback status");

    let isPlaying = false;
    for (let step = 0; step < Constants.PLAY_VIDEO_RETRIES; step++) {
      const currentTime = await GetProperty(videoHandle, 'currentTime')
      const readyState = await GetProperty(videoHandle, 'readyState')
      const paused = await GetProperty(videoHandle, 'paused')
      const ended = await GetProperty(videoHandle, 'ended')

      // Check if video is already playing or ready to play
      if (!!(currentTime > 0 && readyState > 2 && !paused && !ended)) {
        logTS("Video is already playing");
        isPlaying = true;
        break;
      }

      // Check if video is ready but just paused (may autoplay)
      if (readyState >= 3 && !ended) {
        // Wait a moment to see if autoplay kicks in
        if (step === 0) {
          logTS("Video ready, waiting for autoplay...");
          await delay(1500);

          // Check again after waiting
          const stillPaused = await GetProperty(videoHandle, 'paused');
          const newTime = await GetProperty(videoHandle, 'currentTime');

          if (!stillPaused || newTime > 0) {
            logTS("Video autoplayed successfully");
            isPlaying = true;
            break;
          }
        }
      }

      // Video not playing, try to start it
      logTS("Attempting to play video");

      // Improvement 3: Add delay between attempts
      if (step > 0) {
        await delay(1000);
      }

      // alternate between calling play and click (Disney needs click)
      if (step % 2 === 0) {
        await frameHandle.evaluate((video) => {
          video.play()
        }, videoHandle)
      } else {
        await videoHandle.click()
      }
    }

    logTS("going full screen and unmuting");
    await frameHandle.evaluate((video) => {
      video.muted = false
      video.removeAttribute('muted')
      video.style.cursor = 'none!important'
      video.requestFullscreen()
    }, videoHandle)

    // Some sites pause video when going fullscreen, so explicitly play after fullscreen
    await delay(500); // Brief delay to let fullscreen transition start
    await frameHandle.evaluate((video) => {
      if (video.paused) {
        video.play().catch(err => console.log('Play after fullscreen failed:', err));
      }
    }, videoHandle);

    // Setup pause monitor to automatically resume if video gets paused
    await setupPauseMonitor(frameHandle, videoHandle, page);

  } else {
    console.log('did not find video')
  }
  logTS("hiding cursor");
  // some sites respond better to hiding cursor after full screen
  await hideCursor(page)
}

async function fullScreenVideoSling(page, encoderConfig = null) {
  logTS("URL contains watch.sling.com, going fullscreen");

  // Click the full screen button
  const fullScreenButton = await page.waitForSelector('div.player-button.active.videoPlayerFullScreenToggle', { visible: true });
  logTS("button available, now clicking");
  await fullScreenButton.click(); //click for fullscreen

  // Find Mute button and then use volume slider
  const muteButton = await page.waitForSelector('div.player-button.active.volumeControls', { visible: true });
  await muteButton.click(); //click unmute
  // Simulate pressing the right arrow key 10 times to max volume
  for (let i = 0; i < 10; i++) {
    await delay(100);
    await page.keyboard.press('ArrowRight');
  }
  logTS("finished change to fullscreen and max volume");

  // Setup audio monitor to maintain audio sink (helps with multi-stream scenarios)
  if (encoderConfig && encoderConfig.audioDevice) {
    const { frameHandle, videoHandle } = await findVideoElement(page);
    if (frameHandle && videoHandle) {
      await setupAudioMonitor(frameHandle, videoHandle, encoderConfig.audioDevice, encoderConfig.url);
    }
  }
}

async function selectPeacockClosedCaptions(page, ccOption) {
  // Returns true if successfully selected, false if button/menu not available yet
  try {
    const viewport = page.viewport();
    const cx = Math.floor((viewport ? viewport.width : 1280) / 2);
    const cy = Math.floor((viewport ? viewport.height : 720) / 2);
    await page.mouse.move(cx, cy);
    await delay(500);

    const settingsBtn = await page.waitForSelector('button[data-testid="language-settings-button"]', { timeout: 5000 }).catch(() => null);
    if (!settingsBtn) {
      return false; // Not available yet (ads or player not ready)
    }
    await settingsBtn.click();
    await delay(300);

    const ccLabel = ccOption === 'English' ? 'English' : 'Off';
    const clicked = await page.evaluate((label) => {
      const drawer = document.querySelector('[data-testid="subtitles-drawer"]');
      if (!drawer) return false;
      for (const btn of drawer.querySelectorAll('button')) {
        const span = btn.querySelector('span.label');
        if (span && span.textContent.trim() === label) {
          btn.click();
          return true;
        }
      }
      return false;
    }, ccLabel);

    if (clicked) {
      logTS(`Peacock CC: Selected "${ccLabel}"`);
      await page.mouse.move(0, 0);
      return true;
    }

    // Option not found — close menu and signal not ready
    logTS(`Peacock CC: "${ccLabel}" not found in subtitles drawer`);
    await settingsBtn.click(); // toggle closed
    return false;
  } catch (err) {
    logTS(`Peacock CC selection error (non-fatal): ${err.message}`);
    return false;
  }
}

async function selectPeacockClosedCaptionsWithRetry(page, ccOption) {
  const maxAttempts = 6;
  const retryDelay = 30000; // 30s — covers typical pre-roll ad breaks

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logTS(`Peacock CC: Attempt ${attempt}/${maxAttempts} for "${ccOption}"`);
    const success = await selectPeacockClosedCaptions(page, ccOption);
    if (success) return;

    if (attempt < maxAttempts) {
      logTS(`Peacock CC: Not available yet, retrying in 30s...`);
      await delay(retryDelay);
    }
  }
  logTS(`Peacock CC: Could not select after ${maxAttempts} attempts`);
}

async function fullScreenVideoPeacock(page, encoderConfig = null, closedCaptions = '') {
  logTS("URL contains peacocktv.com, setting up video fullscreen");

  // Add minimal mouse movement to simulate human presence
  logTS("Adding mouse movement to simulate human presence");
  await page.mouse.move(500, 400);
  await delay(1000 + Math.random() * 1000); // 1-2 second delay (human observation time)

  // Move mouse again to create more behavioral signals
  await page.mouse.move(600 + Math.random() * 200, 450 + Math.random() * 100);
  await delay(500 + Math.random() * 500); // 0.5-1 second delay

  // Press 'f' key to make the video player fullscreen within the browser window
  await delay(1000); // Wait for player to load
  await page.keyboard.press('f');

  // Wait for fullscreen transition to complete
  await delay(1500);

  // Find video element and setup pause monitor
  const { frameHandle, videoHandle } = await findVideoElement(page);
  if (frameHandle && videoHandle) {
    logTS("Found Peacock video element, setting up pause monitor");

    // Re-apply audio device after fullscreen transition (Peacock may recreate video elements)
    if (encoderConfig && encoderConfig.audioDevice) {
      logTS(`[${encoderConfig.url}] Re-applying audio device after fullscreen: ${encoderConfig.audioDevice}`);
      try {
        const audioResult = await frameHandle.evaluate(async (video, audioDevice) => {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const audioDevices = devices.filter(d => d.kind === 'audiooutput');
          const targetDevice = audioDevices.find(d => d.label.includes(audioDevice));

          if (!targetDevice) {
            return { success: false, error: `Device not found matching: ${audioDevice}`, availableDevices: audioDevices.map(d => d.label) };
          }

          if (!video.setSinkId) {
            return { success: false, error: 'setSinkId not supported' };
          }

          await video.setSinkId(targetDevice.deviceId);
          console.log(`[CH4C] Re-applied audio sink to: ${targetDevice.label}`);
          return { success: true, device: targetDevice.label, sinkId: video.sinkId };
        }, videoHandle, encoderConfig.audioDevice);

        if (audioResult.success) {
          logTS(`[${encoderConfig.url}] Audio device re-applied successfully: ${audioResult.device}`);
        } else {
          logTS(`[${encoderConfig.url}] Audio device re-application failed: ${audioResult.error}`);
          if (audioResult.availableDevices) {
            logTS(`[${encoderConfig.url}] Available audio devices: ${audioResult.availableDevices.join(', ')}`);
          }
        }
      } catch (audioErr) {
        logTS(`[${encoderConfig.url}] Warning: Could not re-apply audio device: ${audioErr.message}`);
      }
    }

    // Ensure video is playing
    await frameHandle.evaluate((video) => {
      if (video.paused) {
        video.play().catch(err => console.log('Play failed:', err));
      }
    }, videoHandle);

    // Setup pause monitor to automatically resume if video gets paused
    await setupPauseMonitor(frameHandle, videoHandle, page);

    // Setup audio monitor to re-apply audio sink if it gets lost (helps with multi-stream scenarios)
    if (encoderConfig && encoderConfig.audioDevice) {
      await setupAudioMonitor(frameHandle, videoHandle, encoderConfig.audioDevice, encoderConfig.url);
    }
  } else {
    logTS("Warning: Could not find Peacock video element for pause monitoring");
  }

  // Fire CC selection in background with retries — ads may block the button initially
  if (closedCaptions) {
    selectPeacockClosedCaptionsWithRetry(page, closedCaptions)
      .catch(err => logTS(`Peacock CC background error: ${err.message}`));
  }

  logTS("finished fullscreen setup");
}

async function fullScreenVideoSpectrum(page) {
  logTS("URL contains spectrum.net, going fullscreen");

  await delay(1030);
  await page.evaluate(() => {
    const element = document.documentElement;
    if (element.requestFullscreen) {
      element.requestFullscreen();
    } else if (element.mozRequestFullScreen) {
      element.mozRequestFullScreen();
    } else if (element.webkitRequestFullscreen) {
      element.webkitRequestFullscreen();
    } else if (element.msRequestFullscreen) {
      element.msRequestFullscreen();
    }
  });

  logTS("finished change to fullscreen");
}

async function fullScreenVideoGooglePhotos(page) {
  logTS("URL contains Google Photos");

  // Simulate pressing the tab key key 10 times to get to the More Options button
  for (let i = 0; i < 8; i++) {
    await delay(200);
    await page.keyboard.press('Tab');
  }

  // Press Enter twice to start Slideshow
  await page.keyboard.press('Enter');
  await delay(200);
  await page.keyboard.press('Enter');

  logTS("changed to fullscreen and max volume");
}

async function fullScreenVideoESPN(page, encoderConfig = null) {
  logTS("URL contains ESPN, setting up fullscreen and unmuting");

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 10; i++) {  // Wait up to ~5 seconds
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        // Check if any video has enough data (readyState 3=HAVE_FUTURE_DATA, 4=HAVE_ENOUGH_DATA)
        for (const video of videos) {
          if (video.readyState >= 3) {
            return true;
          }
        }
        return false;
      });
      if (videoReady) {
        logTS("ESPN video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("ESPN video not ready after timeout, continuing anyway");
  }

  // Move mouse to center of viewport to trigger player controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
    await page.mouse.click(centerX, centerY);
    await delay(500);
    // Move mouse again to ensure controls stay visible
    await page.mouse.move(centerX, centerY - 100);
    await delay(300);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Use evaluate to find and interact with elements (handles shadow DOM)
  const result = await page.evaluate(() => {
    const results = { mute: 'not found', volume: 'not found', fullscreen: 'not found' };

    // Helper to search in shadow DOM
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;

      // Search in shadow roots
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    // Find and handle mute button, return its position for volume hover
    const muteButton = querySelectorDeep('button.toggle-mute-button');
    if (muteButton) {
      if (muteButton.classList.contains('volume-muted')) {
        muteButton.click();
        results.mute = 'was muted, clicked unmute';
      } else {
        results.mute = 'already unmuted';
      }
      const rect = muteButton.getBoundingClientRect();
      results.muteButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    return results;
  });

  logTS(`ESPN mute status: ${result.mute}`);

  // Set volume to max: hover over mute button to reveal volume bar, then click far right
  if (result.muteButtonRect) {
    const muteCenterX = result.muteButtonRect.x + result.muteButtonRect.width / 2;
    const muteCenterY = result.muteButtonRect.y + result.muteButtonRect.height / 2;
    await page.mouse.move(muteCenterX, muteCenterY);
    await delay(500);

    // Now get the volume bar position
    const volInfo = await page.evaluate(() => {
      function querySelectorDeep(selector, root = document) {
        const element = root.querySelector(selector);
        if (element) return element;
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = querySelectorDeep(selector, el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }
      const thumb = querySelectorDeep('.volume-bar__thumb');
      if (thumb) {
        const currentVolume = thumb.getAttribute('aria-valuenow');
        const bar = thumb.parentElement;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          return { currentVolume, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });

    if (volInfo && volInfo.width > 0) {
      const clickX = volInfo.x + volInfo.width - 2;
      const clickY = volInfo.y + volInfo.height / 2;
      await page.mouse.click(clickX, clickY);
      logTS(`ESPN volume: clicked bar at max position (was ${volInfo.currentVolume}%)`);
    } else {
      logTS(`ESPN volume: volume bar not visible`);
    }
  } else {
    logTS(`ESPN volume: mute button not found`);
  }

  // Move mouse away from controls before fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  // Click fullscreen button
  const fullscreenResult = await page.evaluate(() => {
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }
    const fullscreenButton = querySelectorDeep('button.fullscreen-icon');
    if (fullscreenButton) {
      fullscreenButton.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`ESPN fullscreen status: ${fullscreenResult}`);

  // Wait for fullscreen transition to complete, then click play to resume
  await delay(1000);

  const playResult = await page.evaluate(() => {
    // Helper to search in shadow DOM
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;

      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    // Find and click play button to resume playback
    const playButton = querySelectorDeep('button.play-button');
    if (playButton) {
      playButton.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`ESPN play status: ${playResult}`);

  // Setup pause monitor to catch simple unexpected pauses
  const { frameHandle, videoHandle } = await findVideoElement(page);
  if (frameHandle && videoHandle) {
    await setupPauseMonitor(frameHandle, videoHandle, page);
  } else {
    logTS("ESPN: could not find video element for pause monitor");
  }

  // Setup error recovery monitor to handle hard errors (e.g. too many devices streaming)
  setupESPNErrorMonitor(page, encoderConfig);

  logTS("finished ESPN fullscreen setup");
}

async function fullScreenVideoDisneyNow(page) {
  logTS("URL contains DisneyNow, setting up fullscreen");

  // Play overlay already clicked in setupBrowserAudio, move mouse to show controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(500);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Handle unmute, volume, and fullscreen
  const result = await page.evaluate(() => {
    const results = { mute: 'not found', volume: 'not found', fullscreen: 'not found' };

    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    // Find and handle mute button, return its position for volume hover
    const muteButton = querySelectorDeep('button.toggle-mute-button');
    if (muteButton) {
      if (muteButton.classList.contains('volume-muted')) {
        muteButton.click();
        results.mute = 'was muted, clicked unmute';
      } else {
        results.mute = 'already unmuted';
      }
      const rect = muteButton.getBoundingClientRect();
      results.muteButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    return results;
  });

  logTS(`DisneyNow mute status: ${result.mute}`);

  // Set volume to max: hover over mute button to reveal volume bar, then click far right
  if (result.muteButtonRect) {
    const muteCenterX = result.muteButtonRect.x + result.muteButtonRect.width / 2;
    const muteCenterY = result.muteButtonRect.y + result.muteButtonRect.height / 2;
    await page.mouse.move(muteCenterX, muteCenterY);
    await delay(500);

    const volInfo = await page.evaluate(() => {
      function querySelectorDeep(selector, root = document) {
        const element = root.querySelector(selector);
        if (element) return element;
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = querySelectorDeep(selector, el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }
      const thumb = querySelectorDeep('.volume-bar__thumb');
      if (thumb) {
        const currentVolume = thumb.getAttribute('aria-valuenow');
        const bar = thumb.parentElement;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          return { currentVolume, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });

    if (volInfo && volInfo.width > 0) {
      const clickX = volInfo.x + volInfo.width - 2;
      const clickY = volInfo.y + volInfo.height / 2;
      await page.mouse.click(clickX, clickY);
      logTS(`DisneyNow volume: clicked bar at max position (was ${volInfo.currentVolume}%)`);
    } else {
      logTS(`DisneyNow volume: volume bar not visible`);
    }
  } else {
    logTS(`DisneyNow volume: mute button not found`);
  }

  // Move mouse away then click fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  const fullscreenResult = await page.evaluate(() => {
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }
    const fullscreenButton = querySelectorDeep('button.fullscreen-icon');
    if (fullscreenButton) {
      fullscreenButton.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`DisneyNow fullscreen status: ${fullscreenResult}`);
  logTS("finished DisneyNow fullscreen setup");
}

async function fullScreenVideoFXNow(page) {
  logTS("URL contains FXNow, setting up fullscreen");

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 10; i++) {  // Wait up to ~5 seconds
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.readyState >= 3) return true;
        }
        return false;
      });
      if (videoReady) {
        logTS("FXNow video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("FXNow video not ready after timeout, continuing anyway");
  }

  // Move mouse to center of viewport to trigger player controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
    await page.mouse.click(centerX, centerY);
    await delay(500);
    await page.mouse.move(centerX, centerY - 100);
    await delay(300);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Handle unmute, volume, and fullscreen
  const result = await page.evaluate(() => {
    const results = { mute: 'not found', volume: 'not found', fullscreen: 'not found' };

    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    // Find and handle mute button, return its position for volume hover
    const muteButton = querySelectorDeep('button.toggle-mute-button');
    if (muteButton) {
      if (muteButton.classList.contains('volume-muted')) {
        muteButton.click();
        results.mute = 'was muted, clicked unmute';
      } else {
        results.mute = 'already unmuted';
      }
      const rect = muteButton.getBoundingClientRect();
      results.muteButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    return results;
  });

  logTS(`FXNow mute status: ${result.mute}`);

  // Set volume to max: hover over mute button to reveal volume bar, then click far right
  if (result.muteButtonRect) {
    const muteCenterX = result.muteButtonRect.x + result.muteButtonRect.width / 2;
    const muteCenterY = result.muteButtonRect.y + result.muteButtonRect.height / 2;
    await page.mouse.move(muteCenterX, muteCenterY);
    await delay(500);

    const volInfo = await page.evaluate(() => {
      function querySelectorDeep(selector, root = document) {
        const element = root.querySelector(selector);
        if (element) return element;
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = querySelectorDeep(selector, el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }
      const thumb = querySelectorDeep('.volume-bar__thumb');
      if (thumb) {
        const currentVolume = thumb.getAttribute('aria-valuenow');
        const bar = thumb.parentElement;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          return { currentVolume, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });

    if (volInfo && volInfo.width > 0) {
      const clickX = volInfo.x + volInfo.width - 2;
      const clickY = volInfo.y + volInfo.height / 2;
      await page.mouse.click(clickX, clickY);
      logTS(`FXNow volume: clicked bar at max position (was ${volInfo.currentVolume}%)`);
    } else {
      logTS(`FXNow volume: volume bar not visible`);
    }
  } else {
    logTS(`FXNow volume: mute button not found`);
  }

  // Move mouse away then click fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  const fullscreenResult = await page.evaluate(() => {
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }
    const fullscreenButton = querySelectorDeep('button.fullscreen-icon');
    if (fullscreenButton) {
      fullscreenButton.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`FXNow fullscreen status: ${fullscreenResult}`);

  // Wait for fullscreen transition, then click play to resume
  await delay(1000);

  const playResult = await page.evaluate(() => {
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    const playButton = querySelectorDeep('button.play-button');
    if (playButton) {
      playButton.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`FXNow play status: ${playResult}`);
  logTS("finished FXNow fullscreen setup");
}

async function fullScreenVideoNatGeo(page) {
  logTS("URL contains National Geographic, setting up fullscreen");

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.readyState >= 3) return true;
        }
        return false;
      });
      if (videoReady) {
        logTS("NatGeo video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("NatGeo video not ready after timeout, continuing anyway");
  }

  // Move mouse to center of viewport to trigger player controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
    await page.mouse.click(centerX, centerY);
    await delay(500);
    await page.mouse.move(centerX, centerY - 100);
    await delay(300);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Handle unmute
  const result = await page.evaluate(() => {
    const results = { mute: 'not found' };

    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    const muteButton = querySelectorDeep('button.toggle-mute-button');
    if (muteButton) {
      if (muteButton.classList.contains('volume-muted')) {
        muteButton.click();
        results.mute = 'was muted, clicked unmute';
      } else {
        results.mute = 'already unmuted';
      }
      const rect = muteButton.getBoundingClientRect();
      results.muteButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    return results;
  });

  logTS(`NatGeo mute status: ${result.mute}`);

  // Set volume to max: hover over mute button to reveal volume bar, then click far right
  if (result.muteButtonRect) {
    const muteCenterX = result.muteButtonRect.x + result.muteButtonRect.width / 2;
    const muteCenterY = result.muteButtonRect.y + result.muteButtonRect.height / 2;
    await page.mouse.move(muteCenterX, muteCenterY);
    await delay(500);

    const volInfo = await page.evaluate(() => {
      function querySelectorDeep(selector, root = document) {
        const element = root.querySelector(selector);
        if (element) return element;
        const allElements = root.querySelectorAll('*');
        for (const el of allElements) {
          if (el.shadowRoot) {
            const found = querySelectorDeep(selector, el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }
      const thumb = querySelectorDeep('.volume-bar__thumb');
      if (thumb) {
        const currentVolume = thumb.getAttribute('aria-valuenow');
        const bar = thumb.parentElement;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          return { currentVolume, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });

    if (volInfo && volInfo.width > 0) {
      const clickX = volInfo.x + volInfo.width - 2;
      const clickY = volInfo.y + volInfo.height / 2;
      await page.mouse.click(clickX, clickY);
      logTS(`NatGeo volume: clicked bar at max position (was ${volInfo.currentVolume}%)`);
    } else {
      logTS(`NatGeo volume: volume bar not visible`);
    }
  } else {
    logTS(`NatGeo volume: mute button not found`);
  }

  // Move mouse away then click fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  const fullscreenResult = await page.evaluate(() => {
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }
    const fullscreenButton = querySelectorDeep('button.fullscreen-icon');
    if (fullscreenButton) {
      fullscreenButton.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`NatGeo fullscreen status: ${fullscreenResult}`);

  // Wait for fullscreen transition, then click play to resume
  await delay(1000);

  const playResult = await page.evaluate(() => {
    function querySelectorDeep(selector, root = document) {
      const element = root.querySelector(selector);
      if (element) return element;
      const allElements = root.querySelectorAll('*');
      for (const el of allElements) {
        if (el.shadowRoot) {
          const found = querySelectorDeep(selector, el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    const playButton = querySelectorDeep('button.play-button');
    if (playButton) {
      playButton.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`NatGeo play status: ${playResult}`);
  logTS("finished NatGeo fullscreen setup");
}

async function fullScreenVideoDiscovery(page) {
  logTS("URL contains Discovery, setting up fullscreen");

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.readyState >= 3) return true;
        }
        return false;
      });
      if (videoReady) {
        logTS("Discovery video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("Discovery video not ready after timeout, continuing anyway");
  }

  // Move mouse to center of viewport to trigger player controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(500);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Get volume button position for hover, then handle volume slider
  const result = await page.evaluate(() => {
    const results = { volume: 'not found' };

    const volumeBtn = document.querySelector('button[aria-label="Volume"]');
    if (volumeBtn) {
      const rect = volumeBtn.getBoundingClientRect();
      results.volumeButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      results.volume = 'found';
    }

    return results;
  });

  // Hover over volume button to reveal vertical slider, then click at top
  if (result.volumeButtonRect) {
    const volBtnCenterX = result.volumeButtonRect.x + result.volumeButtonRect.width / 2;
    const volBtnCenterY = result.volumeButtonRect.y + result.volumeButtonRect.height / 2;
    await page.mouse.move(volBtnCenterX, volBtnCenterY);
    await delay(500);

    const volInfo = await page.evaluate(() => {
      const slider = document.querySelector('div[aria-label="Volume Slider"]');
      if (slider) {
        const currentVolume = slider.getAttribute('aria-valuenow');
        const rect = slider.getBoundingClientRect();
        return { currentVolume, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      return null;
    });

    if (volInfo && volInfo.height > 0) {
      // Vertical slider - click near the top for max volume
      const clickX = volInfo.x + volInfo.width / 2;
      const clickY = volInfo.y + 2;
      await page.mouse.click(clickX, clickY);
      logTS(`Discovery volume: clicked slider at top for max (was ${volInfo.currentVolume}%)`);
    } else {
      logTS(`Discovery volume: slider not visible`);
    }
  } else {
    logTS(`Discovery volume: volume button not found`);
  }

  // Move mouse away then click fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  const fullscreenResult = await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label="Fullscreen"]');
    if (btn) {
      btn.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`Discovery fullscreen status: ${fullscreenResult}`);
  logTS("finished Discovery fullscreen setup");
}

async function fullScreenVideoCBS(page) {
  logTS("URL contains CBS, setting up fullscreen");

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.readyState >= 3) return true;
        }
        return false;
      });
      if (videoReady) {
        logTS("CBS video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("CBS video not ready after timeout, continuing anyway");
  }

  // Move mouse to center of viewport to trigger player controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(500);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Get volume button position for hover, then handle volume slider
  const result = await page.evaluate(() => {
    const results = { mute: 'not found', volume: 'not found' };

    // Check mute state - if mute_cross is visible (aria-hidden="false"), audio is muted
    const muteBtn = document.querySelector('button.btn-volume');
    if (muteBtn) {
      const muteCross = muteBtn.querySelector('.mute_cross');
      if (muteCross && muteCross.getAttribute('aria-hidden') === 'false') {
        // Currently muted, click to unmute
        muteBtn.click();
        results.mute = 'was muted, clicked unmute';
      } else {
        results.mute = 'already unmuted';
      }
      const rect = muteBtn.getBoundingClientRect();
      results.volumeButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    return results;
  });

  logTS(`CBS mute status: ${result.mute}`);

  // Hover over volume button to reveal vertical slider, then click at top for max
  if (result.volumeButtonRect) {
    const volBtnCenterX = result.volumeButtonRect.x + result.volumeButtonRect.width / 2;
    const volBtnCenterY = result.volumeButtonRect.y + result.volumeButtonRect.height / 2;
    await page.mouse.move(volBtnCenterX, volBtnCenterY);
    await delay(500);

    const volInfo = await page.evaluate(() => {
      const slider = document.querySelector('.volume-slider-li-content-progress-content');
      if (slider) {
        // Get the parent container for the full slider area
        const container = slider.parentElement;
        if (container) {
          const rect = container.getBoundingClientRect();
          const currentHeight = slider.style.height || '0%';
          return { currentVolume: currentHeight, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });

    if (volInfo && volInfo.height > 0) {
      // Vertical slider - click near the top for max volume
      const clickX = volInfo.x + volInfo.width / 2;
      const clickY = volInfo.y + 2;
      await page.mouse.click(clickX, clickY);
      logTS(`CBS volume: clicked slider at top for max (was ${volInfo.currentVolume})`);
    } else {
      logTS(`CBS volume: slider not visible`);
    }
  } else {
    logTS(`CBS volume: volume button not found`);
  }

  // Move mouse away then click fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  const fullscreenResult = await page.evaluate(() => {
    const btn = document.querySelector('button.btn-fullscreen');
    if (btn) {
      btn.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`CBS fullscreen status: ${fullscreenResult}`);
  logTS("finished CBS fullscreen setup");
}

async function fullScreenVideoAETV(page) {
  logTS("URL contains AETV, setting up fullscreen");

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.readyState >= 3) return true;
        }
        return false;
      });
      if (videoReady) {
        logTS("AETV video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("AETV video not ready after timeout, continuing anyway");
  }

  // Move mouse to center of viewport to trigger player controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
    await page.mouse.click(centerX, centerY);
    await delay(500);
    await page.mouse.move(centerX, centerY - 100);
    await delay(300);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Handle unmute - check aria-label on the volume icon
  const result = await page.evaluate(() => {
    const results = { mute: 'not found' };

    const muteImg = document.querySelector('img[aria-label="Mute"], img[aria-label="Unmute"]');
    if (muteImg) {
      if (muteImg.getAttribute('aria-label') === 'Unmute') {
        muteImg.click();
        results.mute = 'was muted, clicked unmute';
      } else {
        results.mute = 'already unmuted';
      }
      // Get the parent button/container position for hover
      const parent = muteImg.parentElement;
      if (parent) {
        const rect = parent.getBoundingClientRect();
        results.muteButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }

    return results;
  });

  logTS(`AETV mute status: ${result.mute}`);

  // Set volume to max: hover over mute button to reveal volume bar, then click far right
  if (result.muteButtonRect) {
    const muteCenterX = result.muteButtonRect.x + result.muteButtonRect.width / 2;
    const muteCenterY = result.muteButtonRect.y + result.muteButtonRect.height / 2;
    await page.mouse.move(muteCenterX, muteCenterY);
    await delay(500);

    const volInfo = await page.evaluate(() => {
      const volumeLevel = document.querySelector('#volume-level');
      if (volumeLevel) {
        const currentWidth = volumeLevel.style.width;
        // Get the parent container which represents the full volume bar track
        const bar = volumeLevel.parentElement;
        if (bar) {
          const rect = bar.getBoundingClientRect();
          return { currentVolume: currentWidth, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      return null;
    });

    if (volInfo && volInfo.width > 0) {
      const clickX = volInfo.x + volInfo.width - 2;
      const clickY = volInfo.y + volInfo.height / 2;
      await page.mouse.click(clickX, clickY);
      logTS(`AETV volume: clicked bar at max position (was ${volInfo.currentVolume})`);
    } else {
      logTS(`AETV volume: volume bar not visible`);
    }
  } else {
    logTS(`AETV volume: mute button not found`);
  }

  // Move mouse away then click fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  const fullscreenResult = await page.evaluate(() => {
    const btn = document.querySelector('img[aria-label="Show Fullscreen"]');
    if (btn) {
      btn.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`AETV fullscreen status: ${fullscreenResult}`);
  logTS("finished AETV fullscreen setup");
}

async function fullScreenVideoUSA(page) {
  logTS("URL contains usanetwork.com, setting up fullscreen");

  // Extract the channel keyword from the URL hash (e.g., #Syfy_East → "Syfy_East")
  const pageUrl = page.url();
  const hashMatch = pageUrl.match(/#(.+)$/);
  const channelKeyword = hashMatch ? hashMatch[1] : null;

  // If a non-default channel is requested, switch to it via the EPG
  if (channelKeyword) {
    // Convert keyword to channel title: Syfy_East → Syfy-East, E-_East → E!-East
    const channelTitle = channelKeyword.replace(/_/g, '-').replace(/^E-/, 'E!');
    logTS(`USA Network: switching to "${channelTitle}"`);

    // Wait for EPG tiles to load — the aria-label is on the inner .tile-info div
    let epgLoaded = false;
    for (let i = 0; i < 20; i++) {
      try {
        epgLoaded = await page.evaluate(() =>
          document.querySelectorAll('.tile-info[aria-label]').length > 0
        );
        if (epgLoaded) break;
      } catch (e) { /* continue */ }
      await delay(500);
    }

    if (!epgLoaded) {
      logTS("USA Network: EPG tiles did not appear, proceeding with default channel");
    } else {
      // Find the tile: aria-label is on .tile-info (inner div); clickable element is .epg-tile-container
      // Prefer .selectable (currently-airing); fall back to any tile for this channel
      const tileRect = await page.evaluate((title) => {
        const selectableInfo = document.querySelector(
          `.epg-tile-container.selectable .tile-info[aria-label^="${title} "]`
        );
        const anyInfo = selectableInfo
          || document.querySelector(`.tile-info[aria-label^="${title} "]`);

        if (!anyInfo) return { found: false };

        const tile = anyInfo.closest('.epg-tile-container') || anyInfo;
        tile.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = tile.getBoundingClientRect();
        const label = anyInfo.getAttribute('aria-label') || '';
        return {
          found: true,
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          label: label.substring(0, 70),
          selectable: selectableInfo !== null,
        };
      }, channelTitle);

      if (!tileRect.found) {
        logTS(`USA Network: no EPG tile found for "${channelTitle}", proceeding with default`);
      } else {
        logTS(`USA Network: found${tileRect.selectable ? ' selectable' : ''} tile: "${tileRect.label}..."`);
        await delay(300);
        await page.mouse.move(tileRect.x, tileRect.y);
        await delay(100);
        await page.mouse.click(tileRect.x, tileRect.y);
        logTS(`USA Network: clicked tile at (${tileRect.x}, ${tileRect.y})`);

        // Wait up to 8s for the stream to switch (readyState drops below 3)
        let channelSwitched = false;
        for (let i = 0; i < 16; i++) {
          await delay(500);
          try {
            const notReady = await page.evaluate(() => {
              const videos = document.querySelectorAll('video');
              for (const v of videos) { if (v.readyState < 3) return true; }
              return false;
            });
            if (notReady) { channelSwitched = true; logTS("USA Network: stream switch detected"); break; }
          } catch (e) { /* continue */ }
        }
        if (!channelSwitched) {
          logTS("USA Network: stream switch not confirmed, proceeding anyway");
          await delay(2000);
        }
      }
    }
  }

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 30; i++) {
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.readyState >= 3) return true;
        }
        return false;
      });
      if (videoReady) {
        logTS("USA Network video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("USA Network video not ready after timeout, continuing anyway");
  }

  // Start playback: try the Video.js big play button first, then fall back to video.play()
  const playResult = await page.evaluate(() => {
    const btn = document.querySelector('button.vjs-big-play-button');
    if (btn) {
      btn.click();
      return 'btn-clicked';
    }
    const video = document.querySelector('video');
    if (video && video.paused) {
      video.play().catch(() => {});
      return 'video.play()';
    }
    return 'not needed';
  });
  logTS(`USA Network play: ${playResult}`);

  if (playResult === 'btn-clicked' || playResult === 'video.play()') {
    await delay(1000); // let playback start before going fullscreen
  }

  // Move mouse to center to reveal player controls (move only — no click to avoid pausing)
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(500);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Click fullscreen button (Video.js standard control)
  const fullscreenResult = await page.evaluate(() => {
    const btn = document.querySelector('button.vjs-fullscreen-control');
    if (btn) {
      btn.click();
      return 'clicked';
    }
    return 'not found';
  });
  logTS(`USA Network fullscreen status: ${fullscreenResult}`);

  // After entering fullscreen the player sometimes pauses — ensure playback is running
  if (fullscreenResult === 'clicked') {
    await delay(800);
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video && video.paused) video.play().catch(() => {});
    });
  }

  logTS("finished USA Network fullscreen setup");
}

async function fullScreenVideoTBS(page) {
  logTS("URL contains TBS, setting up fullscreen");

  // Wait for video element to have enough data to play (readyState >= 3)
  let videoReady = false;
  for (let i = 0; i < 10; i++) {
    try {
      videoReady = await page.evaluate(() => {
        const videos = document.querySelectorAll('video');
        for (const video of videos) {
          if (video.readyState >= 3) return true;
        }
        return false;
      });
      if (videoReady) {
        logTS("TBS video ready (readyState >= 3)");
        break;
      }
    } catch (e) {
      // Continue waiting
    }
    await delay(500);
  }

  if (!videoReady) {
    logTS("TBS video not ready after timeout, continuing anyway");
  }

  // Click the big play button if present (paused state)
  // <span class="tui-play tui-btn" role="button" aria-label="Play">
  const playResult = await page.evaluate(() => {
    const btn = document.querySelector('span.tui-play.tui-btn[aria-label="Play"]');
    if (btn && btn.offsetParent !== null) {
      btn.click();
      return 'clicked';
    }
    return 'not present';
  });
  logTS(`TBS play button: ${playResult}`);
  if (playResult === 'clicked') {
    await delay(1000); // let playback start before going fullscreen
  }

  // Move mouse to center of viewport to trigger player controls
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
    await page.mouse.click(centerX, centerY);
    await delay(500);
    await page.mouse.move(centerX, centerY - 100);
    await delay(300);
  } catch (e) {
    logTS("Could not move mouse to show controls: " + e.message);
  }

  // Handle unmute - check aria-label to determine mute state
  const result = await page.evaluate(() => {
    const results = { mute: 'not found' };

    const muteButton = document.querySelector('span.tui-volume__button.tui-btn');
    if (muteButton) {
      const label = muteButton.getAttribute('aria-label');
      if (label === 'Unmute') {
        muteButton.click();
        results.mute = 'was muted, clicked unmute';
      } else {
        results.mute = 'already unmuted';
      }
      const rect = muteButton.getBoundingClientRect();
      results.muteButtonRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }

    return results;
  });

  logTS(`TBS mute status: ${result.mute}`);

  // Set volume to max: hover over mute button to reveal volume bar, then click far right
  if (result.muteButtonRect) {
    const muteCenterX = result.muteButtonRect.x + result.muteButtonRect.width / 2;
    const muteCenterY = result.muteButtonRect.y + result.muteButtonRect.height / 2;
    await page.mouse.move(muteCenterX, muteCenterY);
    await delay(500);

    const volInfo = await page.evaluate(() => {
      const bar = document.querySelector('.tui-volume__bar');
      if (bar) {
        const rect = bar.getBoundingClientRect();
        const activeBar = document.querySelector('.tui-volume__active-bar');
        const currentWidth = activeBar ? activeBar.style.width : 'unknown';
        return { currentVolume: currentWidth, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      return null;
    });

    if (volInfo && volInfo.width > 0) {
      const clickX = volInfo.x + volInfo.width - 2;
      const clickY = volInfo.y + volInfo.height / 2;
      await page.mouse.click(clickX, clickY);
      logTS(`TBS volume: clicked bar at max position (was ${volInfo.currentVolume})`);
    } else {
      logTS(`TBS volume: volume bar not visible`);
    }
  } else {
    logTS(`TBS volume: mute button not found`);
  }

  // Move mouse away then click fullscreen
  try {
    const viewport = page.viewport();
    const centerX = viewport ? viewport.width / 2 : 640;
    const centerY = viewport ? viewport.height / 2 : 360;
    await page.mouse.move(centerX, centerY);
    await delay(300);
  } catch (e) {
    // Continue
  }

  const fullscreenResult = await page.evaluate(() => {
    const btn = document.querySelector('span.tui-fullscreen.tui-btn');
    if (btn) {
      btn.click();
      return 'clicked';
    }
    return 'not found';
  });

  logTS(`TBS fullscreen status: ${fullscreenResult}`);
  logTS("finished TBS fullscreen setup");
}

async function fullScreenVideoYouTube(page) {
  logTS("URL contains YouTube, setting up fullscreen");

  // Wait a bit for the page to settle
  await delay(2000);

  let frameHandle, videoHandle;

  // Find the video element
  videoSearch: for (let step = 0; step < Constants.FIND_VIDEO_RETRIES; step++) {
    try {
      const frames = await page.frames({ timeout: 1000 });
      for (const frame of frames) {
        try {
          videoHandle = await frame.waitForSelector('video', { timeout: 1000 });
        } catch (error) {
          // Continue searching
        }
        if (videoHandle) {
          frameHandle = frame;
          logTS('Found YouTube video frame');
          break videoSearch;
        }
      }
    } catch (error) {
      logTS('Error looking for YouTube video:', error.message);
      videoHandle = null;
    }
    await delay(Constants.FIND_VIDEO_WAIT * 1000);
  }

  if (videoHandle) {
    // Confirm video is actually playing
    for (let step = 0; step < Constants.PLAY_VIDEO_RETRIES; step++) {
      const currentTime = await GetProperty(videoHandle, 'currentTime');
      const readyState = await GetProperty(videoHandle, 'readyState');
      const paused = await GetProperty(videoHandle, 'paused');
      const ended = await GetProperty(videoHandle, 'ended');

      if (!!(currentTime > 0 && readyState > 2 && !paused && !ended)) break;

      logTS("Attempting to play YouTube video");
      // Try clicking the video to play
      try {
        await videoHandle.click();
      } catch (e) {
        // Try play command
        await frameHandle.evaluate((video) => {
          video.play();
        }, videoHandle);
      }
      await delay(Constants.PLAY_VIDEO_WAIT * 1000);
    }

    logTS("Going fullscreen and unmuting YouTube video");
    await frameHandle.evaluate((video) => {
      video.muted = false;
      video.removeAttribute('muted');
      video.style.cursor = 'none!important';
      video.requestFullscreen();
    }, videoHandle);

    // YouTube may pause video when going fullscreen, so explicitly play after fullscreen
    await delay(500); // Brief delay to let fullscreen transition start
    await frameHandle.evaluate((video) => {
      if (video.paused) {
        video.play().catch(err => console.log('Play after fullscreen failed:', err));
      }
    }, videoHandle);

    // Setup pause monitor to automatically resume if video gets paused
    await setupPauseMonitor(frameHandle, videoHandle, page);
  } else {
    logTS('Could not find YouTube video element');
  }

  // Hide cursor
  await hideCursor(page);

  logTS("YouTube fullscreen setup complete");
}

async function selectMaxClosedCaptions(page, ccOption) {
  logTS(`Selecting Max (HBO Max) subtitles: ${ccOption}`);
  try {
    // Move mouse to center to make player controls visible
    const viewport = page.viewport();
    const cx = Math.floor((viewport ? viewport.width : 1280) / 2);
    const cy = Math.floor((viewport ? viewport.height : 720) / 2);
    await page.mouse.move(cx, cy);
    await delay(500);

    // Click the CC/subtitle settings button
    const trackBtn = await page.waitForSelector('button[data-testid="player-ux-track-selector-button"]', { timeout: 5000 }).catch(() => null);
    if (!trackBtn) {
      logTS('Max CC: Track selector button not found, skipping');
      return false;
    }
    await trackBtn.click();
    await delay(500);

    // Click the matching track button by aria-label
    // "English" maps to "English CC"; "Off" is exact "Off"
    const clicked = await page.evaluate((ccOpt) => {
      const buttons = document.querySelectorAll('button[data-testid="player-ux-text-track-button"]');
      for (const btn of buttons) {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        if (ccOpt === 'Off' && label === 'off') {
          btn.click();
          return true;
        }
        if (ccOpt !== 'Off' && label.startsWith(ccOpt.toLowerCase())) {
          btn.click();
          return true;
        }
      }
      return false;
    }, ccOption);

    if (clicked) {
      logTS(`Max CC: Selected "${ccOption}"`);
    } else {
      logTS(`Max CC: Option "${ccOption}" not found in menu`);
    }

    // Close the menu via its dismiss button
    const dismissBtn = await page.$('button[data-testid="player-ux-track-dismiss-button"]');
    if (dismissBtn) await dismissBtn.click();
    await delay(200);
    await page.mouse.move(0, 0);
    return clicked;
  } catch (err) {
    logTS(`Max CC selection error (non-fatal): ${err.message}`);
    return false;
  }
}

async function selectMaxClosedCaptionsWithRetry(page, ccOption) {
  const maxAttempts = 6;
  const retryDelay = 30000; // 30s — covers typical pre-roll ad breaks

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logTS(`Max CC: Attempt ${attempt}/${maxAttempts} for "${ccOption}"`);
    const success = await selectMaxClosedCaptions(page, ccOption);
    if (success) return;

    if (attempt < maxAttempts) {
      logTS(`Max CC: Not available yet, retrying in 30s...`);
      await delay(retryDelay);
    }
  }
  logTS(`Max CC: Could not select after ${maxAttempts} attempts`);
}

async function fullScreenVideoMax(page, closedCaptions = '') {
  logTS("URL contains hbomax.com/max.com, setting up Max video");

  let frameHandle, videoHandle;
  try {
    frameHandle = page;
    videoHandle = await frameHandle.waitForSelector('video', { timeout: 15000 }).catch(() => null);

    if (videoHandle) {
      // Unmute and ensure playing
      await page.evaluate((video) => {
        video.muted = false;
        if (video.paused) video.play().catch(err => console.log('Play failed:', err));
      }, videoHandle);

      // Select closed captions BEFORE fullscreen (controls accessible in normal view)
      logTS(`Max CC param received: "${closedCaptions}"`);
      if (closedCaptions) {
        selectMaxClosedCaptionsWithRetry(page, closedCaptions)
          .catch(err => logTS(`Max CC background error: ${err.message}`));
      }

      // Go fullscreen via 'f' key (player handles it internally)
      logTS("Max: pressing F key for fullscreen");
      const vp = page.viewport();
      const cx = Math.floor((vp ? vp.width : 1280) / 2);
      const cy = Math.floor((vp ? vp.height : 720) / 2);
      await page.mouse.move(cx, cy);
      await delay(300);
      await page.keyboard.press('f');

      await setupPauseMonitor(frameHandle, videoHandle, page);
    } else {
      logTS('Could not find Max video element');
    }
  } catch (err) {
    logTS(`Max fullscreen setup error (non-fatal): ${err.message}`);
  }

  await hideCursor(page);
  await page.mouse.move(0, 0);
  logTS("Max fullscreen setup complete");
}

async function selectDisneyPlusClosedCaptions(page, ccOption) {
  logTS(`Selecting Disney+ subtitles: ${ccOption}`);
  try {
    // Move mouse to center to make player controls visible
    const viewport = page.viewport();
    const cx = Math.floor((viewport ? viewport.width : 1280) / 2);
    const cy = Math.floor((viewport ? viewport.height : 720) / 2);
    await page.mouse.move(cx, cy);
    await delay(500);

    // Click the Audio and subtitles settings button
    const settingsBtn = await page.waitForSelector('button[aria-label="Audio and subtitles menu"]', { timeout: 5000 }).catch(() => null);
    if (!settingsBtn) {
      logTS('Disney+ CC: Settings button not found, skipping');
      return false;
    }
    await settingsBtn.click();
    await delay(300);

    // Match by label text — value is just a track index and varies by content
    const clicked = await page.evaluate((ccOpt) => {
      const inputs = document.querySelectorAll('input[name="subtitleTrackPicker"]');
      for (const input of inputs) {
        // Check aria-label on input, or text of associated <label>
        const ariaLabel = input.getAttribute('aria-label') || '';
        const labelEl = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
        const labelText = labelEl ? labelEl.textContent : '';
        const text = (ariaLabel + ' ' + labelText).toLowerCase();

        if (ccOpt === 'Off' && (input.value === 'off' || text.includes('off') || text.includes('none'))) {
          input.click();
          return true;
        }
        if (ccOpt !== 'Off' && text.includes(ccOpt.toLowerCase())) {
          input.click();
          return true;
        }
      }
      return false;
    }, ccOption);

    if (clicked) {
      logTS(`Disney+ CC: Selected "${ccOption}"`);
    } else {
      logTS(`Disney+ CC: Option "${ccOption}" not found in menu`);
    }

    // Close the drawer using its dedicated close button
    const closeBtn = await page.$('button[aria-label="Press back on your remote to close the audio and subtitles menu."]');
    if (closeBtn) {
      await closeBtn.click();
    }
    await delay(200);

    // Move mouse to corner so player controls fade out
    await page.mouse.move(0, 0);
    return clicked;
  } catch (err) {
    logTS(`Disney+ CC selection error (non-fatal): ${err.message}`);
    return false;
  }
}

async function selectDisneyPlusClosedCaptionsWithRetry(page, ccOption) {
  const maxAttempts = 6;
  const retryDelay = 30000; // 30s — covers typical pre-roll ad breaks

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logTS(`Disney+ CC: Attempt ${attempt}/${maxAttempts} for "${ccOption}"`);
    const success = await selectDisneyPlusClosedCaptions(page, ccOption);
    if (success) return;

    if (attempt < maxAttempts) {
      logTS(`Disney+ CC: Not available yet, retrying in 30s...`);
      await delay(retryDelay);
    }
  }
  logTS(`Disney+ CC: Could not select after ${maxAttempts} attempts`);
}

async function fullScreenVideoDisneyPlus(page, closedCaptions = '') {
  logTS("URL contains disneyplus.com, setting up Disney+ video");

  let frameHandle, videoHandle;

  // Find the video element
  videoSearch: for (let step = 0; step < Constants.FIND_VIDEO_RETRIES; step++) {
    try {
      const frames = await page.frames({ timeout: 1000 });
      for (const frame of frames) {
        try {
          const videos = await frame.$$('video');
          if (videos.length > 1) {
            for (const video of videos) {
              const hasAudio = await frame.evaluate((v) => {
                return v.mozHasAudio || Boolean(v.webkitAudioDecodedByteCount) ||
                       Boolean(v.audioTracks && v.audioTracks.length);
              }, video);
              if (hasAudio) {
                videoHandle = video;
                frameHandle = frame;
                logTS('Found Disney+ video element with audio');
                break videoSearch;
              } else if (!videoHandle) {
                videoHandle = video;
                frameHandle = frame;
              }
            }
          } else if (videos.length === 1) {
            videoHandle = videos[0];
            frameHandle = frame;
            logTS('Found Disney+ video element');
            break videoSearch;
          }
        } catch (error) {
          // Continue searching
        }
      }
    } catch (error) {
      logTS('Error looking for Disney+ video:', error.message);
      videoHandle = null;
    }
    if (!videoHandle) {
      await delay(Constants.FIND_VIDEO_WAIT * 1000);
    }
  }

  if (videoHandle) {
    // Wait for video to be playing
    logTS("Waiting for Disney+ video to be ready");
    for (let step = 0; step < Constants.PLAY_VIDEO_RETRIES; step++) {
      const readyState = await GetProperty(videoHandle, 'readyState');
      const paused = await GetProperty(videoHandle, 'paused');
      if (readyState >= 3 && !paused) {
        logTS(`Disney+ video ready (readyState: ${readyState})`);
        break;
      }
      if (readyState >= 3 && paused) {
        await frameHandle.evaluate((v) => v.play().catch(() => {}), videoHandle);
      }
      await delay(1000);
    }

    // Unmute video
    await frameHandle.evaluate((video) => {
      video.muted = false;
      video.removeAttribute('muted');
    }, videoHandle);

    // Ensure video is playing
    await frameHandle.evaluate((video) => {
      if (video.paused) {
        video.play().catch(err => console.log('Play failed:', err));
      }
    }, videoHandle);

    // Select closed captions BEFORE fullscreen (controls accessible in normal view)
    logTS(`Disney+ CC param received: "${closedCaptions}"`);
    if (closedCaptions) {
      selectDisneyPlusClosedCaptionsWithRetry(page, closedCaptions)
        .catch(err => logTS(`Disney+ CC background error: ${err.message}`));
    }

    // Go fullscreen via the player's own fullscreen button
    logTS("Going fullscreen via Disney+ player fullscreen button");
    const viewport = page.viewport();
    const cx = Math.floor((viewport ? viewport.width : 1280) / 2);
    const cy = Math.floor((viewport ? viewport.height : 720) / 2);
    await page.mouse.move(cx, cy);
    await delay(500);

    logTS("Disney+: pressing F key for fullscreen");
    await page.keyboard.press('f');

    await setupPauseMonitor(frameHandle, videoHandle, page);
  } else {
    logTS('Could not find Disney+ video element');
  }

  await hideCursor(page);
  await page.mouse.move(0, 0);
  logTS("Disney+ fullscreen setup complete");
}

async function selectAmazonClosedCaptions(page, ccOption) {
  logTS(`Selecting Amazon Prime Video subtitles: ${ccOption}`);
  try {
    // Move mouse to center to make player controls visible
    const viewport = page.viewport();
    const cx = Math.floor((viewport ? viewport.width : 1280) / 2);
    const cy = Math.floor((viewport ? viewport.height : 720) / 2);
    await page.mouse.move(cx, cy);
    await delay(500);

    // Click the Subtitles and Audio menu button
    const menuBtn = await page.waitForSelector('button[aria-label="Subtitles and Audio Menu"]', { timeout: 5000 }).catch(() => null);
    if (!menuBtn) {
      logTS('Amazon CC: Subtitles menu button not found, skipping');
      return false;
    }
    await menuBtn.click();
    await delay(300);

    // Map option name to the aria-label Amazon uses in the player
    const ariaLabel = ccOption === 'English' ? 'English [CC]' : ccOption;

    // Click the matching subtitle radio input and verify it actually got checked
    // (during ad-to-content transitions the input may exist but not register the click)
    const clicked = await page.evaluate((label) => {
      const inputs = document.querySelectorAll('input[type="radio"][name="subtitle"]');
      for (const input of inputs) {
        if (input.getAttribute('aria-label') === label) {
          input.click();
          return input.checked; // false if transition prevented the selection from taking
        }
      }
      return false;
    }, ariaLabel);

    if (clicked) {
      logTS(`Amazon CC: Selected "${ariaLabel}"`);
    } else {
      logTS(`Amazon CC: Option "${ariaLabel}" not found or not checked (may be transitioning)`);
    }

    // Always close the menu — re-query fresh since original ref may be stale after retries
    // Avoid Escape key — in fullscreen it can trigger overlays or exit fullscreen
    const closeMenuBtn = await page.$('button[aria-label="Subtitles and Audio Menu"]');
    if (closeMenuBtn) {
      await closeMenuBtn.click();
    } else {
      logTS('Amazon CC: Close button not found, moving mouse away to auto-hide menu');
    }
    await delay(200);

    // Move mouse to top-left corner so player controls hide and nothing else is triggered
    await page.mouse.move(0, 0);
    return clicked;
  } catch (err) {
    logTS(`Amazon CC selection error (non-fatal): ${err.message}`);
    return false;
  }
}

async function selectAmazonClosedCaptionsWithRetry(page, ccOption) {
  const maxAttempts = 6;
  const retryDelay = 30000; // 30s — covers typical pre-roll ad breaks

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    logTS(`Amazon CC: Attempt ${attempt}/${maxAttempts} for "${ccOption}"`);
    const success = await selectAmazonClosedCaptions(page, ccOption);
    if (success) return;

    if (attempt < maxAttempts) {
      logTS(`Amazon CC: Not available yet, retrying in 30s...`);
      await delay(retryDelay);
    }
  }
  logTS(`Amazon CC: Could not select after ${maxAttempts} attempts`);
}

async function fullScreenVideoAmazon(page, closedCaptions = '') {
  logTS("URL contains amazon.com, setting up fullscreen for Amazon Prime Video");

  // Wait a bit for the Amazon player to initialize
  await delay(2000);

  let frameHandle, videoHandle;

  // Find the video element - Amazon typically has multiple video elements
  videoSearch: for (let step = 0; step < Constants.FIND_VIDEO_RETRIES; step++) {
    try {
      const frames = await page.frames({ timeout: 1000 });
      for (const frame of frames) {
        try {
          // Amazon uses video elements, find one with actual content
          const videos = await frame.$$('video');
          for (const video of videos) {
            const hasAudio = await frame.evaluate((v) => {
              return v.mozHasAudio || Boolean(v.webkitAudioDecodedByteCount) ||
                     Boolean(v.audioTracks && v.audioTracks.length);
            }, video);

            // Prefer video elements with audio
            if (hasAudio) {
              videoHandle = video;
              frameHandle = frame;
              logTS('Found Amazon Prime Video element with audio');
              break videoSearch;
            } else if (!videoHandle) {
              // Keep first video as fallback
              videoHandle = video;
              frameHandle = frame;
            }
          }
        } catch (error) {
          // Continue searching
        }
      }
    } catch (error) {
      logTS('Error looking for Amazon video:', error.message);
      videoHandle = null;
    }

    if (!videoHandle) {
      await delay(Constants.FIND_VIDEO_WAIT * 1000);
    }
  }

  if (videoHandle) {
    // Wait for video to be ready - Amazon autoplays so we don't need to click play
    logTS("Waiting for Amazon video to be ready (autoplay expected)");

    // Just wait for ready state, don't try to force play
    let isReady = false;
    for (let step = 0; step < Constants.PLAY_VIDEO_RETRIES && !isReady; step++) {
      const readyState = await GetProperty(videoHandle, 'readyState');
      const paused = await GetProperty(videoHandle, 'paused');

      // Ready state 3+ means we have enough data
      if (readyState >= 3) {
        logTS(`Amazon video ready (readyState: ${readyState}, paused: ${paused})`);
        isReady = true;
        break;
      }

      await delay(1000);
    }

    // Unmute video
    await frameHandle.evaluate((video) => {
      video.muted = false;
      video.removeAttribute('muted');
    }, videoHandle);

    // Ensure video is playing
    await frameHandle.evaluate((video) => {
      if (video.paused) {
        video.play().catch(err => console.log('Play failed:', err));
      }
    }, videoHandle);

    // Go fullscreen using the player's own fullscreen button
    logTS("Going fullscreen via Amazon player fullscreen button");
    const viewport = page.viewport();
    const cx = Math.floor((viewport ? viewport.width : 1280) / 2);
    const cy = Math.floor((viewport ? viewport.height : 720) / 2);
    await page.mouse.move(cx, cy);
    await delay(500);

    const fsBtn = await page.waitForSelector('button[aria-label="Fullscreen"]', { timeout: 5000 }).catch(() => null);
    if (fsBtn) {
      await fsBtn.click();
      logTS("Amazon: clicked player fullscreen button");
    } else {
      logTS("Amazon: fullscreen button not found, pressing F key");
      await page.keyboard.press('f');
    }

    // Wait for fullscreen transition and any ad-to-content transition to settle
    await delay(3000);

    // Select closed captions AFTER fullscreen so the transition doesn't reset them
    logTS(`Amazon CC param received: "${closedCaptions}"`);
    if (closedCaptions) {
      selectAmazonClosedCaptionsWithRetry(page, closedCaptions)
        .catch(err => logTS(`Amazon CC background error: ${err.message}`));
    }

    // Setup pause monitor with more aggressive checking for Amazon
    // Amazon's player sometimes pauses unexpectedly
    await setupPauseMonitor(frameHandle, videoHandle, page);

  } else {
    logTS('Could not find Amazon Prime Video element');
  }

  // Hide cursor then move mouse to corner so player controls fade out
  await hideCursor(page);
  await page.mouse.move(0, 0);

  logTS("Amazon Prime Video fullscreen setup complete");
}


function isValidLinuxPath(path) {
  try {
    return execSync(path)
  } catch (e) {
    return false
  }
}

function getExecutablePath() {
  if (process.env.CHROME_BIN) {
    return process.env.CHROME_BIN
  }

  if (process.platform === 'linux') {
    const validPath = Constants.CHROME_EXECUTABLE_DIRECTORIES[process.platform].find(isValidLinuxPath)
    if (validPath) {
      return execSync(validPath).toString().split('\n').shift()
    } else {
      return null
    }
  } else {
    return Constants.CHROME_EXECUTABLE_DIRECTORIES[process.platform].find(existsSync)
  }
}

function buildRecordingJson(name, duration, encoderChannel, episodeTitle, summary, seasonNumber, episodeNumber, imageUrl) {
  const startTime = Math.round(Date.now() / 1000) + 3;

  const data = {
    "Name": name,
    "Time": startTime,
    "Duration": duration * 60,
    "Channels": [encoderChannel],  // Use the specific encoder's channel
    "Airing": {
      "Source": "manual",
      "Channel": encoderChannel,  // Use the specific encoder's channel
      "Time": startTime,
      "Duration": duration * 60,
      "Title": name,
      "EpisodeTitle": episodeTitle || name,
      "Summary": summary || `Manual recording: ${name}`,
      "Image": imageUrl || "https://tmsimg.fancybits.co/assets/p9467679_st_h6_aa.jpg",
      "SeriesID": "MANUAL",
      "ProgramID": `MAN${startTime}`,
    }
  }

  // Add SeasonNumber and EpisodeNumber only if provided (must be integers)
  if (seasonNumber && seasonNumber.trim() !== '') {
    const seasonNum = parseInt(seasonNumber.trim());
    if (!isNaN(seasonNum) && seasonNum > 0) {
      data.Airing.SeasonNumber = seasonNum;
    }
  }
  if (episodeNumber && episodeNumber.trim() !== '') {
    const episodeNum = parseInt(episodeNumber.trim());
    if (!isNaN(episodeNum) && episodeNum > 0) {
      data.Airing.EpisodeNumber = episodeNum;
    }
  }

  return JSON.stringify(data)
}

async function startRecording(name, duration, encoderChannel, episodeTitle, summary, seasonNumber, episodeNumber, imageUrl) {
  let response
  try {
    response = await fetch(Constants.CHANNELS_POST_URL, {
      method: 'POST',
      headers: {
        'Content-type': 'application/json',
      },
      body: buildRecordingJson(name, duration, encoderChannel, episodeTitle, summary, seasonNumber, episodeNumber, imageUrl),
    })
  } catch (error) {
    console.log('Unable to schedule recording', error)
  } finally {
    return response.ok
  }
}

// returns updated url with all paramas in a string
function getFullUrl (req) {
  if (!req || !req.query || !req.query.url) {
    console.log('must specify a target URL')
    return null
  }
  //Create URL object to validate and format the URL
  const urlObj = new URL(req.query.url);
  
  // Add any additional query parameters (exclude CH4C routing params that shouldn't go to the target site)
  const internalParams = new Set(['url', 'encoder']);
  Object.entries(req.query).forEach(([key, value]) => {
    if (!internalParams.has(key)) {
      urlObj.searchParams.append(key, value);
    }
  });
  
  // Get the fully formatted URL
  return urlObj.toString();
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error.code === 'ECONNRESET' && retries < maxRetries - 1) {
        const delay = Math.pow(2, retries) * 1000; // Exponential backoff
        logTS(`Connection reset, retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
}

/**
 * Get all local network IP addresses
 */
function getLocalNetworkIPs() {
  const ips = [];
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (!iface.internal && iface.family === 'IPv4') {
        ips.push(iface.address);
      }
    }
  }

  return ips;
}

/**
 * Generate self-signed SSL certificate for HTTPS support
 */
async function generateSelfSignedCert(certPath, keyPath, additionalHostnames = []) {
  try {
    logTS('Generating self-signed SSL certificate...');

    // Build list of hostnames/IPs for Subject Alternative Names
    const altNames = [
      { type: 2, value: 'localhost' },  // DNS name
      { type: 7, ip: '127.0.0.1' },     // Loopback IPv4
      { type: 7, ip: '0.0.0.0' }        // All interfaces
    ];

    // Log default entries
    logTS('  Including default hostname: localhost');
    logTS('  Including default IP: 127.0.0.1');
    logTS('  Including default IP: 0.0.0.0');

    // Add auto-detected local network IPs
    const localIPs = getLocalNetworkIPs();
    for (const ip of localIPs) {
      altNames.push({ type: 7, ip: ip });
      logTS(`  Including auto-detected IP: ${ip}`);
    }

    // Add user-specified hostnames/IPs
    for (const hostname of additionalHostnames) {
      // Check if it's an IP address or hostname
      const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname);
      if (isIP) {
        altNames.push({ type: 7, ip: hostname });
        logTS(`  Including additional IP: ${hostname}`);
      } else {
        altNames.push({ type: 2, value: hostname });
        logTS(`  Including additional hostname: ${hostname}`);
      }
    }

    // Generate self-signed certificate (valid for 10 years)
    const attrs = [
      { name: 'commonName', value: 'CH4C Local Server' },
      { name: 'countryName', value: 'US' },
      { name: 'organizationName', value: 'CH4C' }
    ];

    const pems = await selfsigned.generate(attrs, {
      keySize: 2048,
      days: 3650, // 10 years
      algorithm: 'sha256',
      extensions: [
        {
          name: 'basicConstraints',
          cA: true
        },
        {
          name: 'keyUsage',
          keyCertSign: true,
          digitalSignature: true,
          nonRepudiation: true,
          keyEncipherment: true,
          dataEncipherment: true
        },
        {
          name: 'subjectAltName',
          altNames: altNames
        }
      ]
    });

    // Write files
    if (!pems.private || !pems.cert) {
      logTS('ERROR: Failed to generate SSL certificate: selfsigned library returned invalid data');
      return false;
    }

    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);

    logTS(`✓ SSL certificate generated successfully`);
    logTS('');

    return true;
  } catch (error) {
    logTS(`ERROR: Failed to generate SSL certificate: ${error.message}`);
    return false;
  }
}

/**
 * Check for and load SSL certificates if they exist
 */
async function loadSSLCertificates(dataDir, additionalHostnames = []) {
  const certPath = path.join(dataDir, 'cert.pem');
  const keyPath = path.join(dataDir, 'key.pem');

  // Check if both files exist
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    // Auto-generate if missing
    logTS('SSL certificates not found, generating...');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const success = await generateSelfSignedCert(certPath, keyPath, additionalHostnames);
    if (!success) {
      return null;
    }
  }

  // Load certificates
  try {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    return { cert, key, certPath, keyPath };
  } catch (error) {
    logTS(`Warning: Could not load SSL certificates: ${error.message}`);
    return null;
  }
}

// Modified main() function with enhanced error handling
async function main() {
  // Check if Constants was properly initialized (will be empty if --help or yargs error)
  if (!Constants.CH4C_PORT) {
    // Constants module exited early (help/error), so don't start the server
    return;
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Serve noVNC static files for remote access feature
  app.use('/novnc', express.static(path.join(__dirname, 'novnc')));

  // Check for admin mode FIRST, before any other initialization
  if (isRunningAsAdmin()) {
    const errorMsg = `
+----------------------------------------------------------------------+
|                   ADMINISTRATOR MODE DETECTED                        |
+----------------------------------------------------------------------+
| CH4C is running with Administrator privileges.                       |
| This will cause Chrome browser launch to fail.                       |
|                                                                      |
| Please restart CH4C as a regular user (not as Administrator).        |
+----------------------------------------------------------------------+
`;
    console.error(errorMsg);
    logTS('Exiting due to Administrator mode...');
    process.exit(1);
  }

  // Initialize error handling systems
  const healthMonitor = new EncoderHealthMonitor();
  const browserHealthMonitor = new BrowserHealthMonitor(Constants.BROWSER_HEALTH_INTERVAL);
  const recoveryManager = new BrowserRecoveryManager();
  const streamMonitor = new StreamMonitor();

  // Store in app locals for access in routes
  app.locals.config = Constants;
  app.locals.healthMonitor = healthMonitor;
  app.locals.browserHealthMonitor = browserHealthMonitor;
  app.locals.recoveryManager = recoveryManager;
  app.locals.streamMonitor = streamMonitor;

  // Chrome setup (existing code)
  chromeDataDir = Constants.CHROME_USERDATA_DIRECTORIES[process.platform].find(existsSync);
  if (!chromeDataDir) {
    console.log('cannot find Chrome User Data Directory');
    return;
  }
  chromePath = getExecutablePath();
  if (!chromePath) {
    console.log('cannot find Chrome Executable Directory');
    return;
  }

   // CHECK 1: Check if the port is already in use - try both methods
  logTS(`Checking if port ${Constants.CH4C_PORT} is available...`);
  
  // Try socket-based check first
  let portInUse = await isPortInUse(Constants.CH4C_PORT);
  
  // Double-check with netstat on Windows
  if (!portInUse && process.platform === 'win32') {
    portInUse = await isPortInUseNetstat(Constants.CH4C_PORT);
  }
  
  if (portInUse) {
    const processInfo = await findProcessUsingPort(Constants.CH4C_PORT);
    
    console.error(`
+----------------------------------------------------------------------+
|                      PORT ALREADY IN USE                             |
+----------------------------------------------------------------------+
|                                                                      |
|  Port ${String(Constants.CH4C_PORT).padEnd(5)} is already being used by another process.                |
${processInfo ?
`|  Process: ${processInfo.name.padEnd(58)} |
|  PID: ${String(processInfo.pid).padEnd(62)} |` :
`|  Could not determine which process is using the port.               |`}
|                                                                      |
|  This usually means CH4C is already running.                         |
|                                                                      |
|  SOLUTIONS:                                                          |
|  1. Stop the other CH4C instance                                     |
|  2. Use a different port with -c option (e.g., -c 2443)              |
${processInfo && processInfo.pid !== 'Unknown' ?
`|  3. Force stop: taskkill /F /PID ${String(processInfo.pid).padEnd(35)} |` :
`|  3. Check Task Manager for Node.js or CH4C processes                 |`}
|                                                                      |
+----------------------------------------------------------------------+
`);
    process.exit(1);
  }

  // CHECK 2: Check for actually running Chrome processes first
  logTS('Checking for Chrome processes using encoder profiles...');
  const runningProfiles = await checkForRunningChromeWithProfiles();

  if (runningProfiles.length > 0) {
    console.error(`
+----------------------------------------------------------------------+
|              CHROME IS USING ENCODER PROFILES                        |
+----------------------------------------------------------------------+
|                                                                      |
|  Active Chrome processes are using these encoder profiles:           |`);

    runningProfiles.forEach((profile, index) => {
      console.error(`|  ${(index + 1)}. ${profile.encoder.padEnd(62)} |`);
    });

    console.error(`|                                                                      |
|  SOLUTIONS:                                                          |
|  1. Close all Chrome windows                                         |
|  2. Force close Chrome: taskkill /F /IM chrome.exe                   |
|  3. Check Task Manager for chrome.exe processes                      |
|                                                                      |
+----------------------------------------------------------------------+
`);
    process.exit(1);
  }

  // CHECK 3: Test if Chrome profiles are actually available
  logTS('Testing Chrome profile availability...');
  const profileProblems = [];
  const staleProfiles = [];
  
  for (let i = 0; i < Constants.ENCODERS.length; i++) {
    const encoder = Constants.ENCODERS[i];
    const profileDir = path.join(chromeDataDir, `encoder_${i}`);
    
    // First, ensure the directory exists
    if (!fs.existsSync(profileDir)) {
      fs.mkdirSync(profileDir, { recursive: true });
      logTS(`Created profile directory: ${profileDir}`);
    }
    
    // Test if we can actually launch Chrome with this profile
    const testResult = await testChromeLaunch(profileDir, chromePath);
    if (!testResult.success) {
      if (testResult.actuallyRunning) {
        profileProblems.push({
          encoder: encoder.url,
          profileDir,
          reason: testResult.reason
        });
      } else {
        // Just stale locks or corruption, we already tried to clean
        staleProfiles.push({
          encoder: encoder.url,
          profileDir,
          reason: testResult.reason
        });
      }
    } else {
      logTS(`✓ Profile available for ${encoder.url}`);
    }
  }
  
  // Only show error if there are real problems (actual Chrome processes)
  if (profileProblems.length > 0) {
    console.error(`
+----------------------------------------------------------------------+
|                   CHROME PROFILES IN USE                             |
+----------------------------------------------------------------------+
|                                                                      |
|  Chrome is actively using these encoder profiles:                    |`);

    profileProblems.forEach((issue, index) => {
      console.error(`|  ${(index + 1)}. ${issue.encoder.padEnd(62)} |`);
    });

    console.error(`|                                                                      |
|  SOLUTIONS:                                                          |
|  1. Close all Chrome windows                                         |
|  2. Force close Chrome: taskkill /F /IM chrome.exe                   |
|  3. Check Task Manager for chrome.exe processes                      |
|                                                                      |
+----------------------------------------------------------------------+
`);
    process.exit(1);
  }
  
  // For stale profiles, just log a warning but continue
  if (staleProfiles.length > 0) {
    logTS('Note: Some profiles had stale locks that were cleaned automatically.');
    staleProfiles.forEach(profile => {
      logTS(`  - ${profile.encoder}: ${profile.reason}`);
    });
  }

  logTS('Port and Chrome profiles are available. Starting CH4C...');

  const cleanupManager = createCleanupManager();
  app.locals.cleanupManager = cleanupManager;

  global.cleanupManager = cleanupManager;
  global.recoveryManager = recoveryManager;
  global.browserHealthMonitor = browserHealthMonitor;
  global.setupBrowserCrashHandlers = setupBrowserCrashHandlers;
  global.streamMonitor = streamMonitor;
  global.Constants = Constants;
  global.navigateSlingLikeHuman = navigateSlingLikeHuman;
  global.setupBrowserAudio = setupBrowserAudio;
  global.handleSiteSpecificFullscreen = handleSiteSpecificFullscreen;

  // Start health monitoring
  await healthMonitor.startMonitoring(Constants.ENCODERS);
  streamMonitor.startPeriodicCheck();

  // Initialize browser pool with validation
  const initResults = await initializeBrowserPoolWithValidation(
  Constants,        // Add Constants parameter
  healthMonitor,
  recoveryManager,
  launchBrowser,    // Add launchBrowser function parameter
  browsers          // Add browsers Map parameter
  );

  // Check if we have at least one working encoder (only if encoders were configured)
  const workingEncoders = initResults.filter(r => r.success);
  if (Constants.ENCODERS.length > 0 && workingEncoders.length === 0) {
    logTS('FATAL: No encoders could be initialized. Exiting.');
    process.exit(1);
  }
  if (Constants.ENCODERS.length === 0) {
    logTS('No encoders configured. Add encoders via Settings to start streaming.');
  }

  // Start browser health monitoring after browsers are initialized
  await browserHealthMonitor.startMonitoring(browsers, {
    recoveryManager: recoveryManager,
    launchBrowserFunc: launchBrowser,
    Constants: Constants,
    encoders: Constants.ENCODERS
  });

  // Initialize M3U Manager
  const { StreamingM3UManager } = require('./streaming-m3u-manager');
  const { SlingService } = require('./services/sling-service');
  const { CustomService } = require('./services/custom-service');

  const m3uManager = new StreamingM3UManager();

  // Initialize async operations (ensure directory exists and load data)
  await m3uManager.initialize();

  m3uManager.registerService('sling', new SlingService(browsers, Constants));
  m3uManager.registerService('custom', new CustomService());
  logTS('[M3U Manager] Initialized with Sling and Custom services');

  // Auto-create custom channels for each encoder
  await createEncoderChannels(m3uManager);

  /**
   * Create custom M3U channels for configured encoders
   */
  async function createEncoderChannels(manager) {
    try {
      const existingChannels = manager.getAllChannels();

      for (let i = 0; i < Constants.ENCODERS.length; i++) {
        const encoder = Constants.ENCODERS[i];
        const channelId = `encoder-${i}`;

        // Check if this encoder channel already exists
        const existingChannel = existingChannels.find(ch => ch.id === channelId);

        if (!existingChannel) {
          // Create new encoder channel
          // Use audio device name if available, otherwise use generic name
          const encoderName = encoder.audioDevice || `Encoder ${i + 1}`;
          const encoderCallSign = encoder.audioDevice || `ENC${i + 1}`;

          const channelData = {
            id: channelId,
            name: encoderName,
            streamUrl: encoder.url,
            channelNumber: encoder.channel || null, // Use encoder's configured channel number
            stationId: null,
            duration: 60, // Default 60 minutes placeholder
            category: 'Other',
            logo: 'https://tmsimg.fancybits.co/assets/s73245_ll_h15_ac.png?w=360&h=270',
            callSign: encoderCallSign
          };

          // Manually create the channel with fixed ID
          const channel = {
            ...channelData,
            service: 'custom',
            enabled: true,
            createdAt: new Date().toISOString()
          };

          const enriched = await manager.enrichChannel(channel);
          manager.channels.push(enriched);

          logTS(`[M3U Manager] Auto-created encoder channel: ${enriched.name} (channel ${enriched.channelNumber})`);
        } else {
          // Update existing encoder channel to match current encoder config.
          // When encoders are deleted, indices shift, so we must sync all encoder-derived
          // fields (name, callSign, streamUrl, channelNumber) to reflect the encoder now at this index.
          const encoderName = encoder.audioDevice || `Encoder ${i + 1}`;
          const encoderCallSign = encoder.audioDevice || `ENC${i + 1}`;
          const channelIndex = manager.channels.findIndex(ch => ch.id === channelId);
          if (channelIndex !== -1) {
            manager.channels[channelIndex] = {
              ...manager.channels[channelIndex],
              name: encoderName,
              callSign: encoderCallSign,
              streamUrl: encoder.url,
              channelNumber: encoder.channel || manager.channels[channelIndex].channelNumber,
              updatedAt: new Date().toISOString()
            };
            logTS(`[M3U Manager] Synced encoder channel: ${encoderName} (channel ${manager.channels[channelIndex].channelNumber})`);
          }
        }
      }

      // Remove orphaned encoder channels (from encoders that were deleted)
      const orphaned = manager.channels.filter(ch => {
        if (!ch.id || !ch.id.startsWith('encoder-')) return false;
        const idx = parseInt(ch.id.replace('encoder-', ''), 10);
        return isNaN(idx) || idx >= Constants.ENCODERS.length;
      });
      for (const ch of orphaned) {
        const chIdx = manager.channels.findIndex(c => c.id === ch.id);
        if (chIdx !== -1) {
          manager.channels.splice(chIdx, 1);
          logTS(`[M3U Manager] Removed orphaned encoder channel: ${ch.name} (${ch.id})`);
        }
      }

      // Save all channels to disk
      if (Constants.ENCODERS.length > 0 || orphaned.length > 0) {
        manager.lastUpdate = new Date().toISOString();
        await manager.saveToDisk();
      }
    } catch (error) {
      logTS(`[M3U Manager] Error creating encoder channels: ${error.message}`);
    }
  }

  app.get('/', async (req, res) => {
    res.send(Constants.START_PAGE_HTML.replaceAll('<<host>>', req.get('host')))
  });

  // Modified /stream endpoint with enhanced error handling
  app.get('/stream', async (req, res) => {
    let page;
    let targetUrl;

    const cleanupManager = req.app.locals.cleanupManager;
    const healthMonitor = req.app.locals.healthMonitor;
    const browserHealthMonitor = req.app.locals.browserHealthMonitor;
    const streamMonitor = req.app.locals.streamMonitor;
    const recoveryManager = req.app.locals.recoveryManager;

    // Check if a specific encoder was requested
    const requestedEncoder = req.query.encoder;
    let availableEncoder;

    if (requestedEncoder) {
      // Use the specifically requested encoder if it's available
      availableEncoder = Constants.ENCODERS.find(encoder =>
        encoder.url === requestedEncoder &&
        browsers.has(encoder.url) &&
        cleanupManager.canStartBrowser(encoder.url) &&
        healthMonitor.isEncoderHealthy(encoder.url) &&
        browserHealthMonitor.isBrowserHealthy(encoder.url)
      );

      if (!availableEncoder) {
        logTS(`Requested encoder ${requestedEncoder} is not available, falling back to auto-select`);
      } else {
        logTS(`Using requested encoder: ${requestedEncoder}`);
      }
    }

    // If no specific encoder requested or requested encoder not available, auto-select
    if (!availableEncoder) {
      // Get the first available AND healthy encoder with healthy browser
      availableEncoder = Constants.ENCODERS.find(encoder =>
        browsers.has(encoder.url) &&
        cleanupManager.canStartBrowser(encoder.url) &&
        healthMonitor.isEncoderHealthy(encoder.url) &&
        browserHealthMonitor.isBrowserHealthy(encoder.url)
      );
    }

    if (!availableEncoder) {
      // Check if any encoders are currently recovering
      const recoveringEncoders = Constants.ENCODERS.filter(encoder =>
        cleanupManager.isRecoveryInProgress(encoder.url)
      );

      if (recoveringEncoders.length > 0) {
        logTS(`Found ${recoveringEncoders.length} encoder(s) recovering: ${recoveringEncoders.map(e => e.url).join(', ')}`);
        logTS('Waiting up to 15 seconds for recovery to complete...');

        // Wait and check periodically for encoder availability
        const maxWaitTime = 15000; // 15 seconds
        const checkInterval = 500; // Check every 500ms
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
          await delay(checkInterval);

          // Check if any encoder became available
          availableEncoder = Constants.ENCODERS.find(encoder =>
            browsers.has(encoder.url) &&
            cleanupManager.canStartBrowser(encoder.url) &&
            healthMonitor.isEncoderHealthy(encoder.url) &&
            browserHealthMonitor.isBrowserHealthy(encoder.url)
          );

          if (availableEncoder) {
            const waitedMs = Date.now() - startTime;
            logTS(`Encoder ${availableEncoder.url} became available after ${waitedMs}ms, proceeding with stream`);
            break; // Exit the wait loop and continue with the request
          }
        }

        if (!availableEncoder) {
          logTS('Recovery wait timeout - no encoders became available within 15 seconds');
        }
      }

      // If we found an encoder during the wait, skip the rest of this block
      if (!availableEncoder) {
        // Try to find any encoder that might be recoverable (unhealthy but not in recovery)
        const recoverableEncoder = Constants.ENCODERS.find(encoder =>
          !healthMonitor.isEncoderHealthy(encoder.url) &&
          cleanupManager.canStartBrowser(encoder.url)
        );

        if (recoverableEncoder) {
          logTS(`Attempting to recover encoder ${recoverableEncoder.url} for use`);
          const recovered = await recoveryManager.attemptBrowserRecovery(
            recoverableEncoder.url,
            recoverableEncoder,
            browsers,
            launchBrowser,
            Constants
          );

          if (recovered) {
            logTS(`Successfully recovered encoder ${recoverableEncoder.url}`);
            // Set as available and continue
            availableEncoder = recoverableEncoder;
          }
        }
      }

      // Final check - if still no encoder available, reject
      if (!availableEncoder) {
        logTS('No available or recoverable encoders, rejecting request');
        res.status(503).send('All encoders are currently unavailable. Please try again in a moment.');
        return;
      }
    }

    targetUrl = getFullUrl(req);
    const closedCaptions = req.query.cc || '';
    logTS(`[DEBUG] /stream endpoint - req.query.url: ${req.query.url}`);
    logTS(`[DEBUG] /stream endpoint - getFullUrl result: ${targetUrl}`);

    if (!targetUrl) {
      if (!res.headersSent) {
        res.status(400).send('must specify a target URL');
      }
      return;
    }

    logTS(`[${availableEncoder.url}] Selected encoder for streaming to ${targetUrl}`);
    logTS(`[${availableEncoder.url}] Browser exists: ${browsers.has(availableEncoder.url)}, Can start: ${cleanupManager.canStartBrowser(availableEncoder.url)}`);
    cleanupManager.setBrowserActive(availableEncoder.url);

    // Enhanced cleanup on stream close
    res.on('close', async err => {
      logTS('response stream closed for', availableEncoder.url);
      streamMonitor.stopMonitoring(availableEncoder.url);
      try {
        await cleanupManager.cleanup(availableEncoder.url, res);
      } catch (cleanupError) {
        logTS(`Cleanup error on stream close (non-fatal): ${cleanupError.message}`);
        logTS(`Cleanup error stack: ${cleanupError.stack}`);
      }
    }).on('error', (handlerError) => {
      // Catch any errors in the close handler itself to prevent uncaught promise rejections
      logTS(`Error in stream close handler (non-fatal): ${handlerError.message}`);
    });

    res.on('error', async err => {
      logTS('response stream error for', availableEncoder.url, err);
      streamMonitor.recordError(availableEncoder.url);
      streamMonitor.stopMonitoring(availableEncoder.url);
      try {
        await cleanupManager.cleanup(availableEncoder.url, res);
      } catch (cleanupError) {
        logTS(`Cleanup error on stream error (non-fatal): ${cleanupError.message}`);
      }
    });

    try {
      // Wrap browser operations in safe error handling
      await safeStreamOperation(async () => {
        const browser = browsers.get(availableEncoder.url);
        if (!browser || !browser.isConnected()) {
          logTS(`[${availableEncoder.url}] Browser not connected, cannot start stream`);
          throw new Error('Browser not connected');
        }

        logTS(`[${availableEncoder.url}] Getting browser page for streaming`);
        const pages = await browser.pages();
        page = pages.length > 0 ? pages[0] : await browser.newPage();

        if (!page) {
          logTS(`[${availableEncoder.url}] Failed to get browser page`);
          throw new Error('Failed to get browser page');
        }

        // Set browser window state with error handling
        // First restore from minimized, then set to fullscreen or maximized
        // Peacock works better with maximized browser (video will go fullscreen via player controls)
        try {
          const session = await page.createCDPSession();
          const {windowId} = await session.send('Browser.getWindowForTarget');

          // First restore to normal state (from minimized), preserving the correct monitor position
          await session.send('Browser.setWindowBounds', {
            windowId,
            bounds: {
              windowState: 'normal',
              left: availableEncoder.width,
              top: availableEncoder.height,
              width: 1280,
              height: 720
            }
          });
          await delay(100); // Brief delay to let window restore

          // Peacock works better with a maximized (not OS-fullscreen) browser window;
          // its player will handle fullscreen internally via the 'f' key.
          // All other sites use OS-level fullscreen.
          // Peacock, Amazon, and Disney+ use maximized so the player handles fullscreen internally via its own button
          const windowState = (targetUrl.includes('peacocktv.com') || targetUrl.includes('amazon.com') || targetUrl.includes('disneyplus.com') || targetUrl.includes('hbomax.com') || targetUrl.includes('max.com')) ? 'maximized' : 'fullscreen';
          await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState}});
          await session.detach();
          logTS(`[${availableEncoder.url}] Browser window restored and set to ${windowState} via CDP`);
        } catch (cdpError) {
          logTS(`CDP fullscreen error (non-fatal): ${cdpError.message}`);
        }

        // Navigate with timeout and retry logic
        const navigationTimeout = 30000;
        const maxNavRetries = 2;
        let navSuccess = false;

        // Special handling for Sling - use human-like navigation to avoid rate limiting
        if (targetUrl.includes("watch.sling.com")) {
          logTS(`[${availableEncoder.url}] Sling URL detected - using navigation flow`);

          try {
            // Use the navigation sequence with encoder context for logging
            navSuccess = await navigateSlingLikeHuman(page, targetUrl, availableEncoder.url);

            if (!navSuccess) {
              throw new Error("Failed to navigate to Sling channel using navigation flow");
            }

            logTS(`[${availableEncoder.url}] Successfully navigated to Sling channel: ${targetUrl}`);
          } catch (slingError) {
            logTS(`[${availableEncoder.url}] Sling navigation error: ${slingError.message}`);
            throw slingError;
          }
        } else if (targetUrl.includes("peacocktv.com")) {
          logTS(`[${availableEncoder.url}] Peacock URL detected - using bot mitigation navigation flow`);

          try {
            // Use the navigation sequence with encoder context for logging
            navSuccess = await navigatePeacockLikeHuman(page, targetUrl, availableEncoder.url);

            if (!navSuccess) {
              throw new Error("Failed to navigate to Peacock stream using navigation flow");
            }

            logTS(`[${availableEncoder.url}] Successfully navigated to Peacock stream: ${targetUrl}`);
          } catch (peacockError) {
            logTS(`[${availableEncoder.url}] Peacock navigation error: ${peacockError.message}`);
            throw peacockError;
          }
        } else {
          // Non-Sling navigation (existing logic)
          for (let navAttempt = 1; navAttempt <= maxNavRetries && !navSuccess; navAttempt++) {
            try {
              if (targetUrl.includes("photos.app.goo.gl")) {
                await page.goto(targetUrl, {
                  waitUntil: 'load',
                  timeout: navigationTimeout
                });
              } else {
                await page.goto(targetUrl, {
                  waitUntil: 'networkidle2',
                  timeout: navigationTimeout
                });
              }
              navSuccess = true;
              logTS(`Page navigated successfully to ${targetUrl}`);
            } catch (navError) {
              logTS(`Navigation attempt ${navAttempt} failed: ${navError.message}`);
              if (navAttempt < maxNavRetries) {
                await delay(3000);
              } else {
                throw navError;
              }
            }
          }
        }

        // Stream setup with connection validation
        if (!cleanupManager.getState().isClosing) {
          // Validate encoder connection before streaming
          const isValid = await validateEncoderConnection(availableEncoder.url, 2, 1000);
          if (!isValid) {
            throw new Error('Encoder connection validation failed');
          }

          const fetchResponse = await fetchWithRetry(availableEncoder.url, {
            timeout: 30000
          });

          if (!fetchResponse.ok) {
            throw new Error(`Encoder stream HTTP error: ${fetchResponse.status}`);
          }

          if (res && !res.headersSent) {
            const stream = Readable.from(fetchResponse.body);

            // Only start monitoring if this is a real stream consumer (not internal fetch from /instant tune)
            // Internal fetches from localhost won't consume the stream, so monitoring would show false inactivity
            const isRealConsumer = req.headers['user-agent'] && !req.headers['user-agent'].includes('node-fetch');
            if (isRealConsumer) {
              // Start monitoring now that encoder stream is established
              streamMonitor.startMonitoring(availableEncoder.url, targetUrl);

              // Update activity immediately when encoder connection is established
              // This prevents false "inactive" warnings during setupBrowserAudio which can take up to 60s
              streamMonitor.updateActivity(availableEncoder.url);

              // Monitor stream for activity
              stream.on('data', () => {
                streamMonitor.updateActivity(availableEncoder.url);
              });
            }

            stream.pipe(res, { end: true })
              .on('error', (error) => {
                logTS(`Stream pipe error: ${error.message}`);
                streamMonitor.recordError(availableEncoder.url);
                cleanupManager.cleanup(availableEncoder.url, res);
              });
          }

          // Setup audio and fullscreen AFTER starting encoder stream
          if (!targetUrl.includes("photos.app.goo.gl")) {
            await setupBrowserAudio(page, availableEncoder, targetUrl);
          }

          // Handle site-specific fullscreen (pass encoder config for audio re-application)
          await handleSiteSpecificFullscreen(targetUrl, page, availableEncoder, closedCaptions);
        }
      }, availableEncoder.url, async () => {
        // Fallback action - attempt recovery
        logTS(`Attempting recovery for ${availableEncoder.url}`);
        const recovered = await recoveryManager.attemptBrowserRecovery(
          availableEncoder.url,
          availableEncoder,
          browsers,
          launchBrowser,
          Constants
        );
        if (!recovered) {
          throw new Error('Recovery failed');
        }
      });

    } catch (error) {
      logTS(`Stream setup failed for ${availableEncoder.url}: ${error.message}`);
      streamMonitor.stopMonitoring(availableEncoder.url);

      if (!res.headersSent) {
        res.status(500).send(`Streaming error: ${error.message}`);
      }

      try {
        await cleanupManager.cleanup(availableEncoder.url, res);
      } catch (cleanupError) {
        logTS(`Cleanup error (non-fatal): ${cleanupError.message}`);
        // Don't crash the app if cleanup fails - log and continue
      }
    }
  });

  // Add health status endpoint
  app.get('/health', (req, res) => {
    const healthMonitor = req.app.locals.healthMonitor;
    const browserHealthMonitor = req.app.locals.browserHealthMonitor;
    const cleanupManager = req.app.locals.cleanupManager;
    const streamMonitor = req.app.locals.streamMonitor;

    const status = {
      encoders: Constants.ENCODERS.map(encoder => ({
        url: encoder.url,
        channel: encoder.channel,
        audioDevice: encoder.audioDevice,
        widthPos: encoder.width || 0,
        heightPos: encoder.height || 0,
        isHealthy: healthMonitor.isEncoderHealthy(encoder.url),
        isBrowserHealthy: browserHealthMonitor.isBrowserHealthy(encoder.url),
        hasBrowser: browsers.has(encoder.url),
        isAvailable: cleanupManager.canStartBrowser(encoder.url),
        healthStatus: healthMonitor.healthStatus.get(encoder.url),
        browserHealthStatus: browserHealthMonitor.getHealthStatus(encoder.url)
      })),
      activeStreams: Array.from(streamMonitor.activeStreams.entries()).map(([url, data]) => ({
        url,
        ...data,
        uptime: Date.now() - data.startTime
      })),
      cleanupState: cleanupManager.getState()
    };

    res.json(status);
  });

  app.get('/audio-devices', async (req, res) => {
    const audioManager = new AudioDeviceManager();
    const devices = await audioManager.getAudioDevices();
    res.json(devices);
  });

  // GET /displays - Get display/monitor configuration
  app.get('/displays', async (req, res) => {
    const displayManager = new DisplayManager();
    const displays = await displayManager.getDisplays();
    res.json(displays);
  });

  // GET /instant - Serve the instant recording form
  app.get('/instant', (req, res) => {
    const cleanupManager = req.app.locals.cleanupManager;
    const healthMonitor = req.app.locals.healthMonitor;
    const browserHealthMonitor = req.app.locals.browserHealthMonitor;
    const streamMonitor = req.app.locals.streamMonitor;

    // Get available encoders
    const availableEncoders = Constants.ENCODERS.filter(encoder =>
      browsers.has(encoder.url) &&
      cleanupManager.canStartBrowser(encoder.url) &&
      healthMonitor.isEncoderHealthy(encoder.url) &&
      browserHealthMonitor.isBrowserHealthy(encoder.url)
    );

    // Generate encoder options HTML
    let encoderOptions = '';
    availableEncoders.forEach(encoder => {
      encoderOptions += `<option value="${encoder.url}">Channel ${encoder.channel} - ${encoder.url}</option>\n`;
    });

    // Generate active streams HTML
    let activeStreamsHtml = '';
    const activeStreams = Array.from(streamMonitor.activeStreams.entries());

    if (activeStreams.length > 0) {
      activeStreamsHtml = `
        <div class="active-streams" id="active-streams-container">
          <h3>Active Streams</h3>
          <div class="stream-list">
      `;

      activeStreams.forEach(([encoderUrl, streamInfo]) => {
        const encoderIndex = Constants.ENCODERS.findIndex(e => e.url === encoderUrl);
        const encoder = Constants.ENCODERS[encoderIndex];
        const targetUrl = streamInfo.targetUrl || 'Unknown URL';
        const displayUrl = targetUrl.length > 50 ? targetUrl.substring(0, 50) + '...' : targetUrl;
        const duration = Math.floor((Date.now() - streamInfo.startTime) / 60000); // minutes

        activeStreamsHtml += `
          <div class="stream-item">
            <div class="stream-info">
              <strong>Channel ${encoder?.channel || '?'}</strong>
              <span class="stream-url" title="${targetUrl}">${displayUrl}</span>
              <span class="stream-duration">Running for ${duration} min</span>
            </div>
            <a href="/stop/${encoderIndex}" class="btn-stop" onclick="return confirm('Stop this stream?')">Stop</a>
          </div>
        `;
      });

      activeStreamsHtml += `
          </div>
          <div class="stream-actions">
            <a href="/stop" class="btn-stop-all" onclick="return confirm('Stop ALL active streams?')">Stop All Streams</a>
          </div>
        </div>
      `;
    } else {
      // Add empty container for JavaScript to populate when streams start
      activeStreamsHtml = `<div class="active-streams" id="active-streams-container" style="display: none;"></div>`;
    }

    const html = Constants.INSTANT_PAGE_HTML
      .replaceAll('<<host>>', req.get('host'))
      .replaceAll('<<encoder_options>>', encoderOptions)
      .replaceAll('<<active_streams>>', activeStreamsHtml);

    res.send(html);
  });

  // POST /instant - Handle instant recording or tuning
  app.post('/instant', async (req, res) => {
    const { recording_name, recording_url, recording_duration, button_record, button_tune, episode_title, recording_summary, season_number, episode_number, selected_encoder, recording_image, closed_captions } = req.body;

    // Check if client wants JSON response
    const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

    // Helper to send response (JSON or HTML)
    const sendResponse = (status, data) => {
      if (wantsJson) {
        res.status(status).json(data);
      } else {
        // Legacy HTML response for non-JS clients
        if (data.success) {
          res.redirect('/instant');
        } else {
          res.status(status).send(data.error || 'An error occurred');
        }
      }
    };

    // Validate URL
    if (!recording_url) {
      sendResponse(400, { success: false, error: 'URL is required' });
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(recording_url).toString();
    } catch (e) {
      sendResponse(400, { success: false, error: 'Invalid URL format' });
      return;
    }

    const cleanupManager = req.app.locals.cleanupManager;
    const healthMonitor = req.app.locals.healthMonitor;
    const browserHealthMonitor = req.app.locals.browserHealthMonitor;

    // If user selected a specific encoder, use it; otherwise auto-select
    let availableEncoder;
    if (selected_encoder) {
      // User selected a specific encoder - validate it's available
      availableEncoder = Constants.ENCODERS.find(encoder =>
        encoder.url === selected_encoder &&
        browsers.has(encoder.url) &&
        cleanupManager.canStartBrowser(encoder.url) &&
        healthMonitor.isEncoderHealthy(encoder.url) &&
        browserHealthMonitor.isBrowserHealthy(encoder.url)
      );

      if (!availableEncoder) {
        sendResponse(503, { success: false, error: 'Selected encoder is no longer available. Please refresh and try again.' });
        return;
      }
    } else {
      // Auto-select the first available AND healthy encoder with healthy browser
      availableEncoder = Constants.ENCODERS.find(encoder =>
        browsers.has(encoder.url) &&
        cleanupManager.canStartBrowser(encoder.url) &&
        healthMonitor.isEncoderHealthy(encoder.url) &&
        browserHealthMonitor.isBrowserHealthy(encoder.url)
      );
    }

    if (!availableEncoder) {
      // Check if any encoders are recovering and wait briefly
      const recoveringEncoders = Constants.ENCODERS.filter(encoder =>
        cleanupManager.isRecoveryInProgress(encoder.url)
      );

      if (recoveringEncoders.length > 0) {
        logTS(`Instant: Found ${recoveringEncoders.length} encoder(s) recovering, waiting up to 15 seconds...`);

        const maxWaitTime = 15000;
        const checkInterval = 500;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
          await delay(checkInterval);

          availableEncoder = Constants.ENCODERS.find(encoder =>
            browsers.has(encoder.url) &&
            cleanupManager.canStartBrowser(encoder.url) &&
            healthMonitor.isEncoderHealthy(encoder.url) &&
            browserHealthMonitor.isBrowserHealthy(encoder.url)
          );

          if (availableEncoder) {
            const waitedMs = Date.now() - startTime;
            logTS(`Instant: Encoder became available after ${waitedMs}ms`);
            break;
          }
        }
      }

      if (!availableEncoder) {
        sendResponse(503, { success: false, error: 'No encoders are currently available. Please try again later.' });
        return;
      }
    }

    // Get encoder index for stop button
    const encoderIndex = Constants.ENCODERS.findIndex(e => e.url === availableEncoder.url);

    if (button_record) {
      // Handle recording
      const duration = parseInt(recording_duration);
      if (isNaN(duration) || duration <= 0) {
        sendResponse(400, { success: false, error: 'Invalid duration. Must be a positive number.' });
        return;
      }

      const recordingName = recording_name || 'Instant Recording';

      logTS(`Starting instant recording: ${recordingName} for ${duration} minutes`);

      // Start the recording in Channels DVR
      const recordingStarted = await startRecording(recordingName, duration, availableEncoder.channel, episode_title, recording_summary, season_number, episode_number, recording_image);

      if (recordingStarted) {
        // Start monitoring for display purposes, but skip health checks since Channels DVR
        // handles the stream directly and our monitoring would show false inactivity
        const streamMonitor = req.app.locals.streamMonitor;
        streamMonitor.startMonitoring(availableEncoder.url, targetUrl, { skipHealthCheck: true });
        logTS(`Started stream monitoring for instant recording (health checks disabled)`);

        // Set a timer to stop the stream after the recording duration
        // Add 15 second buffer to ensure recording completes before stream stops
        const bufferSeconds = 15;
        const totalDurationMs = (duration * 60 + bufferSeconds) * 1000;
        logTS(`Setting timer to stop stream after ${duration} minutes (+ ${bufferSeconds}s buffer)`);
        setEncoderDurationTimer(availableEncoder.url, async () => {
          logTS(`Recording duration expired for ${recordingName}, stopping stream on ${availableEncoder.channel}...`);
          clearEncoderDurationTimer(availableEncoder.url);
          try {
            await cleanupManager.cleanup(availableEncoder.url, null);
          } catch (cleanupError) {
            logTS(`Cleanup error on recording timeout (non-fatal): ${cleanupError.message}`);
          }
        }, totalDurationMs);

        // Send success response
        sendResponse(200, {
          success: true,
          type: 'recording',
          channel: availableEncoder.channel,
          encoderIndex: encoderIndex,
          message: `${recordingName} - ${duration} minutes`,
          detail: `Recording on Channel ${availableEncoder.channel}. Will automatically stop after ${duration} minutes.`
        });

        // Start the stream in the background (don't wait for response)
        // Pass the encoder URL so the stream uses the same encoder that was selected for recording
        const streamUrl = `http://localhost:${Constants.CH4C_PORT}/stream?url=${encodeURIComponent(targetUrl)}&encoder=${encodeURIComponent(availableEncoder.url)}${closed_captions ? '&cc=' + encodeURIComponent(closed_captions) : ''}`;
        logTS(`[DEBUG] Initiating stream fetch to: ${streamUrl}`);
        logTS(`[DEBUG] Target URL being streamed: ${targetUrl}`);
        logTS(`[DEBUG] Using encoder: ${availableEncoder.url}`);
        fetch(streamUrl)
          .catch(err => logTS(`Stream fetch error (expected): ${err.message}`));
      } else {
        sendResponse(500, { success: false, error: 'Failed to start recording in Channels DVR' });
      }
    } else if (button_tune) {
      // Handle tuning (just navigate to the URL without recording)
      const duration = parseInt(recording_duration);

      // Start monitoring this stream (skip health checks since we're not consuming the stream directly)
      const streamMonitor = req.app.locals.streamMonitor;
      streamMonitor.startMonitoring(availableEncoder.url, targetUrl, { skipHealthCheck: true });

      // If duration is provided and valid, use it for auto-stop
      if (!isNaN(duration) && duration > 0) {
        logTS(`Tuning encoder ${availableEncoder.channel} to ${targetUrl} for ${duration} minutes`);

        // Set a timer to stop the stream after the specified duration
        setEncoderDurationTimer(availableEncoder.url, async () => {
          logTS(`Duration expired for tuned stream on ${availableEncoder.channel}, stopping...`);
          clearEncoderDurationTimer(availableEncoder.url);
          try {
            await cleanupManager.cleanup(availableEncoder.url, null);
          } catch (cleanupError) {
            logTS(`Cleanup error on tune timeout (non-fatal): ${cleanupError.message}`);
          }
        }, duration * 60 * 1000);

        // Send success response with duration
        sendResponse(200, {
          success: true,
          type: 'tune',
          channel: availableEncoder.channel,
          encoderIndex: encoderIndex,
          message: `Will automatically stop in ${duration} minutes`,
          detail: `Watch on Channel ${availableEncoder.channel} in Channels DVR`
        });
      } else {
        logTS(`Tuning encoder ${availableEncoder.channel} to ${targetUrl} (indefinitely)`);

        // Send success response without duration
        sendResponse(200, {
          success: true,
          type: 'tune',
          channel: availableEncoder.channel,
          encoderIndex: encoderIndex,
          message: 'Streaming until manually stopped',
          detail: `Watch on Channel ${availableEncoder.channel} in Channels DVR`
        });
      }

      // Start the stream in the background (don't wait for response)
      // Pass the encoder URL so the stream uses the same encoder that was selected for tuning
      fetch(`http://localhost:${Constants.CH4C_PORT}/stream?url=${encodeURIComponent(targetUrl)}&encoder=${encodeURIComponent(availableEncoder.url)}${closed_captions ? '&cc=' + encodeURIComponent(closed_captions) : ''}`)
        .catch(err => logTS(`Stream fetch error (expected): ${err.message}`));
    } else {
      sendResponse(400, { success: false, error: 'Invalid form submission' });
    }
  });

  // ===== M3U Manager Routes =====

  // GET /m3u-manager - Admin UI page
  app.get('/m3u-manager', (req, res) => {
    res.send(Constants.M3U_MANAGER_PAGE_HTML.replaceAll('<<host>>', req.get('host')));
  });

  // GET /m3u-manager/channels - Get all channels
  app.get('/m3u-manager/channels', (req, res) => {
    res.json(m3uManager.getAllChannels());
  });

  // GET /m3u-manager/channels/:service - Get channels from specific service
  app.get('/m3u-manager/channels/:service', (req, res) => {
    res.json(m3uManager.getChannelsByService(req.params.service));
  });

  // GET /m3u-manager/status - Get manager status
  app.get('/m3u-manager/status', (req, res) => {
    res.json(m3uManager.getStatus());
  });

  // GET /m3u-manager/search-stations - Search for stations by query
  app.get('/m3u-manager/search-stations', async (req, res) => {
    try {
      const query = req.query.q || req.query.query || '';
      const limit = parseInt(req.query.limit || '10', 10);
      const results = await m3uManager.searchStations(query, limit);
      res.json(results);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /m3u-manager/refresh/:service - Refresh specific service
  app.post('/m3u-manager/refresh/:service', async (req, res) => {
    try {
      const resetEdits = req.query.resetEdits === 'true';
      const favoritesOnly = req.query.favoritesOnly !== 'false'; // Default to true
      const result = await m3uManager.refreshService(req.params.service, resetEdits, favoritesOnly);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /m3u-manager/custom - Add custom channel
  app.post('/m3u-manager/custom', async (req, res) => {
    try {
      const channel = await m3uManager.addCustomChannel(req.body);
      res.json(channel);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // PUT /m3u-manager/channels/:id - Update channel
  app.put('/m3u-manager/channels/:id', async (req, res) => {
    try {
      const channel = await m3uManager.updateChannel(req.params.id, req.body);
      res.json(channel);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  // DELETE /m3u-manager/channels/:id - Delete channel
  app.delete('/m3u-manager/channels/:id', async (req, res) => {
    try {
      await m3uManager.deleteChannel(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  // PATCH /m3u-manager/channels/:id/toggle - Toggle channel enabled/disabled
  app.patch('/m3u-manager/channels/:id/toggle', async (req, res) => {
    try {
      const channel = await m3uManager.toggleChannel(req.params.id);
      res.json(channel);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  });

  // GET /m3u-manager/playlist.m3u - Generate M3U playlist
  app.get('/m3u-manager/playlist.m3u', (req, res) => {
    const host = req.get('host').split(':')[0]; // Get hostname without port
    const m3u = m3uManager.generateM3U(host);
    res.type('audio/x-mpegurl');
    res.setHeader('Content-Disposition', 'attachment; filename="streaming_channels.m3u"');
    res.send(m3u);
  });

  // GET /stop - Stop all active streams and return encoders to pool
  app.get('/stop', async (req, res) => {
    const cleanupManager = req.app.locals.cleanupManager;
    const streamMonitor = req.app.locals.streamMonitor;
    const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

    const activeStreams = Array.from(streamMonitor.activeStreams.keys());

    if (activeStreams.length === 0) {
      if (wantsJson) return res.json({ success: false, message: 'No active streams to stop.' });
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>CH4C - Stop Streams</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
            .message { padding: 20px; background: #f0f0f0; border-radius: 8px; text-align: center; }
            a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; }
            a:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="message">
            <h2>No Active Streams</h2>
            <p>There are currently no active streams to stop.</p>
            <a href="/instant">← Back to Instant</a>
          </div>
        </body>
        </html>
      `);
      return;
    }

    logTS(`Stopping ${activeStreams.length} active stream(s)...`);

    for (const encoderUrl of activeStreams) {
      clearEncoderDurationTimer(encoderUrl);
      try {
        await cleanupManager.cleanup(encoderUrl, null);
        logTS(`Stopped stream on ${encoderUrl}`);
      } catch (error) {
        logTS(`Error stopping stream on ${encoderUrl}: ${error.message}`);
      }
    }

    if (wantsJson) return res.json({ success: true, message: `All ${activeStreams.length} stream(s) stopped.` });
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>CH4C - Streams Stopped</title>
        <meta charset="UTF-8">
        <style>
          body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
          .message { padding: 20px; background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; text-align: center; }
          h2 { color: #155724; }
          a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; }
          a:hover { background: #5568d3; }
        </style>
      </head>
      <body>
        <div class="message">
          <h2>✓ Streams Stopped</h2>
          <p>All active streams have been stopped and encoders returned to the pool.</p>
          <a href="/instant">← Back to Instant</a>
        </div>
      </body>
      </html>
    `);
  });

  // GET /stop/:encoderIndex - Stop a specific encoder's stream
  app.get('/stop/:encoderIndex', async (req, res) => {
    const cleanupManager = req.app.locals.cleanupManager;
    const streamMonitor = req.app.locals.streamMonitor;
    const encoderIndex = parseInt(req.params.encoderIndex, 10);
    const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');

    // Determine where to redirect back to based on referer
    const referer = req.get('Referer') || '';
    const redirectUrl = referer.includes('/instant') ? '/instant' : '/';
    const backLinkText = referer.includes('/instant') ? '← Back to Instant' : '← Back to Home';

    // Validate encoder index
    if (isNaN(encoderIndex) || encoderIndex < 0 || encoderIndex >= Constants.ENCODERS.length) {
      if (wantsJson) return res.status(400).json({ success: false, message: `Invalid encoder index ${req.params.encoderIndex}.` });
      res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>CH4C - Invalid Encoder</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
            .message { padding: 20px; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 8px; text-align: center; }
            h2 { color: #dc2626; }
            a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; }
            a:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="message">
            <h2>Invalid Encoder</h2>
            <p>Encoder index ${req.params.encoderIndex} is not valid.</p>
            <a href="${redirectUrl}">${backLinkText}</a>
          </div>
        </body>
        </html>
      `);
      return;
    }

    const encoderConfig = Constants.ENCODERS[encoderIndex];
    const encoderUrl = encoderConfig.url;

    // Check if this encoder has an active stream
    if (!streamMonitor.activeStreams.has(encoderUrl)) {
      if (wantsJson) return res.json({ success: false, message: `No active stream on Channel ${encoderConfig.channel}.` });
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>CH4C - No Active Stream</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
            .message { padding: 20px; background: #f0f0f0; border-radius: 8px; text-align: center; }
            a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; }
            a:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="message">
            <h2>No Active Stream</h2>
            <p>Encoder ${encoderIndex + 1} (Channel ${encoderConfig.channel}) does not have an active stream.</p>
            <a href="${redirectUrl}">${backLinkText}</a>
          </div>
        </body>
        </html>
      `);
      return;
    }

    // Get stream info before stopping
    const streamInfo = streamMonitor.activeStreams.get(encoderUrl);
    const targetUrl = streamInfo?.targetUrl || 'Unknown URL';

    logTS(`Stopping stream on encoder ${encoderIndex} (${encoderUrl})...`);
    clearEncoderDurationTimer(encoderUrl);

    try {
      await cleanupManager.cleanup(encoderUrl, null);
      logTS(`Stopped stream on encoder ${encoderIndex} (${encoderUrl})`);

      if (wantsJson) return res.json({ success: true, message: `Stream on Channel ${encoderConfig.channel} stopped.` });
      res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>CH4C - Stream Stopped</title>
          <meta charset="UTF-8">
          <meta http-equiv="refresh" content="2;url=${redirectUrl}">
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
            .message { padding: 20px; background: #d4edda; border: 1px solid #c3e6cb; border-radius: 8px; text-align: center; }
            h2 { color: #155724; }
            .detail { color: #666; font-size: 14px; margin-top: 10px; word-break: break-all; }
            a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; }
            a:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="message">
            <h2>✓ Stream Stopped</h2>
            <p>Encoder ${encoderIndex + 1} (Channel ${encoderConfig.channel}) has been stopped.</p>
            <div class="detail">URL: ${targetUrl.substring(0, 80)}${targetUrl.length > 80 ? '...' : ''}</div>
            <p style="font-size: 12px; color: #888; margin-top: 15px;">Redirecting back in 2 seconds...</p>
            <a href="${redirectUrl}">${backLinkText}</a>
          </div>
        </body>
        </html>
      `);
    } catch (error) {
      logTS(`Error stopping stream on encoder ${encoderIndex}: ${error.message}`);
      if (wantsJson) return res.status(500).json({ success: false, message: `Error stopping stream: ${error.message}` });
      res.status(500).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>CH4C - Error</title>
          <meta charset="UTF-8">
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; }
            .message { padding: 20px; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 8px; text-align: center; }
            h2 { color: #dc2626; }
            a { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #667eea; color: white; text-decoration: none; border-radius: 6px; }
            a:hover { background: #5568d3; }
          </style>
        </head>
        <body>
          <div class="message">
            <h2>Error Stopping Stream</h2>
            <p>${error.message}</p>
            <a href="${redirectUrl}">${backLinkText}</a>
          </div>
        </body>
        </html>
      `);
    }
  });

  // VNC Remote Access page
  app.get('/remote-access', (req, res) => {
    res.send(Constants.REMOTE_ACCESS_PAGE_HTML);
  });

  // Logs page
  app.get('/logs', (req, res) => {
    res.send(Constants.LOGS_PAGE_HTML);
  });

  // Logs API endpoint
  app.get('/api/logs', (req, res) => {
    res.json({ logs: getLogBuffer() });
  });

  // Settings page (editable config UI)
  app.get('/settings', (req, res) => {
    res.send(Constants.SETTINGS_PAGE_HTML);
  });

  // Settings API endpoint - returns current config, metadata, defaults, and CLI overrides
  app.get('/api/settings', (req, res) => {
    res.json({
      values: {
        channelsUrl: Constants.CHANNELS_URL,
        channelsPort: Constants.CHANNELS_PORT,
        ch4cPort: Constants.CH4C_PORT,
        ch4cSslPort: Constants.CH4C_SSL_PORT || null,
        sslHostnames: Constants.SSL_HOSTNAMES || [],
        dataDir: Constants.DATA_DIR,
        enablePauseMonitor: Constants.ENABLE_PAUSE_MONITOR,
        pauseMonitorInterval: Constants.PAUSE_MONITOR_INTERVAL,
        browserHealthInterval: Constants.BROWSER_HEALTH_INTERVAL
      },
      encoders: Constants.ENCODERS,
      metadata: CONFIG_METADATA,
      encoderFields: ENCODER_FIELDS,
      defaults: getDefaults(),
      cliOverrides: Constants.CLI_OVERRIDES || {},
      configSource: Constants.USING_CONFIG_FILE ? 'file' : 'cli',
      configPath: Constants.CONFIG_FILE_PATH
    });
  });

  // Save settings - validate and write to config.json
  app.post('/api/settings', async (req, res) => {
    const { values, encoders } = req.body;

    // Validate settings
    const validation = validateAllSettings(values || {});
    if (!validation.valid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    // Validate encoders if provided
    if (encoders && Array.isArray(encoders)) {
      for (let i = 0; i < encoders.length; i++) {
        const encValidation = validateEncoder(encoders[i]);
        if (!encValidation.valid) {
          return res.status(400).json({
            success: false,
            errors: { [`encoder_${i}`]: encValidation.errors }
          });
        }
      }
      validation.parsed.encoders = encoders;
    }

    // Migrate data directory contents if dataDir changed
    const migratedFiles = [];
    const newDataDir = validation.parsed.dataDir;
    const oldDataDir = Constants.DATA_DIR;
    if (newDataDir && path.resolve(newDataDir) !== path.resolve(oldDataDir)) {
      try {
        // Ensure the new directory exists
        if (!fs.existsSync(newDataDir)) {
          fs.mkdirSync(newDataDir, { recursive: true });
          logTS(`Created new data directory: ${newDataDir}`);
        }

        // Migrate SSL certificates
        const filesToMigrate = ['cert.pem', 'key.pem'];
        for (const file of filesToMigrate) {
          const srcPath = path.join(oldDataDir, file);
          const destPath = path.join(newDataDir, file);
          if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
            migratedFiles.push(file);
            logTS(`Migrated ${file} from ${oldDataDir} to ${newDataDir}`);
          }
        }
      } catch (error) {
        logTS(`Warning: Failed to migrate data directory contents: ${error.message}`);
      }
    }

    // Save to config.json
    const result = saveConfig(Constants.CONFIG_FILE_PATH, validation.parsed);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    let message = 'Configuration saved. Restart CH4C for changes to take effect.';
    if (migratedFiles.length > 0) {
      message += ` Migrated ${migratedFiles.join(', ')} to new data directory.`;
    }

    // Pre-generate SSL certificates if SSL port is configured and certs don't exist yet
    const sslPort = validation.parsed.ch4cSslPort;
    const effectiveDataDir = newDataDir || oldDataDir;
    if (sslPort) {
      const certPath = path.join(effectiveDataDir, 'cert.pem');
      const keyPath = path.join(effectiveDataDir, 'key.pem');
      if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
        const sslHostnames = validation.parsed.sslHostnames || Constants.SSL_HOSTNAMES || [];
        const success = await generateSelfSignedCert(certPath, keyPath, sslHostnames);
        if (success) {
          message += ' SSL certificates generated.';
        } else {
          message += ' Warning: SSL certificate generation failed.';
        }
      }
    }

    res.json({
      success: true,
      message,
      configPath: Constants.CONFIG_FILE_PATH,
      migratedFiles
    });
  });

  // Graceful shutdown helper - closes all browsers and exits
  async function gracefulShutdown(label) {
    logTS(`Shutting down (${label})...`);

    for (const [encoderUrl, browser] of browsers) {
      try {
        await browser.close();
        logTS(`Closed browser for encoder: ${encoderUrl}`);
      } catch (e) {
        logTS(`Error closing browser for ${encoderUrl}: ${e.message}`);
      }
    }

    process.exit(0);
  }

  // Restart endpoint - graceful shutdown for service manager to restart
  app.post('/api/settings/restart', async (_req, res) => {
    logTS('Restart requested via settings UI');
    res.json({ success: true, message: 'Server is shutting down...' });
    setTimeout(() => gracefulShutdown('restart'), 500);
  });

  // Shutdown endpoint - graceful shutdown for service stop command
  app.post('/api/shutdown', async (_req, res) => {
    logTS('Shutdown requested via service stop command');
    res.json({ success: true, message: 'Server is shutting down...' });
    setTimeout(() => gracefulShutdown('service stop'), 500);
  });

  // Encoder CRUD endpoints
  app.get('/api/encoders', (req, res) => {
    res.json({ encoders: Constants.ENCODERS });
  });

  app.post('/api/encoders', (req, res) => {
    const encoder = req.body;
    const validation = validateEncoder(encoder);
    if (!validation.valid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    // Load current config, add encoder, save
    const configResult = loadConfig(Constants.CONFIG_FILE_PATH);
    const currentConfig = configResult.config;
    if (!currentConfig.encoders) {
      currentConfig.encoders = [];
    }
    currentConfig.encoders.push({
      url: encoder.url,
      channel: encoder.channel || '24.42',
      width: parseInt(encoder.width) || 0,
      height: parseInt(encoder.height) || 0,
      audioDevice: encoder.audioDevice || null
    });

    const result = saveConfig(Constants.CONFIG_FILE_PATH, currentConfig);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    // Update in-memory encoders so the settings UI reflects the change immediately
    Constants.ENCODERS = currentConfig.encoders.slice();

    res.json({ success: true, message: 'Encoder added. Restart to apply.' });
  });

  app.put('/api/encoders/:index', (req, res) => {
    const index = parseInt(req.params.index);
    const encoder = req.body;
    const validation = validateEncoder(encoder);
    if (!validation.valid) {
      return res.status(400).json({ success: false, errors: validation.errors });
    }

    const configResult = loadConfig(Constants.CONFIG_FILE_PATH);
    const currentConfig = configResult.config;
    if (!currentConfig.encoders || index < 0 || index >= currentConfig.encoders.length) {
      return res.status(404).json({ success: false, error: 'Encoder not found' });
    }

    currentConfig.encoders[index] = {
      url: encoder.url,
      channel: encoder.channel || '24.42',
      width: parseInt(encoder.width) || 0,
      height: parseInt(encoder.height) || 0,
      audioDevice: encoder.audioDevice || null
    };

    const result = saveConfig(Constants.CONFIG_FILE_PATH, currentConfig);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    // Update in-memory encoders so the settings UI reflects the change immediately
    Constants.ENCODERS = currentConfig.encoders.slice();

    res.json({ success: true, message: 'Encoder updated. Restart to apply.' });
  });

  app.delete('/api/encoders/:index', (req, res) => {
    const index = parseInt(req.params.index);

    const configResult = loadConfig(Constants.CONFIG_FILE_PATH);
    const currentConfig = configResult.config;
    if (!currentConfig.encoders || index < 0 || index >= currentConfig.encoders.length) {
      return res.status(404).json({ success: false, error: 'Encoder not found' });
    }

    currentConfig.encoders.splice(index, 1);

    const result = saveConfig(Constants.CONFIG_FILE_PATH, currentConfig);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    // Update in-memory encoders so the settings UI reflects the change immediately
    Constants.ENCODERS = currentConfig.encoders.slice();

    res.json({ success: true, message: 'Encoder removed. Restart to apply.' });
  });

  // Directory browser API - lists subdirectories for the data directory picker
  app.get('/api/directories', (req, res) => {
    const requestedPath = req.query.path;
    let dirPath;

    if (!requestedPath || requestedPath === '') {
      // Start from the current working directory
      dirPath = process.cwd();
    } else {
      dirPath = path.resolve(String(requestedPath));
    }

    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        return res.status(400).json({ error: 'Not a valid directory' });
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      // Get parent directory (unless we're at a root)
      const parentDir = path.dirname(dirPath);
      const hasParent = parentDir !== dirPath;

      res.json({
        current: dirPath,
        parent: hasParent ? parentDir : null,
        directories: dirs
      });
    } catch (error) {
      res.status(500).json({ error: 'Cannot read directory: ' + error.message });
    }
  });

  // Login Manager API
  app.get('/api/login/sites', (_req, res) => {
    res.json({ sites: LOGIN_SITES });
  });

  // Initialise credential store with the app's data directory
  credentialsStore.init(Constants.DATA_DIR);

  // GET  /api/login/credentials/:siteId — return saved credentials (decrypted), or 404
  app.get('/api/login/credentials/:siteId', (req, res) => {
    const creds = credentialsStore.getCredentials(req.params.siteId);
    if (!creds) return res.status(404).json({ saved: false });
    res.json({ saved: true, credentials: creds });
  });

  // POST /api/login/credentials/:siteId — encrypt and save credentials
  app.post('/api/login/credentials/:siteId', (req, res) => {
    const { siteId } = req.params;
    const { username, password, tveProviderName, tveProviderUsername, tveProviderPassword } = req.body;
    try {
      credentialsStore.saveCredentials(siteId, { username, password, tveProviderName, tveProviderUsername, tveProviderPassword });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // DELETE /api/login/credentials/:siteId — remove saved credentials
  app.delete('/api/login/credentials/:siteId', (req, res) => {
    try {
      credentialsStore.clearCredentials(req.params.siteId);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/login/start', async (req, res) => {
    const { siteId, username, password, tveProviderName, tveProviderUsername, tveProviderPassword } = req.body;
    if (!siteId) return res.status(400).json({ error: 'siteId is required' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendEvent = (data) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`); };

    try {
      await loginEncoders({
        siteId, username, password,
        tveProviderName, tveProviderUsername, tveProviderPassword,
        encoders: Constants.ENCODERS,
        browsers,
        activeStreams: streamMonitor.activeStreams,
        statusCallback: sendEvent
      });
    } catch (e) {
      sendEvent({ type: 'error', message: e.message });
    } finally {
      res.end();
    }
  });

  // Content Search API — uses an existing encoder browser to search a streaming service
  // and return the watch URL for the first matching result.
  app.post('/api/search-content', async (req, res) => {
    const { service, query, encoderUrl } = req.body;

    if (!service || !query) {
      return res.status(400).json({ success: false, error: 'Service and search query are required' });
    }

    // Find a browser instance to use — prefer the specified encoder, else any available
    // Note: browsers map stores the browser object directly (not wrapped in {browser, page})
    let browser;
    if (encoderUrl) {
      browser = browsers.get(encoderUrl);
    } else {
      for (const [, b] of browsers) {
        if (b) {
          browser = b;
          break;
        }
      }
    }

    if (!browser) {
      return res.status(503).json({ success: false, error: 'No browser instance available. Make sure at least one encoder is running.' });
    }

    let searchPage = null;
    try {
      searchPage = await browser.newPage();

      let result = null;
      if (service === 'prime_video') {
        result = await searchPrimeVideo(searchPage, query);
      } else if (service === 'peacock') {
        result = await searchPeacock(searchPage, query);
      } else if (service === 'disney_plus') {
        result = await searchDisneyPlus(searchPage, query);
      } else if (service === 'hbomax') {
        result = await searchMax(searchPage, query);
      } else {
        return res.status(400).json({ success: false, error: `Service "${service}" is not yet supported` });
      }

      if (result && result.url) {
        // Add buffer: 2 extra minutes per 10 minutes of content
        if (result.durationMinutes) {
          result.durationMinutes += Math.floor(result.durationMinutes / 10) * 2;
        }
        return res.json({ success: true, ...result });
      } else {
        return res.status(404).json({ success: false, error: 'No results found for your search' });
      }
    } catch (err) {
      logTS(`Content search error for "${query}" on ${service}: ${err.message}`);
      return res.status(500).json({ success: false, error: `Search failed: ${err.message}` });
    } finally {
      if (searchPage) {
        try { await searchPage.close(); } catch (e) { /* ignore */ }
      }
      // Minimize the browser window so it doesn't remain visible after search
      try {
        const pages = await browser.pages();
        const targetPage = pages.length > 0 ? pages[0] : null;
        if (targetPage) {
          const session = await targetPage.createCDPSession();
          const { windowId } = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
          await session.detach();
        }
      } catch (e) { logTS(`Could not minimize browser window after search: ${e.message}`); }
    }
  });

  // Serve SSL certificate for download
  app.get('/data/cert.pem', (req, res) => {
    const certPath = path.join(Constants.DATA_DIR, 'cert.pem');
    if (fs.existsSync(certPath)) {
      res.download(certPath, 'ch4c-certificate.pem');
    } else {
      res.status(404).send('Certificate not found. HTTPS must be enabled with --ch4c-ssl-port parameter.');
    }
  });

  // Load SSL certificates first if HTTPS is enabled (before starting servers)
  let httpsServer = null;
  let sslCerts = null;
  if (Constants.CH4C_SSL_PORT) {
    const dataDir = Constants.DATA_DIR;
    sslCerts = await loadSSLCertificates(dataDir, Constants.SSL_HOSTNAMES);

    if (!sslCerts) {
      logTS('Warning: HTTPS requested but certificate generation failed');
    }
  }

  // Create HTTP server (always)
  const server = app.listen(Constants.CH4C_PORT, () => {
    logTS('CH4C HTTP server listening on port', Constants.CH4C_PORT);
    // Only show URLs if HTTPS is not enabled (HTTPS server will show them)
    if (!Constants.CH4C_SSL_PORT) {
      logTS(`See status at http://localhost:${Constants.CH4C_PORT}/`);
      logTS(`Instant recording/tuning available at http://localhost:${Constants.CH4C_PORT}/instant`);
    }
    logTS(`Configure settings at http://localhost:${Constants.CH4C_PORT}/settings`);
  });

  // Handle HTTP server startup errors
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`\n❌ ERROR: Port ${Constants.CH4C_PORT} is already in use.`);
      console.error('Another instance of CH4C may already be running.\n');
    } else {
      console.error(`\n❌ ERROR: Failed to start HTTP server: ${error.message}\n`);
    }
    process.exit(1);
  });

  // Create HTTPS server if certificates were loaded successfully
  if (Constants.CH4C_SSL_PORT && sslCerts) {
    try {
      httpsServer = https.createServer({ key: sslCerts.key, cert: sslCerts.cert }, app);
      httpsServer.listen(Constants.CH4C_SSL_PORT, () => {
        logTS(`CH4C HTTPS server listening on port ${Constants.CH4C_SSL_PORT}`);
        logTS(`See status at https://localhost:${Constants.CH4C_SSL_PORT}/`);
        logTS(`Instant recording/tuning available at https://localhost:${Constants.CH4C_SSL_PORT}/instant`);
      });

      httpsServer.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
          logTS(`Warning: HTTPS port ${Constants.CH4C_SSL_PORT} already in use (HTTP still available on ${Constants.CH4C_PORT})`);
        } else {
          logTS(`Warning: Failed to start HTTPS server: ${error.message}`);
        }
      });
    } catch (error) {
      logTS(`Warning: Could not start HTTPS server: ${error.message}`);
    }
  }

  // WebSocket upgrade handler for VNC proxy
  const WebSocket = require('ws');
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = require('url');
    const pathname = url.parse(request.url).pathname;

    if (pathname.startsWith('/vnc-proxy')) {
      logTS('VNC WebSocket connection requested');

      wss.handleUpgrade(request, socket, head, (ws) => {
        // Default VNC server is 127.0.0.1:5900 (TightVNC default)
        // Using 127.0.0.1 instead of localhost for better TightVNC compatibility
        const vncHost = '127.0.0.1';

        // Get port from query parameter, default to 5900
        const urlParams = new URLSearchParams(request.url.split('?')[1]);
        const vncPort = parseInt(urlParams.get('port') || '5900', 10);

        logTS(`Connecting to VNC server at ${vncHost}:${vncPort}`);

        // Create TCP connection to VNC server
        const vncSocket = net.connect(vncPort, vncHost);
        let vncConnected = false;

        vncSocket.on('connect', () => {
          logTS('Connected to VNC server');
          vncConnected = true;
        });

        vncSocket.on('error', (error) => {
          logTS(`VNC connection error: ${error.message}`);
          if (!vncConnected) {
            // Send error to client before closing
            ws.send(JSON.stringify({
              error: `Cannot connect to VNC server: ${error.message}. Is TightVNC running?`
            }));
          }
          ws.close(1011, error.message);
        });

        // Proxy data from WebSocket to VNC server
        ws.on('message', (data) => {
          if (vncSocket.writable) {
            vncSocket.write(Buffer.from(data));
          }
        });

        // Proxy data from VNC server to WebSocket
        vncSocket.on('data', (data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data, { binary: true });
          }
        });

        // Handle cleanup
        ws.on('close', () => {
          logTS('VNC WebSocket closed');
          if (!vncSocket.destroyed) {
            vncSocket.end();
          }
        });

        vncSocket.on('close', () => {
          logTS('VNC server connection closed');
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'VNC connection closed');
          }
        });

        // Handle WebSocket errors
        ws.on('error', (error) => {
          logTS(`WebSocket error: ${error.message}`);
        });
      });
    } else {
      socket.destroy();
    }
  });

  // Add the same WebSocket upgrade handler for HTTPS server
  if (httpsServer) {
    httpsServer.on('upgrade', (request, socket, head) => {
      const url = require('url');
      const pathname = url.parse(request.url).pathname;

      if (pathname.startsWith('/vnc-proxy')) {
        wss.handleUpgrade(request, socket, head, (ws) => {
          const vncHost = '127.0.0.1';
          const urlParams = new URLSearchParams(request.url.split('?')[1]);
          const vncPort = parseInt(urlParams.get('port') || '5900', 10);

          logTS(`Connecting to VNC server at ${vncHost}:${vncPort} (HTTPS)`);

          const vncSocket = net.connect(vncPort, vncHost);
          let vncConnected = false;

          vncSocket.on('connect', () => {
            logTS('Connected to VNC server');
            vncConnected = true;
          });

          vncSocket.on('error', (error) => {
            logTS(`VNC connection error: ${error.message}`);
            if (!vncConnected) {
              ws.send(JSON.stringify({
                error: `Cannot connect to VNC server: ${error.message}. Is TightVNC running?`
              }));
            }
            ws.close(1011, error.message);
          });

          ws.on('message', (data) => {
            if (vncSocket.writable) {
              vncSocket.write(Buffer.from(data));
            }
          });

          vncSocket.on('data', (data) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(data, { binary: true });
            }
          });

          ws.on('close', () => {
            logTS('VNC WebSocket closed');
            if (!vncSocket.destroyed) {
              vncSocket.end();
            }
          });

          vncSocket.on('close', () => {
            logTS('VNC server connection closed');
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(1000, 'VNC connection closed');
            }
          });

          ws.on('error', (error) => {
            logTS(`WebSocket error: ${error.message}`);
          });
        });
      } else {
        socket.destroy();
      }
    });
  }

  // Graceful shutdown with cleanup
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

// Helper function to consolidate site-specific fullscreen logic
async function handleSiteSpecificFullscreen(targetUrl, page, encoderConfig = null, closedCaptions = '') {
  try {
    if (targetUrl.includes("youtube.com") || targetUrl.includes("youtu.be")) {
      logTS("Handling YouTube video");
      await fullScreenVideoYouTube(page);
    } else if (targetUrl.includes("amazon.com")) {
      logTS("Handling Amazon Prime Video");
      await fullScreenVideoAmazon(page, closedCaptions);
    } else if (targetUrl.includes("watch.sling.com")) {
      logTS("Handling Sling video");
      await fullScreenVideoSling(page, encoderConfig);
    } else if (targetUrl.includes("peacocktv.com")) {
      await fullScreenVideoPeacock(page, encoderConfig, closedCaptions);
    } else if (targetUrl.includes("spectrum.net")) {
      await fullScreenVideoSpectrum(page);
    } else if (targetUrl.includes("photos.app.goo.gl")) {
      logTS("Handling Google Photos");
      await fullScreenVideoGooglePhotos(page);
    } else if (targetUrl.includes("espn.com")) {
      logTS("Handling ESPN video");
      await fullScreenVideoESPN(page, encoderConfig);
    } else if (targetUrl.includes("disneyplus.com")) {
      logTS("Handling Disney+ video");
      await fullScreenVideoDisneyPlus(page, closedCaptions);
    } else if (targetUrl.includes("hbomax.com") || targetUrl.includes("max.com")) {
      logTS("Handling Max (HBO Max) video");
      await fullScreenVideoMax(page, closedCaptions);
    } else if (targetUrl.includes("disneynow.com")) {
      logTS("Handling DisneyNow video");
      await fullScreenVideoDisneyNow(page);
    } else if (targetUrl.includes("fxnow.fxnetworks.com") || targetUrl.includes("abc.com")) {
      logTS("Handling FXNow/ABC video");
      await fullScreenVideoFXNow(page);
    } else if (targetUrl.includes("nationalgeographic.com")) {
      logTS("Handling National Geographic video");
      await fullScreenVideoNatGeo(page);
    } else if (targetUrl.includes("tbs.com") || targetUrl.includes("tntdrama.com")) {
      logTS("Handling TBS/TNT video");
      await fullScreenVideoTBS(page);
    } else if (targetUrl.includes("usanetwork.com")) {
      logTS("Handling USA Network video");
      await fullScreenVideoUSA(page);
    } else if (targetUrl.includes("play.aetv.com") || targetUrl.includes("play.history.com")) {
      logTS("Handling AETV/History video");
      await fullScreenVideoAETV(page);
    } else if (targetUrl.includes("go.discovery.com")) {
      logTS("Handling Discovery video");
      await fullScreenVideoDiscovery(page);
    } else if (targetUrl.includes("cbs.com")) {
      logTS("Handling CBS video");
      await fullScreenVideoCBS(page);
    } else {
      logTS("Handling default video");
      await fullScreenVideo(page);
    }
  } catch (e) {
    logTS(`Fullscreen setup failed (non-fatal): ${e.message}`);
    // Don't throw - fullscreen failure shouldn't stop the stream
  }
}

// Only run the main function if this is the main module
if (require.main === module) {
  main().catch(async (err) => {
    console.error('Error starting server:', err);
    logTS(`FATAL: Startup error: ${err.message}`);
    await cleanupAllBrowsers();
    process.exit(1);
  });
}

module.exports = { main }; // Export for potential programmatic usage