// update these to match your Channels instance and the
// streaming URL of your transcoder
export const CHANNELS_URL = 'http://192.168.0.41'
export const CHANNELS_PORT = '8089'
export const ENCODER_STREAM_URL = 'http://192.168.107.9/live/stream0'

// this is the custom channel number in Channels DVR that will be used
// for instant recordings. I used 24.42 because it's unique and
// spells CH4C on a telephone keypad. You shouldn't need to change this.
export const ENCODER_CUSTOM_CHANNEL_NUMBER = '24.42'
export const CH4C_PORT = 2442

export const START_PAGE_HTML = `
    <html>
    <title>Chrome HDMI for Channels</title>
    <h2>Chrome HDMI for Channels</h2>
    <p>Usage: <code>/stream?url=URL</code></p>
    <p>Create a custom channel in Channels DVR using the below as an example.<br>
    Be sure to choose "Prefer channel-number from M3U" and to replace<br>
    CH4C_IP_ADDRESS with the IP address of the server where you're running this code:
    </p>
    <pre>
    #EXTM3U

    #EXTINF:-1 channel-id="CH4C_Encoder" channel-number="${ENCODER_CUSTOM_CHANNEL_NUMBER}" tvc-guide-placeholders="3600",CH4C Encoder
    ${ENCODER_STREAM_URL}
    
    #EXTINF:-1 channel-id="CH4C_Weather" tvc-guide-placeholders="3600",Weatherscan
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream/?url=https://weatherscan.net/

    #EXTINF:-1 channel-id="CH4C_NFL_Network",NFL Network
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nfl.com/network/watch/nfl-network-live

    #EXTINF:-1 channel-id="CH4C_NFL_RedZone",NFL RedZone
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nfl.com/plus/redzone

    #EXTINF:-1 channel-id="CH4C_Bravo",Bravo
    http://CH4C_IP_ADDRESS:${CH4C_PORT}/stream?url=https://www.nbc.com/live?brand=bravo&callsign=BRAVOHP
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
        <input type="text" name="recording_url" id="recording_url" required />
        <br/>
        <label>Duration of Recording, Minutes</label>
        <input type="text" name="recording_duration" id="recording_duration" required />
        <br/>
        <input type="submit" name="button_record" value="Start Recording URL" />
        <input type="submit" name="button_tune" value="Tune ${ENCODER_CUSTOM_CHANNEL_NUMBER} to URL" />
      </form>
    </html>
`