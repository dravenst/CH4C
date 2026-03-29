# Chrome HDMI for Channels (CH4C)

This project merges elements of the excellent [Chrome Capture for Channels](https://github.com/fancybits/chrome-capture-for-channels) and [HDMI for Channels](https://github.com/tmm1/androidhdmi-for-channels) projects, in an attempt to capture benefits of each. It builds on the original idea from [ParksideParade](https://github.com/ParksideParade/CH4C).

**Compared to similar projects:**
- **vs CC4C**: This project can run on a much lower cost/performance PC by offloading the video encoding of one or more streams to an external hardware HDMI encoder(s)
- **vs Android HDMI for Channels (AH4C)**: This project can capture from any web URL with no dependency on an Android TV app or device

**Why I made this:**

- Recovering channels lost from TV Everywhere
- Recording web-only content (e.g., high school sports streaming websites without apps)
- Running on a low-cost PC (including Celeron-based machines running Channels DVR) with a relatively inexpensive external HDMI encoder like the Link Pi ENC1-V3 (~$120)

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Advanced Configuration](#advanced-configuration)
- [Web Interface](#web-interface)
  - [Home Page / Status Dashboard](#home-page--status-dashboard)
  - [Login Manager](#login-manager)
  - [Settings](#settings)
  - [M3U Manager](#m3u-manager)
  - [Instant Recording](#instant-recording)
  - [Remote Access](#remote-access)
- [Development](#development)
- [Performance Notes](#performance-notes)
- [License](#license)


---

## Requirements

### Hardware

- **Windows PC or Mac**: Most Windows PCs work well. macOS (Intel and Apple Silicon via Rosetta 2) is also supported. I run both Channels DVR and CH4C together on the same low-power Intel Celeron 5105 PC.
- **Encoder**: Recommended [Link Pi ENC1-v3](https://a.co/d/76zJF9U) with dual input ports (HDMI and USB). For the USB port, use an HDMI to USB adapter.
- **VNC Server** (for remote browser access):
  - **Windows**: Install [TightVNC](https://www.tightvnc.com/) and enable **loopback connections** so CH4C's built-in VNC viewer can connect locally.
  - **macOS**: Enable Screen Sharing in System Settings → General → Sharing. CH4C's built-in VNC viewer can connect to it at `127.0.0.1:5900`.

### Encoder Configuration

Follow the guidelines in the [Channels community thread](https://community.getchannels.com/t/linkpi-encoder-family/38860/4) to configure the encoders:

1. Connect your HDMI port(s) to the external encoder box
2. Set the encoder to 60fps or 30fps 1920x1080 (to match the streaming services), and test CBR/VBR/AVBR and bitrate (minimum 8,000 recommended) to your preference.  The secondary USB 2.0 LinkPi ENC1-v3 input only supports 30fps so set your encoder appropriately.
3. Set your display(s) to 1920x1080 @ 60Hz.  (Optionally on PC, in Intel Graphics Command Center, set Quantization Range to "Full" for better black levels)

See [example LinkPi encoder settings](./assets/linkpi-encoder-settings.jpg) for a recommended configuration.

---

## Installation

### Windows

Download `ch4c.exe` from the latest [release](https://github.com/dravenst/CH4C/releases).

### macOS

Download `ch4c` from the latest [release](https://github.com/dravenst/CH4C/releases). On first run, remove the quarantine flag added by macOS:

```bash
xattr -d com.apple.quarantine ch4c
chmod +x ch4c
./ch4c --help
```

### Running from Source (any platform)

```bash
git clone https://github.com/dravenst/CH4C
cd CH4C
npm install
node main.js --help
```

### Running CH4C at Startup

Install CH4C as a service that starts automatically at login:

```bash
ch4c service install          # or: node main.js service install
```

**Windows** — creates a Task Scheduler entry that runs CH4C at user logon with a 30-second startup delay. Requires **Administrator privileges**:
```powershell
powershell -Command "Start-Process cmd -ArgumentList '/k cd /d C:\path\to\CH4C && ch4c service install' -Verb RunAs"
```

**macOS** — installs a launchd agent at `~/Library/LaunchAgents/com.ch4c.plist`. No elevated privileges required:
```bash
node main.js service install
node main.js service install -d ~/ch4c-data   # custom data directory
```

**Other service commands** (Windows and macOS):

```bash
ch4c service status      # Check if installed and running
ch4c service start       # Start CH4C
ch4c service stop        # Stop CH4C gracefully
ch4c service uninstall   # Remove the service
```

> **Default data directory locations:**
> - **Windows**: `%APPDATA%\ch4c` (e.g. `C:\Users\<user>\AppData\Roaming\ch4c`). If a `data` folder exists in the CH4C install directory it will be used instead for backward compatibility.
> - **macOS**: `~/Library/Application Support/ch4c`
>
> A log message at startup will confirm which location is in use. Use `-d <path>` to specify a custom directory.

For manual startup configurations using PowerShell scripts or batch files, see [ADVANCED_CONFIG.md](ADVANCED_CONFIG.md).

---

## Getting Started

> **Important**: On Windows, do NOT run ch4c.exe or display/sound config-related commands in a Remote Desktop session. Video and audio sources will change when using Remote Desktop. Use VNC instead (e.g., [TightVNC](https://www.tightvnc.com/)). See [Remote Access](#remote-access) for the built-in VNC viewer. On macOS, use Terminal or enable Screen Sharing for remote access.

CH4C is configured through its built-in **Settings** web interface. The home page includes a step-by-step Getting Started guide. Here is an overview of the setup process:

### Step 1: Preparation

Before starting CH4C:

1. Connect your HDMI encoder(s) to the computer
2. Set display(s) to **1920x1080** and configure the encoder transport stream to match (recommended **30fps**)
3. **Windows**: Install a VNC server (e.g., [TightVNC](https://www.tightvnc.com/)) and enable **loopback connections** for remote browser access
   **macOS**: Enable Screen Sharing in System Settings → General → Sharing for remote browser access

### Step 2: Configure Settings

Launch CH4C and navigate to `http://<CH4C_IP>:2442/settings`:

1. Enter your **Channels DVR URL** (e.g., `http://192.168.50.50`)
2. Optionally configure the **HTTPS port** for secure remote access (a self-signed SSL certificate is auto-generated, see [HTTPS_SETUP.md](HTTPS_SETUP.md))
3. Click **Save Settings**

![Settings - Server Configuration](./assets/settings-server.jpg)

### Step 3: Add Encoder(s)

In Settings, click **+ Add Encoder** for each HDMI encoder:

1. Set the **Encoder URL** (e.g., `http://192.168.50.71/live/stream0`)
2. Select the **Audio Device** from the dropdown — CH4C automatically discovers available audio devices and presents them for selection. Choose "Default" to use the system default audio device. If your device doesn't appear, select **Other (manual entry)...** to type a partial device name manually (e.g., "Encoder" or "MACROSILICON").

   > **Note**: On **Windows**, for the most complete audio device listing, install the `AudioDeviceCmdlets` PowerShell module. Run this once in an **Administrator PowerShell**: `Install-Module -Name AudioDeviceCmdlets -Force`. CH4C falls back to registry and WMI-based detection if the module is unavailable. On **macOS**, audio devices are detected automatically via `system_profiler`.
3. For multi-monitor setups, set the **Screen X/Y Position** — use the **Screens** button to visually select a display, or the home page shows a Display Configuration visual with offsets for each monitor. Display scale must be set to 100% for correct positioning.
4. Click **Add Encoder**, then **Save Settings** and restart CH4C

| Add Encoder Form | Select Screen |
|:------------------:|:--------------:|
| ![Settings - Add Encoder](./assets/settings-add-encoder.jpg) | ![Encoder - Select Screen](./assets/encoder-select-screen.jpg) |

### Step 4: Add M3U Source to Channels DVR

1. In Channels DVR, go to Settings → Add Source → Custom Channels
2. Set Stream Format to **MPEG-TS**
3. Enter the M3U URL: `http://<CH4C_IP>:2442/m3u-manager/playlist.m3u`

![Custom Channel in Channels DVR](./assets/customchannelm3umgr.jpg)

### Step 5: Test the Encoder

1. Verify your encoder appears on the CH4C home page in the **Encoder Status** section with a healthy status
2. Try tuning to the encoder's channel in Channels DVR to confirm video and audio are working

### Step 6: Log In to Streaming Services

Use the **Login Manager** on the home page (`http://<CH4C_IP>:2442/`) to automatically log in to supported streaming services across all running encoder browsers at once. Select a service, enter credentials, and CH4C logs in to each encoder browser sequentially — skipping any that are already logged in.

For services not listed in the Login Manager, use [Remote Access](#remote-access) (`http://<CH4C_IP>:2442/remote-access`) to log in manually via VNC. Credentials are cached per encoder in the browser profile but services may periodically require re-authentication.

![Remote Access VNC Viewer](./assets/remoteaccess.jpg)

### Step 7: Add Channels

Use the [M3U Manager](#m3u-manager) (`http://<CH4C_IP>:2442/m3u-manager`) to build your channel lineup:

- **Refresh Sling TV** to automatically sync channels from the Sling TV guide
- **Add Custom Channel** for any streaming service URL (see [Sample Channel URLs](#sample-custom-channel-urls) below)

After adding channels, refresh the custom channel source in Channels DVR to pick up the new channels.

---

## Advanced Configuration

CH4C can also be configured via command-line parameters or a JSON configuration file for automated deployments or scripted setups. See [ADVANCED_CONFIG.md](ADVANCED_CONFIG.md) for details on CLI parameters, JSON configuration, display setup, and audio device setup.

---

## Web Interface

### Home Page / Status Dashboard

Navigate to `http://<CH4C_IP>:<CH4C_PORT>/` to view:
- Getting Started guide
- Encoder health and active streams
- Display configuration visual with screen offsets
- Available audio devices
- How CH4C Works overview

![Status Dashboard](./assets/newstatuspage.jpg)

### Login Manager

The Login Manager is on the home page (`http://<CH4C_IP>:<CH4C_PORT>/`). It automates logging in to streaming services across all currently-running encoder browsers in sequence, skipping any that are already authenticated.

For services not listed, use [Remote Access](#remote-access) to log in manually via VNC.

### Settings

Navigate to `http://<CH4C_IP>:<CH4C_PORT>/settings` to configure:
- Channels DVR server URL and port
- CH4C HTTP/HTTPS ports
- Add, edit, and remove encoders (URL, channel number, screen position, audio device)
- Data directory and monitoring options

![Settings Page](./assets/settings-page.jpg)

### M3U Manager

Navigate to `http://<CH4C_IP>:<CH4C_PORT>/m3u-manager` to:
- Synchronize the channel guide from Sling TV (Favorites only recommended)
- Add popular network channels from the Networks tab
- Create custom channels for any streaming service with deep links
- Search for station IDs by callsign or channel name

![M3U Manager Main](./assets/m3umanagermain.jpg)

**Refresh Sling TV to automatically sync channels from the Sling TV guide:**

![Refresh Sling Service](./assets/refreshslingservice.jpg)

**Add Custom Channel for any streaming service and look up the Station ID:**

| Add Custom Channel in M3U Manager | Station Lookup Option |
|:------------------:|:--------------:|
| ![Add Custom Channel](./assets/addcustomchannel.jpg) | ![Station Lookup](./assets/stationlookup.jpg) |

**Use the Networks tab to quickly add popular channels** You can also add any custom channel URL using the Add Custom Channel button.

![Networks Tab](./assets/m3unetworks.jpg)

See [samples.m3u](./assets/samples.m3u) for additional examples including Sling TV, NBC.com, Spectrum, and Peacock ([Peacock link format](https://community.getchannels.com/t/adbtuner-a-channel-tuning-application-for-networked-google-tv-android-tv-devices/36822/1895)).

**Create a new Custom Channel in Channels DVR using the playlist.m3u URL found in your M3U Manager main screen:**

![Custom Channel in Channels DVR](./assets/customchannelm3umgr.jpg)

### Instant Recording

Navigate to `http://<CH4C_IP>:<CH4C_PORT>/instant` to:
- Instantly start recording any URL and it will automatically try to enable full screen video
- Tune your encoder to a URL without recording (watch in Channels on the encoder's channel number)
- Add your own show metadata that will be visible in the Channels DVR Recordings
- **Show Search**: automatically look up a specific episode or movie from a supported streaming service and pre-fill all recording metadata (title, episode, duration, artwork, and direct watch URL)
- **Closed Captions**: select English or Off from the CC dropdown — CH4C will automatically open the player's subtitle menu and apply the selection after playback starts. Supported on Prime Video, Disney+, Peacock, and Max (HBO Max). If the CC menu is unavailable at startup (e.g., during pre-roll ads), CH4C retries in the background for up to 3 minutes.

Enter the show name and optionally an episode in the Show Search field, select a service, and click **Search**. The matching episode or movie details will be populated automatically — just select an encoder and start the recording.

![Instant Recording Page](./assets/instantpage.jpg)

### Remote Access

CH4C includes a built-in VNC viewer at `http://<CH4C_IP>:<CH4C_PORT>/remote-access` to connect to a VNC server running on your CH4C machine. This is used for logging in to streaming services in the encoder browsers.

For better clipboard functionality and security, enable HTTPS in [Settings](#settings). See [HTTPS_SETUP.md](HTTPS_SETUP.md) and [REMOTE_ACCESS_SETUP.md](REMOTE_ACCESS_SETUP.md) for details.

![Remote Access with VNC](./assets/remoteaccess.jpg)

---

## Development

### Setup

**Windows:**
```bash
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS

git clone https://github.com/dravenst/CH4C
cd CH4C
npm install
node main.js --help
```

**macOS:**
```bash
brew install node git   # or install from nodejs.org
git clone https://github.com/dravenst/CH4C
cd CH4C
npm install
node main.js --help
```

### Building

Build executables for all platforms (Windows x64 and macOS x64):
```bash
npm run build
```

Output is placed in the `dist/` folder:
- `ch4c.exe` — Windows
- `ch4c` — macOS (Intel and Apple Silicon via Rosetta 2)

---

## Performance Notes

This works surprisingly well, though streaming providers may have occasional glitches that prevent consistent loading.

**Additional notes:**
- **macOS**: Supported on Intel and Apple Silicon (via Rosetta 2). Audio device detection, display detection, service installation, and fullscreen streaming are all supported. Linux support is not currently implemented.
- **Display Scale**: Display scale must be set to **100%** for correct window positioning on both Windows and macOS.
- **HLS Support**: The examples use MPEG-TS, but HLS is also supported. Configure your encoder for HLS, update the Channels custom channel to use HLS, and adjust the encoder parameter to use the HLS stream URL
- **Secondary Channels DVR Server**: Channels allows you to export an M3U playlist from your primary Channels DVR server and import it into a secondary server to allow remote access for a second Channels DVR instance (e.g. if you only want to run a single CH4C instance and share with another device.). See the [Channels DVR Export Channels](https://getchannels.com/docs/channels-dvr-server/how-to/export-channels/) documentation for details on how to export and customize the M3U parameters. I highly recommend using Tailscale to create a private network to provide connectivity between your Channels DVR servers.

  Example M3U URL with customization parameters entered in Secondary Channels DVR as a new [Custom Channel](https://getchannels.com/docs/channels-dvr-server/how-to/custom-channels/) M3U Source:
  ```
  http://<TAILSCALE-CHANNELSDVR-IP>:8089/devices/<SOURCENAME>/channels.m3u?format=hls&bitrate=5000&codec=h264&acodec=copy
  ```
  Be sure to also setup the XMLTV Guide Data field too:
  ```
  http://<TAILSCALE-CHANNELSDVR-IP>:8089/devices/<SOURCENAME>/guide/xmltv?duration=1209600
  ```

---

## License

This project is licensed under the [ISC License](LICENSE).
