const { BaseService } = require('./base-service');

/**
 * Sling TV Service
 * Fetches channel list from Sling TV guide using browser automation
 */
class SlingService extends BaseService {
  constructor(browsers, Constants) {
    super('sling');
    this.browsers = browsers; // Browser pool Map
    this.Constants = Constants;
  }

  /**
   * Fetch channels from Sling TV
   * Uses browser pool to navigate to Sling TV guide and extract channel data
   * @param {boolean} favoritesOnly - If true, scrape favorites; if false, scrape all channels
   */
  async fetchChannels(favoritesOnly = true) {
    console.log(`[SlingService] Fetching channels from Sling TV guide (${favoritesOnly ? 'Favorites only' : 'All channels'})`);

    // Get first available browser from pool
    const browserEntry = Array.from(this.browsers.entries())[0];
    if (!browserEntry) {
      console.error('[SlingService] No browser available in pool');
      return this.getFallbackChannels();
    }

    const [encoderUrl, browser] = browserEntry;

    if (!browser || !browser.isConnected()) {
      console.error('[SlingService] Browser not connected');
      return this.getFallbackChannels();
    }

    let page;
    try {
      console.log(`[SlingService] Using browser from encoder: ${encoderUrl}`);

      // Get or create page
      const pages = await browser.pages();
      page = pages.length > 0 ? pages[0] : await browser.newPage();

      if (!page) {
        console.error('[SlingService] Failed to get browser page');
        return this.getFallbackChannels();
      }

      // Navigate to Sling TV guide (favorites or all channels)
      const guideUrl = favoritesOnly
        ? 'https://watch.sling.com/dashboard/grid_guide/grid_guide_favorites'
        : 'https://watch.sling.com/dashboard/grid_guide/grid_guide_all';

      console.log(`[SlingService] Navigating to Sling TV guide: ${guideUrl}`);

      await page.goto(guideUrl, {
        waitUntil: 'networkidle2',
        timeout: 60000
      });

      // Wait for initial page load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Check if we were redirected or if we're on the right page
      const currentUrl = page.url();
      const pageTitle = await page.title();
      console.log(`[SlingService] Current URL after navigation: ${currentUrl}`);
      console.log(`[SlingService] Page title: ${pageTitle}`);

      if (!currentUrl.includes('watch.sling.com')) {
        console.warn(`[SlingService] Redirected away from Sling TV - possible auth issue. Current URL: ${currentUrl}`);
        return this.getFallbackChannels();
      }

      // Check if page indicates authentication is needed
      if (pageTitle.includes('Get Started') || pageTitle.includes('Sign In') || pageTitle.includes('Log In')) {
        console.warn(`[SlingService] Page title suggests authentication required: "${pageTitle}"`);
        console.warn('[SlingService] Browser session may have expired. Please re-login to Sling TV in the browser.');
        return this.getFallbackChannels();
      }

      // Wait for channel guide to load - try to wait for channel elements to appear
      console.log('[SlingService] Waiting for channel grid to render...');
      try {
        await page.waitForSelector('[data-testid^="channel-"]', { timeout: 10000 });
        console.log('[SlingService] Channel elements detected, proceeding with extraction...');
      } catch (waitError) {
        console.warn('[SlingService] Channel elements did not appear within 10 seconds');
        console.warn('[SlingService] This may indicate Sling TV has changed their page structure');
        // Continue anyway - we'll get detailed debug info from page.evaluate
      }

      // Additional wait for JavaScript to hydrate
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log('[SlingService] Extracting channel data from virtualized guide...');

      // Scroll through guide and collect unique channel names
      const scrollResult = await page.evaluate(async () => {
        const urlMap = new Map(); // Will be populated by extracting URLs from elements
        // Collect all unique channel names as we scroll
        const seenChannels = new Set();
        const channelData = [];

        // Find the scrollable container (guide-cell div)
        const firstChannel = document.querySelector('[data-testid^="channel-"]');
        if (!firstChannel) {
          // Debug: check what's on the page
          const bodyText = document.body.innerText.substring(0, 500);

          // Check for login/sign-in elements
          const hasLoginButton = !!(
            document.querySelector('[data-testid*="login"], [data-testid*="sign-in"]') ||
            Array.from(document.querySelectorAll('button, a')).find(el =>
              /sign[\s-]?in|log[\s-]?in/i.test(el.textContent)
            )
          );

          const url = window.location.href;
          const title = document.title;

          // Check for error messages or redirects
          const hasErrorMessage = !!document.querySelector('[class*="error"], [class*="alert"]');
          const errorText = hasErrorMessage ?
            Array.from(document.querySelectorAll('[class*="error"], [class*="alert"]'))
              .map(el => el.textContent.trim()).join(' | ').substring(0, 200) : '';

          return {
            success: false,
            reason: 'No channels found on page',
            channelCount: 0,
            debug: {
              url,
              title,
              bodyPreview: bodyText,
              hasLoginButton,
              hasErrorMessage,
              errorText,
              elementCount: document.querySelectorAll('[data-testid]').length,
              sampleTestIds: Array.from(document.querySelectorAll('[data-testid]')).slice(0, 10).map(el => el.getAttribute('data-testid')),
              allDataTestIdPrefixes: [...new Set(
                Array.from(document.querySelectorAll('[data-testid]'))
                  .map(el => el.getAttribute('data-testid').split('-')[0])
              )].slice(0, 20)
            }
          };
        }

        // Find all scrollable parent containers
        let scrollContainer = null;
        let element = firstChannel;
        let maxRatio = 0;

        while (element && element !== document.body) {
          element = element.parentElement;
          if (element && element.scrollHeight > element.clientHeight) {
            const ratio = element.scrollHeight / element.clientHeight;
            // Choose container with largest scroll ratio (most scrollable content)
            if (ratio > maxRatio) {
              maxRatio = ratio;
              scrollContainer = element;
            }
          }
        }

        if (!scrollContainer || scrollContainer === document.body) {
          return { success: false, reason: 'Could not find scrollable container', channelCount: 0 };
        }

        // Helper function to extract GUID from React fiber tree
        const extractGuidFromElement = (el) => {
          const searchReactTree = (node, depth = 0) => {
            if (depth > 10 || !node) return null;

            const checkNode = (obj) => {
              if (!obj || typeof obj !== 'object') return null;

              for (const [key, value] of Object.entries(obj)) {
                if (typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)) {
                  if (key.toLowerCase().includes('guid') || key.toLowerCase().includes('channelid') || key.toLowerCase().includes('id')) {
                    return value;
                  }
                }
                if (typeof value === 'string' && value.includes('/browse') && (value.includes('/channel/') || value.includes('/asset/'))) {
                  const match = value.match(/\/(?:channel|asset)\/([a-f0-9]{32})/);
                  if (match) return match[1];
                }
              }
              return null;
            };

            const foundGuid = checkNode(node.memoizedProps) || checkNode(node.pendingProps) || checkNode(node.stateNode);
            if (foundGuid) return foundGuid;

            if (node.child) {
              const childResult = searchReactTree(node.child, depth + 1);
              if (childResult) return childResult;
            }
            if (node.return && depth < 5) {
              const parentResult = searchReactTree(node.return, depth + 1);
              if (parentResult) return parentResult;
            }

            return null;
          };

          const reactKeys = Object.keys(el).filter(key =>
            key.startsWith('__react') || key.startsWith('_react')
          );

          for (const key of reactKeys) {
            const foundGuid = searchReactTree(el[key]);
            if (foundGuid) return foundGuid;
          }

          return null;
        };

        // Collect initial channels before scrolling
        for (const el of document.querySelectorAll('[data-testid^="channel-"]')) {
          const testId = el.getAttribute('data-testid');
          if (testId && testId.startsWith('channel-')) {
            const name = testId.replace('channel-', '').trim();
            if (!seenChannels.has(name)) {
              seenChannels.add(name);

              const img = el.querySelector('img.grid-cell-image');
              const logo = img ? (img.src || img.dataset.src || '') : '';

              // Extract GUID from React fiber tree
              const guid = extractGuidFromElement(el);

              // Construct stream URL from GUID
              let streamUrl = '';
              if (guid && /^[a-f0-9]{32}$/.test(guid)) {
                streamUrl = `https://watch.sling.com/1/channel/${guid}/watch`;
              }

              channelData.push({ name, logo, streamUrl, guid });
            }
          }
        }

        // Scroll through and collect unique channels
        const scrollHeight = scrollContainer.scrollHeight;
        let lastChannelCount = seenChannels.size;
        let stableScrolls = 0;
        let scrollPosition = 0;
        const scrollIncrement = 300; // Larger increment for faster scrolling
        const maxScrolls = 50; // Maximum number of scroll iterations
        let scrollCount = 0;

        while (scrollPosition < scrollHeight && stableScrolls < 10 && scrollCount < maxScrolls) {
          scrollPosition += scrollIncrement;
          scrollContainer.scrollTop = scrollPosition;

          // Trigger scroll event to notify virtualized list
          scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

          // Shorter delay for faster iteration
          await new Promise(resolve => setTimeout(resolve, 150));

          // Check for new channels
          document.querySelectorAll('[data-testid^="channel-"]').forEach(el => {
            const testId = el.getAttribute('data-testid');
            if (testId && testId.startsWith('channel-')) {
              const name = testId.replace('channel-', '').trim();
              if (!seenChannels.has(name)) {
                seenChannels.add(name);

                const img = el.querySelector('img.grid-cell-image');
                const logo = img ? (img.src || img.dataset.src || '') : '';

                // Extract GUID from React fiber tree
                const guid = extractGuidFromElement(el);

                // Construct stream URL from GUID
                let streamUrl = '';
                if (guid && /^[a-f0-9]{32}$/.test(guid)) {
                  streamUrl = `https://watch.sling.com/1/channel/${guid}/watch`;
                }

                channelData.push({ name, logo, streamUrl, guid });
              }
            }
          });

          // Check if we found new channels
          if (seenChannels.size === lastChannelCount) {
            stableScrolls++;
          } else {
            stableScrolls = 0;
            lastChannelCount = seenChannels.size;
          }

          scrollCount++;
        }

        // Scroll back to top
        scrollContainer.scrollTop = 0;

        return {
          success: true,
          channelCount: channelData.length,
          channels: channelData,
          scrolledTo: scrollPosition,
          scrollHeight: scrollHeight,
          totalScrolls: scrollCount,
          stoppedReason: scrollCount >= maxScrolls ? 'max-scrolls' : (stableScrolls >= 10 ? 'stable' : 'end-reached')
        };
      });

      if (!scrollResult.success || !scrollResult.channels || scrollResult.channels.length === 0) {
        const debugInfo = scrollResult.debug ? JSON.stringify(scrollResult.debug, null, 2) : 'No debug info';
        throw new Error(`Failed to scrape Sling channels: ${scrollResult.reason || 'Unknown reason'}. Debug: ${debugInfo}`);
      }

      console.log(`[SlingService] Successfully extracted ${scrollResult.channels.length} channels`);

      // Log channels with and without URLs for debugging
      const channelsWithUrls = scrollResult.channels.filter(ch => ch.streamUrl && ch.streamUrl !== '');
      const channelsWithoutUrls = scrollResult.channels.filter(ch => !ch.streamUrl || ch.streamUrl === '');
      console.log(`[SlingService] Channels with URLs: ${channelsWithUrls.length}, without URLs: ${channelsWithoutUrls.length}`);

      if (channelsWithoutUrls.length > 0 && channelsWithoutUrls.length <= 5) {
        console.log(`[SlingService] Channels missing URLs: ${channelsWithoutUrls.map(ch => ch.name).join(', ')}`);
      }

      // Process and normalize the collected channels
      const normalizedChannels = scrollResult.channels.map(ch => {
        const channelId = ch.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        // Use captured stream URL if available, otherwise fall back to guessed URL
        let streamUrl = ch.streamUrl;
        if (!streamUrl || streamUrl === '') {
          console.warn(`[SlingService] No stream URL found for ${ch.name}, using fallback URL pattern`);
          streamUrl = `https://watch.sling.com/1/asset/${channelId}/watch`;
        }

        const normalized = this.normalizeChannel({
          name: ch.name,
          displayName: ch.name,
          id: `sling-${channelId}`,
          streamUrl: streamUrl,
          logo: ch.logo,
          category: this.categorizeChannel(ch.name)
        });
        return normalized;
      });

      // Clean up: navigate to blank page to free resources
      try {
        console.log('[SlingService] Cleaning up browser - navigating to blank page');
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
      } catch (cleanupError) {
        console.warn('[SlingService] Error during cleanup:', cleanupError.message);
      }

      return normalizedChannels;

    } catch (error) {
      console.error('[SlingService] Error fetching channels:', error.message);

      // Clean up even on error
      try {
        if (page) {
          console.log('[SlingService] Cleaning up browser after error - navigating to blank page');
          await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
        }
      } catch (cleanupError) {
        console.warn('[SlingService] Error during cleanup:', cleanupError.message);
      }

      throw error; // Propagate error instead of falling back to placeholder data
    }
  }

  /**
   * Get fallback/placeholder channels if scraping fails
   */
  getFallbackChannels() {
    console.log('[SlingService] Using fallback placeholder channels');

    const placeholderChannels = [
      {
        id: 'sling-0e87a84170da4646aa90528abfcbe2a9',
        name: 'NBATV',
        displayName: 'NBA TV',
        streamUrl: 'https://watch.sling.com/1/channel/0e87a84170da4646aa90528abfcbe2a9/watch',
        category: 'Sports'
      },
      {
        id: 'sling-db0e2f29bb004fb99282e792845aefcf',
        name: 'MLB',
        displayName: 'MLB Network',
        streamUrl: 'https://watch.sling.com/1/channel/db0e2f29bb004fb99282e792845aefcf/watch',
        category: 'Sports'
      },
      {
        id: 'sling-e7c98734f996492187bb868ce5655a0e',
        name: 'GOLF',
        displayName: 'Golf Channel',
        streamUrl: 'https://watch.sling.com/1/channel/e7c98734f996492187bb868ce5655a0e/watch',
        category: 'Sports'
      },
      {
        id: 'sling-0984387944df47b58a687d60babc2c43',
        name: 'BIG10',
        displayName: 'Big Ten Network',
        streamUrl: 'https://watch.sling.com/1/channel/0984387944df47b58a687d60babc2c43/watch',
        category: 'Sports'
      },
      {
        id: 'sling-8da93b497e644312b17d2420f1cb77f4',
        name: 'AMC',
        displayName: 'AMC',
        streamUrl: 'https://watch.sling.com/1/channel/8da93b497e644312b17d2420f1cb77f4/watch',
        category: 'Movies'
      },
      {
        id: 'sling-23a92a8fb160489b97fd746536551d50',
        name: 'TNT',
        displayName: 'TNT',
        streamUrl: 'https://watch.sling.com/1/channel/23a92a8fb160489b97fd746536551d50/watch',
        category: 'Other'
      },
      {
        id: 'sling-6f8a36632f45462db3b843ed96a1f96c',
        name: 'TBS',
        displayName: 'TBS',
        streamUrl: 'https://watch.sling.com/1/channel/6f8a36632f45462db3b843ed96a1f96c/watch',
        category: 'Other'
      }
    ];

    return placeholderChannels.map(ch => this.normalizeChannel(ch));
  }

  /**
   * Categorize channel based on name
   * Returns Channels DVR compatible genres: Movies, Sports, Drama, News, Children
   * Returns 'Other' for unrecognized channels (no genre tag will be written to M3U)
   */
  categorizeChannel(name) {
    const n = name.toLowerCase();
    // Sports channels
    if (/nfl|nba|mlb|nhl|espn|fox sports|btn|golf|bein|acc|big10|big ten|sec network/i.test(n)) return 'Sports';
    // News channels
    if (/news|cnn|msnbc|fox news|cnbc/i.test(n)) return 'News';
    // Movie channels
    if (/hbo|showtime|starz|mgm|amc|movie|paramount network/i.test(n)) return 'Movies';
    // Drama channels
    if (/\ba&e\b|bravo|^fx$|fxm|fxx|hallmark/i.test(n)) return 'Drama';
    // Children channels
    if (/nick|disney|cartoon|kids/i.test(n)) return 'Kids';
    return 'Other';
  }
}

module.exports = { SlingService };
