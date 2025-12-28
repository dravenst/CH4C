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

  /**
   * Add a custom channel
   */
  async addChannel(channelData) {
    const channel = this.normalizeChannel(channelData);
    this.channels.push(channel);
    console.log(`[CustomService] Added custom channel: ${channel.name}`);
    return channel;
  }

  /**
   * Remove a custom channel
   */
  async removeChannel(id) {
    const index = this.channels.findIndex(ch => ch.id === id);
    if (index !== -1) {
      const removed = this.channels.splice(index, 1)[0];
      console.log(`[CustomService] Removed custom channel: ${removed.name}`);
      return removed;
    }
    return null;
  }

  /**
   * Clear all custom channels
   */
  async clearAll() {
    const count = this.channels.length;
    this.channels = [];
    console.log(`[CustomService] Cleared ${count} custom channels`);
    return count;
  }
}

module.exports = { CustomService };
