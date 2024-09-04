export const CHANNELS_URL = 'http://192.168.0.41'
export const CHANNELS_PORT = '8089'
export const ENCODER_STREAM_URL = 'http://192.168.107.9/live/stream0'
export const ENCODER_CUSTOM_CHANNEL_NUMBER = '24.42'
export const CH4C_PORT = 2442

export const NAMED_URLS = {
    nbc: 'https://www.nbc.com/live?brand=nbc&callsign=nbc',
    cnbc: 'https://www.nbc.com/live?brand=cnbc&callsign=cnbc',
    weatherscan: 'https://weatherscan.net/',
    windy: 'https://windy.com',
    nfl: 'https://www.nfl.com/plus/games/colts-at-bengals-2024-pre-3?mcpid=1888004',
}

export const START_PAGE_HTML = `
    <html>
    <title>Chrome HDMI for Channels</title>
    <h2>Chrome HDMI for Channels</h2>
    <p>Usage: <code>/stream?url=URL</code> or <code>/stream/&lt;name></code></p>
    <p>Example custom channels to load into Channels DVR:</p>
    <pre>
    #EXTM3U

    #EXTINF:-1 channel-id="windy",Windy
    http://<<host>>/stream/windy

    #EXTINF:-1 channel-id="weatherscan",Weatherscan
    http://<<host>>/stream?url=https://windy.com
    </pre>
    </html>
`

export const INSTANT_PAGE_HTML = `
    <html>
    <title>Chrome HDMI for Channels - Instant Record</title>
    <h2>Chrome HDMI for Channels - Instant Record</h2>
    <form method="POST" action="/instant">
        <label>Recording Name</label>
        <input type="text" name="recording_name" id="recording_name" />
        <br/>
        <label>URL to Record</label>
        <input type="text" name="recording_url" id="recording_url" />
        <br/>
        <label>Duration of Recording, Minutes</label>
        <input type="text" name="recording_duration" id="recording_duration" />
        <br/>
        <input type="submit" name="submit_button" value="Submit" />
      </form>
    </html>
`