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
* Can be run on a low cost PC with a relatively low cost external encoder

## Getting started

### Hardware required
* **Video source**: It's lightweight enough to run on your existing Channels box.  (Windows exe available too.)
* **Encoder**: I used the [Link Pi v3](https://a.co/d/76zJF9U) with a single port.

### Config
* **Video source**: on setup, I manually opened Chrome and visited each planned URL to complete any one-time cookie agreement popups and logins. I also removed the UBlock Origin extension, as that seemed to cause issues with some videos playing.
* **Encoder**: I largely followed the guidelines [here](https://community.getchannels.com/t/linkpi-encoder-family/38860/4) to configure the encoder. Obviously connect your video source to the encoder and confirm that you're able to see and hear on the encoder's streaming URL before you go any further.
* **Installation**:
Download Windows exe (ch4c.exe) available in Releases. You can create a ".ps1" file that can be used to run as a Windows startup task as outlined in the [chrome-capture thread](https://community.getchannels.com/t/chrome-capture-for-channels/36667/130)

Or run `npm install` to install node packages if you're going to to run it via `node main.js`
* **Run parameters**: 
It's required to pass in at least --channels-url and --encoder-stream-url for your setup (i.e. replace the IP addresses with your own) 
e.g.
```
node main.js -s="http://192.168.50.50" -e="http://192.168.50.71/live/stream0"

  -s, --channels-url                   Channels server URL [default: "http://192.168.50.50"]
  -p, --channels-port                  Channels server port [default: "8089"]
  -e, --encoder-stream-url             External Encoder stream URL [default: "http://192.168.50.71/live/stream0"]
  -n, --encoder-custom-channel-number  Custom channel number (format: xx.xx) [default: "24.42"]
  -c, --ch4c-port                      CH4C port number [default: 2442]
  -h, --help                           Show help        
  -v, --version                        Show version number
```

* **Channels DVR custom channel**: create a custom channel following the example in constants.START_PAGE_HTML. If it's a linear channel like NFL Network you can also map the channel so you get guide data. See the sample.m3u file for more examples. Note the special 24.42 channel which is used for the Instant Recording feature.
![CustomChannels](https://github.com/user-attachments/assets/840526e5-3cef-4cd2-95c5-50ac12a32fc9)

### Using
CH4C can be used in several ways:
* **Streaming channels**: supports nbc channels, NFL Network, Disney, Sling TV, Google Photos, and others available via web
* **Custom channel**: using the custom channels that you created in Channels, simply use Channels to tune and record as you always would
* **Instant**: go to <CH4C_IP_ADDRESS>:<CH4C_PORT>/instant and you should see a simple UI to instantly start recording any given URL. Or you can just "tune" your dedicated encoder channel to that URL, so you can then watch in Channels on channel number 24.42
![Instant](https://github.com/user-attachments/assets/2e527984-4c09-45f7-84dc-fc39b65e893d)

## Results

### Performance
This works surprisingly well for me, with the failure case usually being flakiness in Chrome loading the video through my Xfinity authorization. Video quality is consistent 1080p/60.

### Likely Failures / Things I Haven't Tested
* **Windows and Mac**: I've mainly tested on Pi5 and Windows, so Mac might glitch. The likely error would be in failing to find your Chrome instance and user data. I copied the logic for finding Chrome from CH4C so hopefully it works!
* **Docker**: Same - I haven't tested at all but I copied from CH4C so hopefully it works!
* **NBC sites problem 1**: unfortunately on my Pi5 the NBC sites do not load in Chromium. Even when I just open Chromium as a normal user, the video doesn't play and I get some Widevine DRM related error. Hopefully you'll have more luck on a Win/Mac, and if you are able to load NBC sites on a Pi please let me know how to do it!
* **NBC sites problem 2**: I've also noticed even on my Windows machine that when I go to a NBC site I get a popup asking "Is Xfinity still your provider?". Even though I'm still logged into the site. So I have to figure out some way to have Pupeteer auto-click that popup.

## Gaps / next steps
### Packaged executable
Similar to CH4C, create a Mac executable and docker deploy
### Support for multiple streams
If you had an encoder box with multiple HDMI ports, you could implement multiple video sources with controller logic across them.
### Co-hosting Channels and Chrome
If the box you’re running Channels on is headless, or supports a second HDMI out that you’re not using, I think you could have the Channels box itself be responsible for opening Chrome as the video source. And then the Channels box would HDMI out to the encoder, which would then feed back to Channels via the IP stream.
### Business opportunity
Imagine a Channels all-in-one box, analogous to the [Home Assistant Yellow](https://www.home-assistant.io/yellow/), that is essentially a Pi+Encoder. The Channels Box would seamlessly integrate both TV Everywhere and Chrome URLs, so if a channel drops from TVE then Channels would auto-switch to Chrome and we wouldn’t even notice!