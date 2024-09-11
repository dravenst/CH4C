# Chrome HDMI for Channels (CH4C) proof of concept

This is a proof of concept that merges elements of the excellent [Chrome Capture for Channels](https://github.com/fancybits/chrome-capture-for-channels) and [HDMI for Channels](https://github.com/tmm1/androidhdmi-for-channels) projects, in an attempt to capture benefits of each.

Specifically:
* vs CC4C: almost certainly 1080p/60
* vs HDMI for Channels: able to capture from any URL / no dependency on the site having an Android TV app

### My favorite use cases / why I made this
* Recovering channels that I lost from TV Everywhere - for example NFL Network
* Recording content that is web-only - for example my kid's high school streams sporting events on their website but doesn't have an app
* Getting non-linear content into Channels - for example I used to watch NFL+ game replays natively in the NFL app but the Channels app experience is so much better

## Getting started

### Hardware required
* **Video source**: I used a [Raspberry Pi5](https://www.raspberrypi.com/products/raspberry-pi-5/) but I think any CPU with HDMI out should work. You could even use your Channels box.
* **Encoder**: I used the [Link Pi v3](https://a.co/d/76zJF9U) with a single port.

### Config
* **Encoder**: I largely followed the guidelines [here](https://community.getchannels.com/t/linkpi-encoder-family/38860/4) to configure the encoder. Obviously connect the Pi and confirm that you're able to see and hear the Pi on the encoder's streaming URL before you go any further.
* **Pi**: on setup, I manually opened Chrome and visited each planned URL to complete any one-time cookie agreement popups and logins. I also removed the UBlock Origin extension, as that seemed to cause issues with some videos playing.
* **Channels DVR custom channel**: create a custom channel following the example in constants.START_PAGE_HTML. If it's a linear channel like NFL Network you can also map the channel so you get guide data.
* **constants.js**: update CHANNELS_URL, CHANNELS_PORT, and ENCODER_STREAM_URL to match your instance.

### Launching
I haven't built a packaged executable so you'll need to just git pull locally onto your machine and run with node. You should only need the [node](https://nodejs.org/en/learn/getting-started/how-to-install-nodejs) plus you'll have to install the [express](https://expressjs.com/en/starter/installing.html) and [puppeteer](https://pptr.dev/guides/installation) packages.

### Using
CH4C can be used two ways:
* **Custom channel**: using the custom channels that you created in Channels, simply use Channels to tune and record as you always would
* **Instant**: go to <CH4C_IP_ADDRESS>:<CH4C_PORT>/instant and you should see a simple UI to instantly start recording any given URL. Or you can just "tune" your dedicated encoder channel to that URL, so you can then watch in Channels on 24.42

## Results

### Performance
This all works surprisingly well for me. Video quality is constant 1080p/60. Channel changes are as fast as the time it takes to launch Chrome and load a page. And I’ve seen high reliability in my limited testing.

### Likely Failures / Things I Haven't Tested
* **Windows and Mac**: I've only tested on Pi5, so Windows and Mac might glitch. The likely error would be in finding your Chrome instance and user data. I copied the logic for finding Chrome from CH4C so hopefully it works!
* **Docker**: Same - I haven't tested at all but I copied from CH4C so hopefully it works!
* **NBC sites problem 1**: unfortunately on my Pi5 the NBC sites do not load in Chromium. Even when I just open Chromium as a normal user, the video doesn't play and I get some Widevine DRM related error. Hopefully you'll have more luck on a Win/Mac, and if you are able to load NBC sites on a Pi please let me know how to do it!
* **NBC sites problem 2**: I've also noticed even on my Windows machine that when I go to a NBC site I get a popup asking "Is Xfinity still your provider?". Even though I'm still logged into the site. So we'd have to figure out some way to have Pupeteer auto-click that popup.

## Gaps / next steps
### Packaged executable
Similar to CH4C, turn into a simple executable and docker deploy
### Support for multiple streams
If you had an encoder box with multiple HDMI ports, you could try two interesting things. First, since the Pi5 supports dual HDMI out, I think Pi should be able to open two Chrome browsers and send each browser+audio to a different HDMI. This would require some controller logic in the Bash script. Second would be the more advanced concept of using multiple Pi’s with controller logic across them.
### Co-hosting Channels and Chrome
If the box you’re running Channels on is headless, or supports a second HDMI out that you’re not using, I think you could have the Channels box itself be responsible for opening Chrome as the video source. And then the Channels box would HDMI out to the encoder, which would then feed back to Channels via the IP stream.
### Business opportunity
Imagine a Channels all-in-one box, analogous to the [Home Assistant Yellow](https://www.home-assistant.io/yellow/), that is essentially a Pi+Encoder. The Channels Box would seamlessly integrate both TV Everywhere and Chrome URLs, so if a channel drops from TVE then Channels would auto-switch to Chrome and we wouldn’t even notice!