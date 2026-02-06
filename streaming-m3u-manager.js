const fetch = require('node-fetch');
const fs = require('fs').promises;
const path = require('path');
const Constants = require('./constants.js');

/**
 * Streaming M3U Manager
 * Multi-service M3U playlist generator with Channels DVR integration
 * Supports: Sling TV, Custom Entries, and extensible for other services
 */
class StreamingM3UManager {
  constructor() {
    this.services = {};
    this.channels = [];
    this.channelsStations = null;

    // Use DATA_DIR from constants (defaults to ./data, configurable via --data-dir parameter)
    this.dataFile = path.join(Constants.DATA_DIR, 'streaming_channels.json');

    this.isRefreshing = false;
    this.lastUpdate = null;

    // Known callsign aliases - map common channel names to their Channels DVR callsigns
    this.callsignAliases = {
      'A&E': 'AETV',
      'AE': 'AETV',
      'CARTOON NETWORK & ADULT SWIM': 'TOON',
      'CARTOON NETWORK AND ADULT SWIM': 'TOON',
      'DISCOVERY': 'DSC',
      'DISCOVERY CHANNEL': 'DSC',
      'FOX BUSINESS': 'FBN',
      'FOX BUSINESS NETWORK': 'FBN',
      'FOX NEWS': 'FNC',
      'FOX NEWS CHANNEL': 'FNC',
      'FOX SPORTS 1': 'FS1',
      'FOX SPORTS 2': 'FS2',
      'NATIONAL GEOGRAPHIC WILD': 'NATGW',
      'NAT GEO WILD': 'NATGW',
      'NATIONAL GEOGRAPHIC': 'NGC',
      'NAT GEO': 'NGC',
      'NFL REDZONE': 'NFLNRZD',
      'NFLREDZONE': 'NFLNRZD',
      'SEC NETWORK': 'SEC',
      'SECNETWORK': 'SEC',
      'MLB NETWORK': 'MLBHD',
      'BBC NEWS': 'BBCWDEH',
      'BBC COMEDY': 'BBCCMDY',
      'BBCCOMEDY': 'BBCCMDY',
      'BBC AMERICA COMEDY': 'BBCCMDY',
      'BBCAMERICACOMEDY': 'BBCCMDY',
      'BBC DRAMA': 'BBCDRSP',
      'BBCDRAMA': 'BBCDRSP',
      'BBC AMERICA DRAMA': 'BBCDRSP',
      'BBCAMERICADRAMA': 'BBCDRSP',
      'AMC THRILLERS': 'AMCRSH',
      'AMC THRILLR': 'AMCRSH',
      'OUTSIDE TV': 'OUTSIDE',
      'OUTSIDETV': 'OUTSIDE',
      'HDNET MOVIES': 'HDNETMV',
      'HDNETMOVIES': 'HDNETMV',
      // Starz channel aliases - map to abbreviated callsigns
      'STARZ': 'STZHD',
      'STARZ EAST': 'STZHD',
      'STARZ WEST': 'STZHDP',
      'STARZ EDGE': 'STZEHD',
      'STARZ EDGE EAST': 'STZEHD',
      'STARZ ENCORE': 'STZENHD',
      'STARZ ENCORE ACTION': 'STZENAC',
      'STARZ ENCORE SUSPENSE': 'STZENSU',
      'STARZ ENCORE BLACK': 'STZENBK',
      'STARZ ENCORE CLASSIC': 'STZENCL',
      'STARZ ENCORE FAMILY': 'STZENFS',
      'STARZ ENCORE ESPANOL': 'STZESPS',
      'STARZ ENCORE WEST': 'STZENCP',
      'STARZ ENCORE WESTERNS': 'STZEWSS',
      'STARZ IN BLACK': 'STZIB',
      'STARZ KIDS & FAMILY': 'STZKHD',
      'STARZ KIDS AND FAMILY': 'STZKHD',
      'STARZ CINEMA': 'STRZCIH',
      'STARZ COMEDY': 'STZCHD',
      // Showtime channel aliases
      'SHOWTIME': 'SHO',
      'SHOWTIME 2': 'SHO2HD',
      'SHOWTIME EXTREME': 'SHOWXHD',
      'SHOWTIME NEXT': 'NEXT',
      'SHOWTIME SHOWCASE': 'SHOCSHD',
      'SHOWTIME WOMEN': 'WOMEN',
      'SHOWTIME WEST': 'SHOW',
      'SHOWTIME FAMILY ZONE': 'FAMZHD',
      'SHOWTIMEFAMILYZONE': 'FAMZHD',
      'PARAMOUNT+ WITH SHOWTIME': 'PARSHOH',
      'PARAMOUNT WITH SHOWTIME': 'PARSHOH',
      'PARAMOUNT+ SHOWTIME': 'PARSHOH',
      'PARAMOUNT SHOWTIME': 'PARSHOH',
      'PARAMOUNT+ WITH SHOWTIME WEST': 'PASHOHW',
      'PARAMOUNT WITH SHOWTIME WEST': 'PASHOHW',
      'PARAMOUNT+ SHOWTIME WEST': 'PASHOHW',
      'PARAMOUNT SHOWTIME WEST': 'PASHOHW',
      'PARAMOUNT+ WITH SHOWTIME W': 'PASHOHW',
      'PARAMOUNT WITH SHOWTIME W': 'PASHOHW',
      'PARAMOUNT+ SHOWTIME W': 'PASHOHW',
      'PARAMOUNT SHOWTIME W': 'PASHOHW',
      'PARAMOUNT+ NETWORK': 'PARHD',
      'PARAMOUNT NETWORK': 'PARHD',
      // MGM+ channel aliases
      'MGM+': 'MGM',
      'MGM PLUS': 'MGM',
      'MGM+ HITS': 'MGMHTH',
      'MGM HITS': 'MGMHTH',
      'MGM+ MARQUEE': 'MGMMR',
      'MGM MARQUEE': 'MGMMR',
      'MGM+ DRIVE-IN': 'MGMDRV',
      'MGM DRIVE-IN': 'MGMDRV',
      'MGM+ DRIVEIN': 'MGMDRV',
      'MGM DRIVEIN': 'MGMDRV',
      // PBS/Public TV channel aliases
      'COLORADO PUBLIC TELEVISION': 'KBDIDT2',
      'COLORADO PUBLIC TV': 'KBDIDT2'
    };
  }

