/**
 * Base Service Class
 * Abstract class for streaming service implementations
 */
class BaseService {
  constructor(serviceName) {
    this.serviceName = serviceName;
  }

  /**
   * Fetch channels from the streaming service
   * Must be implemented by subclasses
   * @returns {Promise<Array>} Array of channel objects
   */
  async fetchChannels() {
    throw new Error('fetchChannels() must be implemented by subclass');
  }

  /**
   * Normalize channel data to standard format
   */
  normalizeChannel(rawChannel) {
    return {
      id: rawChannel.id || `${this.serviceName}-${Date.now()}`,
      service: this.serviceName,
      name: rawChannel.name,
      displayName: rawChannel.displayName || rawChannel.name,
      streamUrl: rawChannel.streamUrl,
      channelNumber: rawChannel.channelNumber || null,
      category: rawChannel.category || 'Drama',
      logo: rawChannel.logo || '',
      callSign: rawChannel.callSign || rawChannel.name,
      enabled: true,
      metadata: rawChannel.metadata || {}
    };
  }
}

module.exports = { BaseService };
