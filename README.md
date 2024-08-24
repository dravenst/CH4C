# Chrome HDMI for Channels (CH4C) proof of concept

This is a proof of concept that merges elements of the excellent [Chrome Capture for Channels](https://github.com/fancybits/chrome-capture-for-channels) and [HDMI for Channels](https://github.com/tmm1/androidhdmi-for-channels) projects, in an attempt to capture benefits of each.

Specifically:
* vs CC4C: easier to get high video resolution and frame rate, with tradeoff of requiring hardware purchase
* vs HDMI for Channels: able to capture from any URL, so no dependency on an app

### Hardware components in this proof of concept:
* Video source: I used a Pi5 but I think any Linux box with HDMI out should work.
* Encoder: I used the Link Pi v3 with a single port (more on this later)
* Channels DVR: mine is hosted on a different Linux box (more on this later)

### Software and config:
* Node script: 
* M3u file: this configures the various channels that you want to expose on your video source. My proof of concept exposes 2 channels, x and y.
* Channels DVR custom channel: the above m3u file is entered as a Custom Channel following the standard procedure.
* Encoder: I largely followed the guidelines here to configure the encoder.
* Pi: on setup, I manually opened Chome and visited each planned URL to get through any one-time cookie agreement popups and logins.


Shell2http: this is a lightweight web server that runs on the video source box, for the purpose of enabling Channels to call a URL that triggers the video source box to open the appropriate page in Chrome. This service auto-starts on the Pi via an entry in rc.local
Bash script: lightweight script on the video source box that 1) opens Chrome in kiosk mode to the URL specified in the parameter, and 2) returns the URL of the video stream from the encoder. Since I only have a single port on the encoder, the URL of the video stream from the encoder is always the same.
Full screen extension: this Chrome extension makes videos automatically go to fullscreen. I can’t vouch for every website, but it’s worked well for me on x and y

## Results:
This all works surprisingly well. Video quality is xx. Channel changes are x seconds, aka the time it takes to launch Chrome and load a page. And I’ve seen high reliability in my limited testing.

Gaps / next steps:
Support for multiple streams: if you had an encoder box with multiple HDMI ports, you could try two interesting things. First, since the Pi5 supports dual HDMI out, I think Pi should be able to open two Chrome browsers and send each browser+audio to a different HDMI. This would require some controller logic in the Bash script. Second would be the more advanced concept of using multiple Pi’s with controller logic across them.
More robust full screen: I don’t love relying on a Chrome extension so it would be great to find a more native way to force videos to go full screen. Relatedly, more robust protection against web pop-ups / overlays / etc that could distract from the video content.
Closing the browser: I don’t know how to “listen” to Channels tuning to know when Channels is no longer watching the channel and I can safely close the Chrome tab. For now the Chrome tab just stays open in perpetuity until the next request to watch a channel comes along.
Password management: ideally we’d save the logins for the paid URLs somewhere, and then automatically re-login in case Chrome gets logged out. Seems hard.
Co-hosting Channels and Chrome: if the box you’re running Channels on is headless, or supports a second HDMI out that you’re not using, I think you could have the Channels box itself be responsible for opening Chrome as the video source. And then the Channels box would HDMI out to the encoder, which would then feed back to Channels via the IP stream. Feels like a mobius strip.
Business opportunity: imagine a Channels all-in-one box, analogous to the Home Assistant Yellow, that was essentially a Pi+Encoder with the aforementioned mobius strip. The Channels Box would seamlessly integrate both TV Everywhere and Chrome URLs, so if a channel drops from TVE then Channels would auto-switch to Chrome and we wouldn’t even notice!

I’d love any thoughts and feedback. I’ve had a lot of fun lurking on the CC4C and HDMI for Channels threads for the past year and it’s been cool to get this proof of concept up and running.