  /**
   * Initialize the manager - must be called after construction
   */
  async initialize() {
    // Ensure data directory exists
    await this.ensureDataDirectory();

    // Load saved data
    await this.loadFromDisk();
  }

  async ensureDataDirectory() {
    try {
      await fs.mkdir(Constants.DATA_DIR, { recursive: true });
      console.log(`[M3U Manager] Data directory: ${Constants.DATA_DIR}`);
    } catch (error) {
      console.error(`[M3U Manager] Error creating data directory: ${error.message}`);
    }
  }

  /**
   * Register a streaming service
   */
  registerService(name, serviceInstance) {
    this.services[name] = serviceInstance;
    console.log(`[M3U Manager] Registered service: ${name}`);
  }

  /**
   * Load channel data from disk
   */
  async loadFromDisk() {
    try {
      const data = await fs.readFile(this.dataFile, 'utf8');
      const parsed = JSON.parse(data);
      this.channels = parsed.channels || [];
      this.lastUpdate = parsed.lastUpdate;
      console.log(`[M3U Manager] Loaded ${this.channels.length} channels from disk`);
    } catch (error) {
      console.log('[M3U Manager] No saved data found, starting fresh');
      this.channels = [];
    }
  }

  /**
   * Save channel data to disk
   */
  async saveToDisk() {
    const data = {
      channels: this.channels,
      lastUpdate: this.lastUpdate
    };
    await fs.writeFile(this.dataFile, JSON.stringify(data, null, 2));
    console.log(`[M3U Manager] Saved ${this.channels.length} channels to disk`);
  }

  /**
   * Fetch Channels DVR guide stations for enrichment
   */
  async fetchChannelsStations() {
    try {
      const url = `${Constants.CHANNELS_URL}:${Constants.CHANNELS_PORT}/dvr/guide/stations`;
      const response = await fetch(url);
      const stations = await response.json();
      this.channelsStations = stations;
      console.log('[M3U Manager] Fetched Channels DVR guide stations');
      return stations;
    } catch (error) {
      console.error('[M3U Manager] Error fetching Channels DVR stations:', error.message);
      return null;
    }
  }

  /**
   * Calculate match score for HD prioritization
   * Higher score = better match
   * @param {object} station - Station object
   * @param {string} searchName - Original search name (before alias)
   * @param {string} sourceName - Source name
   * @param {boolean} usedAlias - Whether an alias was used for this search
   * @param {string} aliasedSearchName - The aliased search name (if alias was used)
   */
  calculateMatchScore(station, searchName, sourceName, usedAlias = false, aliasedSearchName = '') {
    let score = 0;

    const callSign = station.callSign?.toUpperCase() || '';
    const affiliateCallSign = station.affiliateCallSign?.toUpperCase() || '';
    const videoType = station.videoQuality?.videoType?.toUpperCase() || '';
    const truResolution = station.videoQuality?.truResolution?.toUpperCase() || '';

    // If alias was used and this is an exact match, give massive bonus
    // This ensures "NFL RedZone" → "NFLNRZD" alias matches "NFLNRZD" exactly, not "NFLHD"
    if (usedAlias && aliasedSearchName) {
      const callSignNormalized = callSign.replace(/[^A-Z0-9]/g, '');
      const aliasNormalized = aliasedSearchName.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const callSignBase = callSignNormalized.replace(/HD$/i, '');
      const aliasBase = aliasNormalized.replace(/HD$/i, '');

      if (callSignNormalized === aliasNormalized || callSignBase === aliasBase) {
        score += 1000; // Huge bonus for exact alias match
      }
    }

    // Prioritize HD channels
    if (callSign.endsWith('HD')) {
      score += 100;
    }

    if (videoType === 'HDTV') {
      score += 50;
    }

    if (truResolution.includes('1080') || truResolution.includes('720')) {
      score += 30;
    }

    // Exact match bonus
    const callSignBase = callSign.replace(/HD$/i, '');
    const searchNameBase = searchName.replace(/HD$/i, '');
    if (callSignBase === searchNameBase) {
      score += 10;
    }

    if (affiliateCallSign === searchNameBase) {
      score += 5;
    }

    // Length mismatch penalty - penalize when search term is much longer than callsign
    // This prevents "Starz Cinema" from matching just "STARZ"
    const lengthDiff = Math.abs(callSignBase.length - searchNameBase.length);
    if (lengthDiff > 3) {
      // Penalize based on how much longer the search is than the callsign
      score -= (lengthDiff * 10);
    }

    // Penalize SD
    if (videoType === 'SDTV') {
      score -= 50;
    }

    // Source priority
    if (sourceName === 'X-TVE') {
      score += 20;
    } else if (sourceName === 'X-M3U') {
      score += 15;
    } else if (sourceName === 'X-LOCAST') {
      score += 10;
    }

    return score;
  }

