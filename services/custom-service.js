const { BaseService } = require('./base-service');

/**
 * Custom Service
 * Manages user-added custom channel entries
 * This is a special service that doesn't fetch from external sources
 */
class CustomService extends BaseService {
  constructor() {
    super('custom');
    this.channels = [];
  }

  /**
   * Fetch channels (returns stored custom channels)
   */
  async fetchChannels() {
    console.log('[CustomService] Returning custom channels');
    return this.channels;
  }
}

module.exports = { CustomService };
