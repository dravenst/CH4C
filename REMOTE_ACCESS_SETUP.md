# Remote Access Setup Guide

This guide explains how to set up remote browser access for CH4C using VNC.

> **Note for Developers:** If you're running CH4C from source (`node main.js`), you'll need to:
> 1. Run `npm install` to get dependencies (`ws` package)
> 2. Initialize the noVNC submodule: `git submodule init && git submodule update`
>
> The `.exe` release has everything bundled.

## Overview

The Remote Access feature allows you to view and control the CH4C browsers directly through your web admin interface, eliminating the need for a separate VNC client application.

> **⚠️ Critical Setup Requirement:** TightVNC blocks loopback (localhost) connections by default. You MUST enable loopback connections in TightVNC configuration or Remote Access will not work. See Setup Steps 1.1 below.

## Requirements

1. **TightVNC Server** (or compatible VNC server) installed on the CH4C server machine
2. **CH4C release build** - Download the latest `ch4c.exe` from [releases](https://github.com/dravenst/CH4C/releases) (all dependencies are bundled)

## Setup Steps

### 1. Install TightVNC Server

1. Download TightVNC Server from [https://www.tightvnc.com/download.php](https://www.tightvnc.com/download.php)
2. Install TightVNC Server (you don't need the Viewer component)
3. During installation, set a password for VNC connections
4. TightVNC will run on port 5900 by default

### 1.1. Enable Loopback Connections

**Important:** By default, TightVNC blocks loopback (localhost) connections. You must enable this:

1. Right-click the TightVNC icon in the system tray
2. Select "Configuration" or "Service Configuration"
3. Go to the "Access Control" or "Administration" tab
4. Check the option **"Accept loopback connections"** or **"Allow connections from localhost"**
5. Click "Apply" and "OK"
6. Restart TightVNC Server if prompted

### 2. Start CH4C

Run CH4C normally using the executable:

```powershell
ch4c.exe -s "http://YOUR_CHANNELS_IP" -e "http://YOUR_ENCODER_IP/live/stream0"
```

## Usage

1. Open your CH4C admin page (e.g., `http://localhost:2442/`)
2. Click the **"Remote Access"** button
3. Enter your TightVNC password
4. Optionally change the Port (default: 5900) if your VNC server uses a different port
5. Click **Connect**
6. You should now see the VNC desktop and can interact with browsers

## Troubleshooting

### Connection Failed

**Problem:** Cannot connect to VNC server or "loopback connections are not enabled" error

**Solutions:**
- **Most Common:** Enable loopback connections in TightVNC (see Setup Steps 1.1 above)
- Verify TightVNC Server is running (check system tray for the TightVNC icon)
- Check that port 5900 is not blocked by Windows Firewall
- Verify the VNC password is correct
- Ensure TightVNC Service is set to "Automatic" in Windows Services

### Button Does Nothing

**Problem:** Click "Connect" button but nothing happens

**Solutions:**
- Open browser Developer Tools (F12) and check the Console tab for errors
- Verify you're using a modern browser (Chrome, Edge, Firefox)
- Check that CH4C is running and the Remote Access page loaded correctly

### WebSocket Connection Failed

**Problem:** Error: "Connection failed" or WebSocket errors in browser console

**Solutions:**
- Check CH4C console output for WebSocket errors
- Verify CH4C is running and accessible at the displayed URL
- Check Windows Firewall is not blocking port 2442
- Try accessing from `http://localhost:2442/remote-access` instead of IP address

### Wrong VNC Password

**Problem:** "Authentication failed" message

**Solutions:**
- Double-check the VNC password you set during TightVNC installation
- Try reconnecting to TightVNC directly using TightVNC Viewer to verify password
- Reset the password in TightVNC Server settings if needed

## Security Notes

- The VNC connection uses password authentication
- WebSocket traffic is unencrypted by default (use HTTPS/WSS if exposing to the internet)
- VNC server listens on localhost only for security
- This is designed for local network access to troubleshoot and log into streaming sites

## Advanced Configuration

### Using a Different VNC Server

The setup works with any VNC server compatible with the RFB protocol:
- RealVNC
- UltraVNC
- TigerVNC

Just ensure it's listening on the configured port (default 5900).

### Changing VNC Port

If your VNC server runs on a different port (not 5900), simply enter the port number in the **Port** field on the Remote Access page before clicking Connect. The default port is 5900.

## Support

For issues or questions, please file an issue at:
https://github.com/dravenst/CH4C/issues