  /**
   * Find matching station from Channels DVR guide data
   * Prioritizes HD versions using scoring system
   * Falls back to TMS search if no matches found
   */
  async findMatchingStation(channelName) {
    if (!this.channelsStations) return null;

    const searchName = channelName.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const prioritySources = ['X-TVE', 'X-M3U', 'X-LOCAST', 'USA-OTA60611', 'USA-OTA80112'];

    // Check if there's a known alias for this channel name
    let aliasedSearchName = searchName;
    let usedAlias = false;
    for (const [alias, callsign] of Object.entries(this.callsignAliases)) {
      const normalizedAlias = alias.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (searchName === normalizedAlias) {
        aliasedSearchName = callsign;
        usedAlias = true;
        console.log(`[M3U Manager] Using alias: "${channelName}" → "${callsign}"`);
        break;
      }
    }

    let allMatches = [];

    for (const sourceName of prioritySources) {
      const source = this.channelsStations[sourceName];
      if (!source || typeof source !== 'object') continue;

      const stations = Object.values(source);

      for (const station of stations) {
        const callSign = station.callSign?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
        const affiliateCallSign = station.affiliateCallSign?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
        const stationName = station.name?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';

        const callSignBase = callSign.replace(/HD$/i, '').replace(/\d+$/i, ''); // Remove HD and trailing numbers
        const affiliateBase = affiliateCallSign.replace(/HD$/i, '');
        const searchNameBase = aliasedSearchName.replace(/HD$/i, '');

        // Multiple matching strategies
        let isMatch = false;

        // Exact match
        if (callSign === aliasedSearchName || affiliateCallSign === aliasedSearchName) {
          isMatch = true;
        }
        // Base match (without HD suffix)
        else if (callSignBase === searchNameBase || affiliateBase === searchNameBase) {
          isMatch = true;
        }
        // OTA Digital TV match - "KCNC HDTV" (normalized to "KCNCHDTV") should match "KCNCDT"
        // Pattern: channel name ends with "HDTV" and callsign ends with "DT"
        else if (aliasedSearchName.endsWith('HDTV') && callSign.endsWith('DT')) {
          const searchWithoutHDTV = aliasedSearchName.substring(0, aliasedSearchName.length - 4);
          const callSignWithoutDT = callSign.substring(0, callSign.length - 2);
          if (searchWithoutHDTV === callSignWithoutDT) {
            isMatch = true;
          }
        }
        // Reverse: callsign ends with DT, search might be the base station name
        else if (callSign.endsWith('DT') && aliasedSearchName.length >= 4) {
          const callSignWithoutDT = callSign.substring(0, callSign.length - 2);
          if (callSignWithoutDT === aliasedSearchName) {
            isMatch = true;
          }
        }
        // Starts with match - allows "BBC" to match "BBCA" or "BBCAMERICA"
        // Only apply if search term is at least 3 characters and station is longer
        else if (searchNameBase.length >= 3 && callSignBase.length >= searchNameBase.length &&
                callSignBase.startsWith(searchNameBase)) {
          isMatch = true;
        }
        // Reverse starts with - allows station "BBC" to match search "BBCAMERICA"
        else if (callSignBase.length >= 3 && searchNameBase.length >= callSignBase.length &&
                searchNameBase.startsWith(callSignBase)) {
          isMatch = true;
        }
        // Station name contains search (for full names like "BBC America")
        // Only if both are at least 4 characters and similar length
        else if (searchNameBase.length >= 4 && stationName.length >= 4 &&
                Math.abs(searchNameBase.length - stationName.length) <= 5 &&
                (stationName.includes(searchNameBase) || searchNameBase.includes(stationName))) {
          isMatch = true;
        }
        // Partial match - only if both strings are similar length (within 3 chars)
        // This prevents short call signs from matching long channel names
        else if (searchNameBase.length >= 4 && callSignBase.length >= 4 &&
                Math.abs(searchNameBase.length - callSignBase.length) <= 3 &&
                (callSignBase.includes(searchNameBase) || searchNameBase.includes(callSignBase))) {
          isMatch = true;
        }
        // Network name matching (e.g., "MLB Network" matches "MLB")
        else if (searchNameBase.includes('NETWORK')) {
          const networkPart = searchNameBase.replace('NETWORK', '');
          // Only match if callsign equals or starts with the network part
          // This prevents "ACC Network" from matching "CC" in "CCHD"
          if (networkPart.length >= 2 && (callSignBase === networkPart || callSignBase.startsWith(networkPart))) {
            isMatch = true;
          }
        }

        if (isMatch) {
          allMatches.push({
            ...station,
            source: sourceName,
            matchScore: this.calculateMatchScore(station, searchName, sourceName, usedAlias, aliasedSearchName)
          });
        }
      }
    }

    if (allMatches.length === 0) {
      console.log(`[M3U Manager] No match found in guide stations for "${channelName}", trying TMS search`);

      // Try TMS search as fallback - use aliased name if available
      const searchTerm = usedAlias ? aliasedSearchName : channelName;
      const tmsResults = await this.searchTMSStations(searchTerm, 1);
      if (tmsResults.length > 0) {
        const tmsMatch = tmsResults[0];
        console.log(`[M3U Manager] TMS match found for "${channelName}": ${tmsMatch.callSign}`);

        // Convert TMS result to the format expected by enrichChannel
        return {
          stationId: tmsMatch.stationId,
          callSign: tmsMatch.callSign,
          affiliateCallSign: tmsMatch.affiliateCallSign,
          name: tmsMatch.name,
          channel: tmsMatch.channel,
          preferredImage: tmsMatch.logo ? { uri: tmsMatch.logo } : null,
          videoQuality: null
        };
      }

      console.log(`[M3U Manager] No match found (including TMS) for "${channelName}"`);
      return null;
    }

    allMatches.sort((a, b) => b.matchScore - a.matchScore);

    const bestMatch = allMatches[0];
    console.log(`[M3U Manager] Best match for "${channelName}": ${bestMatch.callSign} (score: ${bestMatch.matchScore})`);

    // If alias was used but best match score is low (< 500), it means the aliased callsign
    // wasn't found in guide stations. Fall back to TMS search for better match.
    if (usedAlias && bestMatch.matchScore < 500) {
      console.log(`[M3U Manager] Alias used but score is low (${bestMatch.matchScore}), trying TMS search for "${aliasedSearchName}"`);
      const tmsResults = await this.searchTMSStations(aliasedSearchName, 1);
      if (tmsResults.length > 0) {
        const tmsMatch = tmsResults[0];
        console.log(`[M3U Manager] TMS match found for "${channelName}": ${tmsMatch.callSign}`);
        return {
          stationId: tmsMatch.stationId,
          callSign: tmsMatch.callSign,
          affiliateCallSign: tmsMatch.affiliateCallSign,
          name: tmsMatch.name,
          channel: tmsMatch.channel,
          preferredImage: tmsMatch.logo ? { uri: tmsMatch.logo } : null,
          videoQuality: null
        };
      }
    }

    return bestMatch;
  }

