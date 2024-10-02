# Chrome HDMI for Channels (CH4C) proof of concept

This is a proof of concept that merges elements of the excellent [Chrome Capture for Channels](https://github.com/fancybits/chrome-capture-for-channels) and [HDMI for Channels](https://github.com/tmm1/androidhdmi-for-channels) projects, in an attempt to capture benefits of each.

Specifically:
* **vs CC4C**: this proof of concept always delivers 1080p/60 by offloading the encode to an HDMI Encoder box
* **vs HDMI for Channels**: this proof of concept can capture from any URL with no dependency on the site having an Android TV app

### My favorite use cases / why I made this
* Recovering channels that I lost from TV Everywhere - for example NFL Network
* Recording content that is web-only - for example a high school sports streaming website that doesn't have an app
* Recording on-demand non-linear content - for example recording an NFL+ game replay
![Channels](https://github.com/user-attachments/assets/05306ac8-df2c-4f37-b29a-35a47d0dba19)

## Getting started

### Hardware required
* **Video source**: I used a [Raspberry Pi5](https://www.raspberrypi.com/products/raspberry-pi-5/) but any CPU with HDMI out should work. You could even use your Channels box.
* **Encoder**: I used the [Link Pi v3](https://a.co/d/76zJF9U) with a single port.

### Config
* **Video source**: on setup, I manually opened Chrome and visited each planned URL to complete any one-time cookie agreement popups and logins. I also removed the UBlock Origin extension, as that seemed to cause issues with some videos playing.
* **Encoder**: I largely followed the guidelines [here](https://community.getchannels.com/t/linkpi-encoder-family/38860/4) to configure the encoder. Obviously connect your video source to the encoder and confirm that you're able to see and hear on the encoder's streaming URL before you go any further.
* **constants.js**: update CHANNELS_URL, CHANNELS_PORT, and ENCODER_STREAM_URL to match your instance.
* **Channels DVR custom channel**: create a custom channel following the example in constants.START_PAGE_HTML. If it's a linear channel like NFL Network you can also map the channel so you get guide data. Note the special 24.42 channel which is used for the Instant Recording feature.
![CustomChannels](https://github.com/user-attachments/assets/840526e5-3cef-4cd2-95c5-50ac12a32fc9)

### Launching
I haven't built a packaged executable so you'll need to git clone locally onto your machine and run with node. You should only need to install [node](https://nodejs.org/en/learn/getting-started/how-to-install-nodejs), [express](https://expressjs.com/en/starter/installing.html), and [puppeteer-core](https://pptr.dev/guides/installation) packages.

### Using
CH4C can be used two ways:
* **Custom channel**: using the custom channels that you created in Channels, simply use Channels to tune and record as you always would
* **Instant**: go to <CH4C_IP_ADDRESS>:<CH4C_PORT>/instant and you should see a simple UI to instantly start recording any given URL. Or you can just "tune" your dedicated encoder channel to that URL, so you can then watch in Channels on channel number 24.42
![Instant](https://github.com/user-attachments/assets/2e527984-4c09-45f7-84dc-fc39b65e893d)

## Results

### Performance
This works surprisingly well for me, with the failure case usually being flakiness in Chrome loading the video through my Xfinity authorization. Video quality is consistent 1080p/60.

### Likely Failures / Things I Haven't Tested
* **Windows and Mac**: I've mainly tested on Pi5, and a bit on Windows, so Mac might glitch. The likely error would be in failing to find your Chrome instance and user data. I copied the logic for finding Chrome from CH4C so hopefully it works!
* **Docker**: Same - I haven't tested at all but I copied from CH4C so hopefully it works!
* **NBC sites problem 1**: unfortunately on my Pi5 the NBC sites do not load in Chromium. Even when I just open Chromium as a normal user, the video doesn't play and I get some Widevine DRM related error. Hopefully you'll have more luck on a Win/Mac, and if you are able to load NBC sites on a Pi please let me know how to do it!
* **NBC sites problem 2**: I've also noticed even on my Windows machine that when I go to a NBC site I get a popup asking "Is Xfinity still your provider?". Even though I'm still logged into the site. So I have to figure out some way to have Pupeteer auto-click that popup.

## Gaps / next steps
### Packaged executable
Similar to CH4C, turn into a simple executable and docker deploy
### Support for multiple streams
If you had an encoder box with multiple HDMI ports, you could implement multiple video sources with controller logic across them.
### Co-hosting Channels and Chrome
If the box you’re running Channels on is headless, or supports a second HDMI out that you’re not using, I think you could have the Channels box itself be responsible for opening Chrome as the video source. And then the Channels box would HDMI out to the encoder, which would then feed back to Channels via the IP stream.
### Business opportunity
Imagine a Channels all-in-one box, analogous to the [Home Assistant Yellow](https://www.home-assistant.io/yellow/), that is essentially a Pi+Encoder. The Channels Box would seamlessly integrate both TV Everywhere and Chrome URLs, so if a channel drops from TVE then Channels would auto-switch to Chrome and we wouldn’t even notice!