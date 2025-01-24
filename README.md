# Chrome HDMI for Channels (CH4C) proof of concept

This project merges elements of the excellent [Chrome Capture for Channels](https://github.com/fancybits/chrome-capture-for-channels) and [HDMI for Channels](https://github.com/tmm1/androidhdmi-for-channels) projects, in an attempt to capture benefits of each.

Specifically:
* **vs CC4C**: this project delivers 1080p by offloading one or more streams to an external HDMI Encoder(s)
* **vs HDMI for Channels**: this project can capture from any URL with no dependency on the site having an Android TV app

### My favorite use cases / why I made this
* Recovering channels that I lost from TV Everywhere - for example NFL Network
* Recording content that is web-only - for example a high school sports streaming website that doesn't have an app
* Recording on-demand non-linear content - for example recording an NFL+ game replay
![Channels](https://github.com/user-attachments/assets/05306ac8-df2c-4f37-b29a-35a47d0dba19)
* Can be run on a low cost PC with a relatively low cost external encoder e.g. Link Pi ENC1-V3 ~$120

## Getting started

### Hardware required
* **Video source**: It's lightweight enough to run on your existing Channels box or a separate server.  (Windows exe available too.)
* **Encoder**: I used the [Link Pi v3](https://a.co/d/76zJF9U) with a dual input ports - both hdmi and USB ports - using an [HDMI to USB card like this](https://www.amazon.com/dp/B0C2MDTY8P?ref=ppx_yo2ov_dt_b_fed_asin_title)

### Config
* **Encoder**: I largely followed the guidelines [here](https://community.getchannels.com/t/linkpi-encoder-family/38860/4) to configure the encoders (setting 30 fps can help with performance).  Connect your PC HDMI port(s) to the external encoder box and confirm that you're able to see and hear on the encoder's streaming URL before you go any further.  Make sure your PC config is set to 1920x1080 for the PC display(s).
* **Installation**:
Download the Windows exe `ch4c.exe` available in the latest [release](https://github.com/dravenst/CH4C/releases). You can create a ".ps1" file that can be used to run as a Windows startup task as outlined in the [chrome-capture thread](https://community.getchannels.com/t/chrome-capture-for-channels/36667/130)
* **Video source**: on first startup, you will have to manually complete any one-time logins for the sites triggered by CH4C. Each browser instance uses it's own user directory, so you will have to launch browsers through ch4c to get to sites.  Run via node or the ch4c.exe to make this happen.  

Or run `npm install` to install node packages if you're going to to run it via `node main.js`

* **Windows Startup Configuration**:
Create a new text file called `ch4c.ps1` and add the following line to it (replacing `(YOUR-PATH)` with your path to where you stored the .exe file, and replacing the IP of the channels url and encoder stream url with your config):
`Start-Process -WindowStyle hidden -FilePath "(YOUR-PATH)\ch4c.exe" -ArgumentList "--channels-url", "http://192.168.50.50", "--encoder-stream-url", "http://192.168.50.71/live/stream0"`

Create a new task to run the `ch4c.ps1` file in Windows Task Scheduler with the highest privileges, and set it to trigger it when the user logs on (it's critical to run after user login to enable the GPU).

Run the new Windows task you created manually to test it and be sure to visit all of the streaming sites within the browser that pops up after you try to stream your first channel.  This will allow you to login to the sites and retain the credentials for later runs. 

* **Run parameters**: 
It's required to pass in at least --channels-url and --encoder for your setup (see example below).  You can specify more than one encoder if you have multiple hdmi outputs available. 
e.g.
```
Usage: node main.js [options]

Options:
  -s, --channels-url   Channels server URL  [string] [required]
  -p, --channels-port  Channels server port  [string] [default: "8089"]
  -e, --encoder        Encoder configurations in format "url[:channel:width_pos:height_pos:audio_device]" where channel is optional (format: xx.xx, default: 24.42), width_pos/height_pos are optional screen positions (default: 0:0), and audio_device is the optional audio output device name  [array] [required]
  -c, --ch4c-port      CH4C port number  [number] [default: 2442]
  -h, --help           Show help  [boolean]

Examples:
  > main.js -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0"

  Simple example with channels server at 192.168.50.50 and single encoder at 192.168.50.71.
  

  > main.js -s "http://192.168.50.50" -e "http://192.168.50.71/live/stream0:24.42:0:0:Encoder" -e "http://192.168.50.72/live/stream1:24.43:1921:0:MACROSILICON"

  This sets the channels server to 192.168.50.50 and encoder to 192.168.50.71/live/stream0 and a second encoder at stream1. The 1921 position of stream1 moves it to the right on startup on screen 2 in a dual monitor setup.

  When specifying more than one encoder, you will need to find the audio device Name and specify the first portion of it at the end of the encoder param.  In Windows, to see encoder audio device names (example below), use powershell command Get-AudioDevice -List
```

* **Audio Setup**: Audio setup is tricky in a multi-encoder environment. You need to first identify the appropriate device names (e.g. look under Sound devices or use Powershell command below in Windows `Get-AudioDevice -List`).  Then use the first portion of the Name field at the end of the Encoder parameter.  If not specified, it will use the default audio device on the platform.

```
Example Powershell command to get list of audiooutput devices in Windows.  Note the Name fields.

PS C:\> Get-AudioDevice -List

Index                : 1
Default              : True
DefaultCommunication : False
Type                 : Playback
Name                 : Encoder (4- HD Audio Driver for Display Audio)
ID                   : {0.0.0.00000000}.{0a55cb4b-1124-4bd8-bc79-ce7f3ef5df1e}
Device               : CoreAudioApi.MMDevice

Index                : 2
Default              : False
DefaultCommunication : True
Type                 : Playback
Name                 : Headphones (KT USB Audio)
ID                   : {0.0.0.00000000}.{8d1ce611-6cf0-4739-b065-be7bdba9bc60}
Device               : CoreAudioApi.MMDevice

Index                : 3
Default              : False
DefaultCommunication : False
Type                 : Playback
Name                 : MACROSILICON (3- HD Audio Driver for Display Audio)
ID                   : {0.0.0.00000000}.{a14f146f-a40c-41fe-827e-f4f4e6ed3d00}
Device               : CoreAudioApi.MMDevice

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
### Business opportunity
Imagine a Channels all-in-one box, analogous to the [Home Assistant Yellow](https://www.home-assistant.io/yellow/), that is essentially a Pi+Encoder. The Channels Box would seamlessly integrate both TV Everywhere and Chrome URLs, so if a channel drops from TVE then Channels would auto-switch to Chrome and we wouldn’t even notice!