  /**
   * Search for stations matching a query term
   * Returns all matches with scores for user selection
   * @param {string} query - Search term
   * @param {number} limit - Maximum number of results (default 10)
   * @returns {Promise<Array>} Array of matching stations with scores
   */
  async searchStations(query, limit = 10) {
    if (!query || query.trim().length < 2) {
      return [];
    }

    // Fetch Channels DVR stations if not already loaded
    if (!this.channelsStations) {
      await this.fetchChannelsStations();
    }

    const searchName = query.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const prioritySources = ['X-TVE', 'X-M3U', 'X-LOCAST', 'USA-OTA60611', 'USA-OTA80112'];
    const allMatches = [];

    // Check if there's a known alias for this search term
    let aliasedSearchName = searchName;
    let usedAlias = false;
    for (const [alias, callsign] of Object.entries(this.callsignAliases)) {
      const normalizedAlias = alias.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (searchName === normalizedAlias) {
        aliasedSearchName = callsign;
        usedAlias = true;
        console.log(`[M3U Manager] Using search alias: "${query}" → "${callsign}"`);
        break;
      }
    }

    for (const sourceName of prioritySources) {
      const source = this.channelsStations[sourceName];
      if (!source || typeof source !== 'object') continue;

      const stations = Object.values(source);

      for (const station of stations) {
        const callSign = station.callSign?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
        const affiliateCallSign = station.affiliateCallSign?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';
        const stationName = station.name?.toUpperCase().replace(/[^A-Z0-9]/g, '') || '';

        const callSignBase = callSign.replace(/HD$/i, '').replace(/\d+$/i, '');
        const affiliateBase = affiliateCallSign.replace(/HD$/i, '');
        const searchNameBase = aliasedSearchName.replace(/HD$/i, '');

        let isMatch = false;

        // Exact match
        if (callSign === aliasedSearchName || affiliateCallSign === aliasedSearchName) {
          isMatch = true;
        }
        // Base match (without HD suffix)
        else if (callSignBase === searchNameBase || affiliateBase === searchNameBase) {
          isMatch = true;
        }
        // OTA Digital TV match - "KCNC HDTV" (normalized to "KCNCHDTV") should match "KCNCDT"
        // Pattern: channel name ends with "HDTV" and callsign ends with "DT"
        else if (aliasedSearchName.endsWith('HDTV') && callSign.endsWith('DT')) {
          const searchWithoutHDTV = aliasedSearchName.substring(0, aliasedSearchName.length - 4);
          const callSignWithoutDT = callSign.substring(0, callSign.length - 2);
          if (searchWithoutHDTV === callSignWithoutDT) {
            isMatch = true;
          }
        }
        // Reverse: callsign ends with DT, search might be the base station name
        else if (callSign.endsWith('DT') && aliasedSearchName.length >= 4) {
          const callSignWithoutDT = callSign.substring(0, callSign.length - 2);
          if (callSignWithoutDT === aliasedSearchName) {
            isMatch = true;
          }
        }
        // Starts with match - allows "BBC" to match "BBCA" or "BBCAMERICA"
        // Only apply if search term is at least 3 characters and station is longer
        else if (searchNameBase.length >= 3 && callSignBase.length >= searchNameBase.length &&
                callSignBase.startsWith(searchNameBase)) {
          isMatch = true;
        }
        // Reverse starts with - allows station "BBC" to match search "BBCAMERICA"
        else if (callSignBase.length >= 3 && searchNameBase.length >= callSignBase.length &&
                searchNameBase.startsWith(callSignBase)) {
          isMatch = true;
        }
        // Station name contains search (for full names like "BBC America")
        // Only if both are at least 4 characters and similar length
        else if (searchNameBase.length >= 4 && stationName.length >= 4 &&
                Math.abs(searchNameBase.length - stationName.length) <= 5 &&
                (stationName.includes(searchNameBase) || searchNameBase.includes(stationName))) {
          isMatch = true;
        }
        // Partial match - only if both strings are similar length (within 3 chars)
        else if (searchNameBase.length >= 4 && callSignBase.length >= 4 &&
                Math.abs(searchNameBase.length - callSignBase.length) <= 3 &&
                (callSignBase.includes(searchNameBase) || searchNameBase.includes(callSignBase))) {
          isMatch = true;
        }
        // Network name matching (e.g., "MLB Network" matches "MLB")
        else if (searchNameBase.includes('NETWORK')) {
          const networkPart = searchNameBase.replace('NETWORK', '');
          // Only match if callsign equals or starts with the network part
          // This prevents "ACC Network" from matching "CC" in "CCHD"
          if (networkPart.length >= 2 && (callSignBase === networkPart || callSignBase.startsWith(networkPart))) {
            isMatch = true;
          }
        }

        if (isMatch) {
          allMatches.push({
            stationId: station.stationId,
            callSign: station.callSign,
            affiliateCallSign: station.affiliateCallSign,
            name: station.name,
            channel: station.channel,
            logo: station.preferredImage?.uri || '',
            source: sourceName,
            matchScore: this.calculateMatchScore(station, searchName, sourceName, usedAlias, aliasedSearchName)
          });
        }
      }
    }

    // Sort by match score descending
    allMatches.sort((a, b) => b.matchScore - a.matchScore);

    // Always try TMS search to provide additional options
    // This helps find stations like "AMC Thrillers" that may not be in guide stations
    console.log(`[M3U Manager] Searching TMS stations for additional matches: "${query}"`);
    const tmsResults = await this.searchTMSStations(query, limit);

    // Combine guide station matches with TMS results
    // Remove duplicates based on stationId
    const seenStationIds = new Set(allMatches.map(m => m.stationId));
    const uniqueTmsResults = tmsResults.filter(tms => !seenStationIds.has(tms.stationId));

    // Combine results: guide stations first (sorted by score), then unique TMS results
    const combinedResults = [...allMatches, ...uniqueTmsResults];

    // Return top matches (limited)
    return combinedResults.slice(0, limit);
  }

  /**
   * Search Channels DVR TMS stations endpoint
   * Fallback search when primary guide stations don't have matches
   * @param {string} query - Search term (call sign or station name)
   * @param {number} limit - Maximum number of results (default 10)
   * @returns {Promise<Array>} Array of matching stations
   */
  async searchTMSStations(query, limit = 10) {
    if (!query || query.trim().length < 2) {
      return [];
    }

    try {
      const url = `${Constants.CHANNELS_URL}:${Constants.CHANNELS_PORT}/tms/stations/${encodeURIComponent(query)}`;
      console.log(`[M3U Manager] Searching TMS stations: ${url}`);

      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[M3U Manager] TMS search failed with status ${response.status}`);
        return [];
      }

      const stations = await response.json();

      if (!Array.isArray(stations) || stations.length === 0) {
        console.log('[M3U Manager] No TMS stations found');
        return [];
      }

      console.log(`[M3U Manager] Found ${stations.length} stations from TMS search`);

      // Map TMS results to our standard format
      const mappedResults = stations.slice(0, limit).map(station => ({
        stationId: station.stationId || station.StationID || '',
        callSign: station.callSign || station.CallSign || '',
        affiliateCallSign: station.affiliateCallSign || station.AffiliateCallSign || '',
        name: station.name || station.Name || '',
        channel: station.channel || station.Channel || '',
        logo: station.logo?.URL || station.Logo?.URL || station.preferredImage?.uri || '',
        source: 'TMS',
        matchScore: 0 // TMS results don't have scores
      })).filter(s => s.stationId); // Only return results with valid station IDs

      return mappedResults;
    } catch (error) {
      console.error('[M3U Manager] Error searching TMS stations:', error.message);
      return [];
    }
  }

  /**
   * Enrich channel with Channels DVR data
   */
  async enrichChannel(channel) {
    // Skip enrichment for channels using placeholder mode (duration-based EPG)
    // These channels should use exactly what the user specified
    if (channel.duration) {
      return {
        ...channel,
        stationId: null, // Ensure no stationId for placeholder mode
        callSign: channel.callSign || channel.name,
        channelNumber: channel.channelNumber || this.autoAssignChannelNumber(channel.service)
      };
    }

    const match = await this.findMatchingStation(channel.name);

    const enriched = {
      ...channel,
      // Preserve user-provided stationId, otherwise use Channels DVR match
      stationId: channel.stationId || match?.stationId || null,
      // Prefer Channels DVR logo (higher quality), fall back to scraped logo
      logo: match?.preferredImage?.uri || channel.logo || '',
      callSign: match?.callSign || channel.callSign || channel.name,
      videoQuality: match?.videoQuality || channel.videoQuality || null,
      // If no match found and no duration set, default to 60 minutes for placeholder EPG
      duration: channel.duration || (match ? null : 60)
    };

    // Preserve manually-set channel numbers (marked with manualChannelNumber flag)
    // Otherwise use Channels DVR channel number if found, or auto-assign
    if (channel.manualChannelNumber) {
      enriched.channelNumber = channel.channelNumber;
      enriched.manualChannelNumber = true;
    } else if (match?.channel) {
      enriched.channelNumber = match.channel;
    } else if (!enriched.channelNumber) {
      enriched.channelNumber = this.autoAssignChannelNumber(channel.service);
    }

    return enriched;
  }

  /**
   * Auto-assign channel number based on service
   * Finds the highest existing channel number and increments from there
   */
  autoAssignChannelNumber(service) {
    const baseNumbers = {
      'sling': 2400,
      'peacock': 2500,
      'nbc': 2600,
      'custom': 2410
    };

    const base = baseNumbers[service] || 2410;
    const serviceChannels = this.channels.filter(ch => ch.service === service);

    if (serviceChannels.length === 0) {
      return base;
    }

    // Find the highest channel number currently in use for this service
    const channelNumbers = serviceChannels
      .map(ch => parseInt(ch.channelNumber))
      .filter(num => !isNaN(num) && num >= base);

    if (channelNumbers.length === 0) {
      return base;
    }

    const maxNumber = Math.max(...channelNumbers);
    return maxNumber + 1;
  }

  /**
   * Refresh channels from a specific service
   * @param {string} serviceName - Service to refresh
   * @param {boolean} resetEdits - If true, removes manual edits and re-enriches all channels
   * @param {boolean} favoritesOnly - For Sling TV, if true scrapes favorites; if false scrapes all channels
   */
  async refreshService(serviceName, resetEdits = false, favoritesOnly = true) {
    const service = this.services[serviceName];
    if (!service) {
      throw new Error(`Unknown service: ${serviceName}`);
    }

    console.log(`[M3U Manager] Refreshing service: ${serviceName} (resetEdits: ${resetEdits}, favoritesOnly: ${favoritesOnly})`);

    // Fetch Channels DVR stations if not already loaded
    if (!this.channelsStations) {
      await this.fetchChannelsStations();
    }

    // Fetch channels from service
    // Pass favoritesOnly parameter to Sling service, other services will ignore it
    const channels = await service.fetchChannels(favoritesOnly);

    if (resetEdits) {
      // Full reset: remove all old channels and re-enrich
      // Remove old channels first
      this.channels = this.channels.filter(ch => ch.service !== serviceName);

      // Enrich channels sequentially to ensure unique auto-assigned channel numbers
      const enriched = [];
      for (const ch of channels) {
        const enrichedChannel = await this.enrichChannel(ch);
        this.channels.push(enrichedChannel);
        enriched.push(enrichedChannel);
      }

      console.log(`[M3U Manager] Full reset: Refreshed ${enriched.length} channels from ${serviceName}`);
    } else {
      // Preserve edits: merge new channels with existing ones
      const existingChannels = this.channels.filter(ch => ch.service === serviceName);

      // Remove old channels from this service first
      this.channels = this.channels.filter(ch => ch.service !== serviceName);

      const enriched = [];
      for (const newChannel of channels) {
        // Find existing channel by ID
        const existing = existingChannels.find(ch => ch.id === newChannel.id);

        let channelToAdd;
        if (existing) {
          // Preserve manual edits for existing channels
          channelToAdd = {
            ...existing,
            // Update stream URL in case it changed
            streamUrl: newChannel.streamUrl,
            // Preserve manual fields: channelNumber (if manually set), stationId, duration, category, logo
            updatedAt: new Date().toISOString()
          };
        } else {
          // New channel: enrich it
          channelToAdd = await this.enrichChannel(newChannel);
        }

        this.channels.push(channelToAdd);
        enriched.push(channelToAdd);
      }

      // Identify channels that were removed from the service
      const newChannelIds = new Set(channels.map(ch => ch.id));
      const removedChannels = existingChannels.filter(ch => !newChannelIds.has(ch.id));

      if (removedChannels.length > 0) {
        console.log(`[M3U Manager] Removed ${removedChannels.length} deleted channels from ${serviceName}:`);
        removedChannels.forEach(ch => {
          console.log(`[M3U Manager]   - ${ch.name} (channel ${ch.channelNumber || 'no number'})`);
        });
      }

      console.log(`[M3U Manager] Preserved edits: Refreshed ${enriched.length} channels from ${serviceName}`);
    }

    this.lastUpdate = new Date().toISOString();
    await this.saveToDisk();

    return {
      service: serviceName,
      channelCount: this.channels.filter(ch => ch.service === serviceName).length,
      timestamp: this.lastUpdate
    };
  }

  /**
   * Get all channels
   */
  getAllChannels() {
    return this.channels;
  }

  /**
   * Get channels from specific service
   */
  getChannelsByService(serviceName) {
    return this.channels.filter(ch => ch.service === serviceName);
  }

  /**
   * Get channel by ID
   */
  getChannelById(id) {
    return this.channels.find(ch => ch.id === id);
  }

  /**
   * Add custom channel
   */
  async addCustomChannel(channelData) {
    // Validate required fields
    if (!channelData || !channelData.name) {
      throw new Error('Channel name is required');
    }
    if (!channelData.streamUrl) {
      throw new Error('Stream URL is required');
    }

    // Fetch Channels DVR stations if not already loaded
    if (!this.channelsStations) {
      await this.fetchChannelsStations();
    }

    const channel = {
      id: `custom-${Date.now()}`,
      service: 'custom',
      name: channelData.name,
      streamUrl: channelData.streamUrl,
      channelNumber: channelData.channelNumber || null,
      stationId: channelData.stationId || null,
      duration: channelData.duration || null,
      category: channelData.category || 'Drama',
      logo: channelData.logo || '',
      callSign: channelData.callSign || channelData.name,
      enabled: true,
      createdAt: new Date().toISOString()
    };

    // Enrich with Channels DVR data (skip enrichment if no name to search)
    const enriched = await this.enrichChannel(channel);

    this.channels.push(enriched);
    this.lastUpdate = new Date().toISOString();
    await this.saveToDisk();

    console.log(`[M3U Manager] Added custom channel: ${enriched.name}`);

    return enriched;
  }

  /**
   * Update channel
   */
  async updateChannel(id, updates) {
    const index = this.channels.findIndex(ch => ch.id === id);
    if (index === -1) {
      throw new Error(`Channel not found: ${id}`);
    }

    // Mark channel number as manually set if it's being updated
    const updatedData = { ...updates };
    if ('channelNumber' in updates) {
      updatedData.manualChannelNumber = true;
    }

    this.channels[index] = {
      ...this.channels[index],
      ...updatedData,
      updatedAt: new Date().toISOString()
    };

    this.lastUpdate = new Date().toISOString();
    await this.saveToDisk();

    console.log(`[M3U Manager] Updated channel: ${id}`);

    return this.channels[index];
  }

  /**
   * Delete channel
   */
  async deleteChannel(id) {
    const index = this.channels.findIndex(ch => ch.id === id);
    if (index === -1) {
      throw new Error(`Channel not found: ${id}`);
    }

    const deleted = this.channels.splice(index, 1)[0];

    this.lastUpdate = new Date().toISOString();
    await this.saveToDisk();

    console.log(`[M3U Manager] Deleted channel: ${id}`);

    return deleted;
  }

  /**
   * Toggle channel enabled/disabled
   */
  async toggleChannel(id) {
    const channel = this.getChannelById(id);
    if (!channel) {
      throw new Error(`Channel not found: ${id}`);
    }

    channel.enabled = !channel.enabled;
    this.lastUpdate = new Date().toISOString();
    await this.saveToDisk();

    console.log(`[M3U Manager] Toggled channel ${id}: ${channel.enabled ? 'enabled' : 'disabled'}`);

    return channel;
  }

  /**
   * Generate M3U playlist
   */
  generateM3U(replaceHost = 'CH4C_IP_ADDRESS') {
    const ch4cPort = Constants.CH4C_PORT;

    // Get all enabled channels, sorted by channel number
    const enabledChannels = this.channels
      .filter(ch => ch.enabled !== false)
      .sort((a, b) => {
        const aNum = parseFloat(a.channelNumber) || 9999;
        const bNum = parseFloat(b.channelNumber) || 9999;
        return aNum - bNum;
      });

    let m3u = `#EXTM3U\n\n`;

    for (const ch of enabledChannels) {
      const tvgId = ch.id;
      const tvgName = ch.callSign || ch.name;
      const tvgLogo = ch.logo || '';
      const channelNum = ch.channelNumber || '';
      // Map internal category to Channels DVR genre format
      // Channels DVR supported genres: Movies, Sports, Drama, News, Children
      // "Other" means no genre - tvc-guide-genres tag will be omitted
      const genreMap = {
        'Entertainment': 'Drama',
        'Kids': 'Children',
        'Movies': 'Movies',
        'Sports': 'Sports',
        'News': 'News',
        'Drama': 'Drama',
        'Children': 'Children',
        'Other': null  // null means don't write genre tag
      };
      const genre = genreMap[ch.category] !== undefined ? genreMap[ch.category] : 'Other';
      const displayName = ch.name;

      // Use tvc-guide-stationid if stationId is set, otherwise use tvc-guide-placeholders with duration
      let guideAttribute = '';
      if (ch.stationId) {
        guideAttribute = ` tvc-guide-stationid="${ch.stationId}"`;
      } else if (ch.duration) {
        // Duration is stored in minutes, convert to seconds for tvc-guide-placeholders
        const durationSeconds = ch.duration * 60;
        guideAttribute = ` tvc-guide-placeholders="${durationSeconds}"`;
      }

      // Only add tvc-guide-genres if genre is set (not null/Other)
      const genreAttribute = genre ? ` tvc-guide-genres="${genre}"` : '';

      // Add tvc-guide-tags for video quality if HDTV or SDTV
      // videoQuality can be either a string or an object with videoType property
      const videoType = typeof ch.videoQuality === 'object' ? ch.videoQuality?.videoType : ch.videoQuality;
      const tagsAttribute = (videoType === 'HDTV' || videoType === 'SDTV') ? ` tvc-guide-tags="${videoType}"` : '';

      m3u += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${tvgLogo}"${guideAttribute} channel-number="${channelNum}"${genreAttribute}${tagsAttribute},${displayName}\n`;

      // Encoder channels (custom service) use direct URLs, streaming services use proxy wrapper
      if (ch.service === 'custom') {
        // Encoder channel - use direct URL without encoding
        m3u += `${ch.streamUrl}\n\n`;
      } else {
        // Streaming service channel - use proxy wrapper
        m3u += `http://${replaceHost}:${ch4cPort}/stream?url=${encodeURIComponent(ch.streamUrl)}\n\n`;
      }
    }

    return m3u;
  }

  /**
   * Generate M3U playlist with remote Channels DVR URLs
   * Instead of proxy wrapper URLs, generates direct Channels DVR URLs:
   * http://<ipAddress>:<port>/devices/ANY/channels/<channelNumber>/hls/master.m3u8?bitrate=<bitrate>
   */
  generateRemoteM3U(ipAddress = 'CH4C_IP_ADDRESS', port = '8089', bitrate = '5000') {
    // Get all enabled channels, sorted by channel number
    const enabledChannels = this.channels
      .filter(ch => ch.enabled !== false)
      .sort((a, b) => {
        const aNum = parseFloat(a.channelNumber) || 9999;
        const bNum = parseFloat(b.channelNumber) || 9999;
        return aNum - bNum;
      });

    let m3u = `#EXTM3U\n\n`;

    for (const ch of enabledChannels) {
      const tvgId = ch.id;
      const tvgName = ch.callSign || ch.name;
      const tvgLogo = ch.logo || '';
      const channelNum = ch.channelNumber || '';
      const genreMap = {
        'Entertainment': 'Drama',
        'Kids': 'Children',
        'Movies': 'Movies',
        'Sports': 'Sports',
        'News': 'News',
        'Drama': 'Drama',
        'Children': 'Children',
        'Other': null
      };
      const genre = genreMap[ch.category] !== undefined ? genreMap[ch.category] : 'Other';
      const displayName = ch.name;

      let guideAttribute = '';
      if (ch.stationId) {
        guideAttribute = ` tvc-guide-stationid="${ch.stationId}"`;
      } else if (ch.duration) {
        const durationSeconds = ch.duration * 60;
        guideAttribute = ` tvc-guide-placeholders="${durationSeconds}"`;
      }

      const genreAttribute = genre ? ` tvc-guide-genres="${genre}"` : '';
      const videoType = typeof ch.videoQuality === 'object' ? ch.videoQuality?.videoType : ch.videoQuality;
      const tagsAttribute = (videoType === 'HDTV' || videoType === 'SDTV') ? ` tvc-guide-tags="${videoType}"` : '';

      m3u += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${tvgLogo}"${guideAttribute} channel-number="${channelNum}"${genreAttribute}${tagsAttribute},${displayName}\n`;
      m3u += `http://${ipAddress}:${port}/devices/ANY/channels/${channelNum}/hls/master.m3u8?bitrate=${bitrate}\n\n`;
    }

    return m3u;
  }

  /**
   * Get manager status
   */
  getStatus() {
    const serviceStats = {};
    for (const serviceName of Object.keys(this.services)) {
      const serviceChannels = this.getChannelsByService(serviceName);
      serviceStats[serviceName] = {
        total: serviceChannels.length,
        enabled: serviceChannels.filter(ch => ch.enabled !== false).length
      };
    }

    return {
      totalChannels: this.channels.length,
      enabledChannels: this.channels.filter(ch => ch.enabled !== false).length,
      lastUpdate: this.lastUpdate,
      isRefreshing: this.isRefreshing,
      services: serviceStats
    };
  }
}

module.exports = { StreamingM3UManager };
