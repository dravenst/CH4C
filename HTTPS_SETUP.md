# HTTPS Setup Guide

## Overview
CH4C supports optional HTTPS alongside HTTP using a separate port. HTTPS is useful for:
- Secure connections on your local network
- Full clipboard functionality in Remote Access (clipboard API requires HTTPS)
- Protection against local network sniffing

## Enabling HTTPS

To enable HTTPS, add the `--ch4c-ssl-port` (or `-t`) parameter when starting CH4C:

```bash
# HTTP on port 2442, HTTPS on port 2443
node main.js -s "http://192.168.1.10" -e "http://192.168.1.20/live/stream0" --ch4c-ssl-port 2443
```

Or using the shortcut:
```bash
node main.js -s "http://192.168.1.10" -e "http://192.168.1.20/live/stream0" -t 2443
```

**You can use any available port for HTTPS** (typically 2443, 8443, or 443 if you have permissions).

## Automatic Certificate Generation

When you start CH4C with `--ch4c-ssl-port`, it automatically:
1. Checks for existing SSL certificates in `data/` directory
2. If not found, generates self-signed certificates:
   - `data/cert.pem` - SSL certificate (10-year validity)
   - `data/key.pem` - Private key
   - **Auto-detects and includes all local network IP addresses**
   - Includes: localhost, 127.0.0.1, and your LAN IPs (192.168.x.x, 10.x.x.x, etc.)
3. Starts both HTTP and HTTPS servers:
   - HTTP: `http://localhost:2442/`
   - HTTPS: `https://localhost:2443/` (or your specified port)

### Additional Hostnames/IPs

If you need to include additional IP addresses or hostnames beyond the auto-detected ones, use the `--ssl-hostnames` (or `-n`) parameter:

```bash
node main.js -s "http://192.168.1.10" -e "http://192.168.1.20/live/stream0" -t 2443 -n "10.0.0.5,myserver.local,192.168.2.100"
```

This is useful for:
- Static IPs on different subnets
- Custom hostnames (e.g., "myserver.local")
- VPN IP addresses
- Additional interfaces not auto-detected

## Using HTTPS Without Browser Warnings

Self-signed certificates trigger browser security warnings. To avoid this, install the certificate as a trusted root certificate:

### Windows

**Method 1: Using Certificate Manager (Recommended)**
1. Press `Win + R`, type `certmgr.msc`, press Enter
2. Expand **Trusted Root Certification Authorities**
3. Right-click **Certificates**, select **All Tasks** → **Import...**
4. Click **Next**, then **Browse** and navigate to `data/cert.pem`
5. Change file filter to **All Files (*.*)** to see the .pem file
6. Select `cert.pem`, click **Open**, then **Next**
7. Ensure "Trusted Root Certification Authorities" is selected, click **Next**, then **Finish**
8. Restart your browser
9. Access `https://192.168.x.x:2443/` (using your IP) - no warnings!

**Method 2: Using File Explorer**
1. Locate the certificate file: `data/cert.pem`
2. Right-click `cert.pem` and select **Open with** → **Choose another app**
3. Select **Crypto Shell Extensions** or look for a certificate viewer
4. If not listed, try renaming to `cert.crt` temporarily, then double-click
5. Click **Install Certificate...**
6. Choose **Local Machine** (requires admin) or **Current User**
7. Select **Place all certificates in the following store**
8. Click **Browse** and select **Trusted Root Certification Authorities**
9. Click **Next**, then **Finish**
10. Restart your browser

### macOS

1. Open **Keychain Access** app
2. File → Import Items
3. Select `data/cert.pem`
4. Import to **System** keychain
5. Double-click the imported "CH4C Local Server" certificate
6. Expand **Trust** section
7. Set "When using this certificate" to **Always Trust**
8. Close and enter your password
9. Restart your browser

### Linux

```bash
# Ubuntu/Debian
sudo cp data/cert.pem /usr/local/share/ca-certificates/ch4c.crt
sudo update-ca-certificates

# Fedora/RHEL
sudo cp data/cert.pem /etc/pki/ca-trust/source/anchors/ch4c.crt
sudo update-ca-trust
```

Restart your browser after installation.

## Mobile Devices

To use HTTPS on mobile devices (phones, tablets):

1. Copy `data/cert.pem` to your device (email, cloud storage, etc.)
2. Open the file on your device
3. Follow the prompts to install the certificate
4. Trust the certificate in your device's security settings
5. Access CH4C via HTTPS using your computer's IP address

**Example:** `https://192.168.1.100:2442/`

## Regenerating Certificates

If you need to regenerate certificates (expired, compromised, etc.):

1. Stop CH4C
2. Delete the old certificates:
   ```bash
   rm data/cert.pem data/key.pem
   ```
3. Restart CH4C - new certificates will be generated automatically
4. Re-install the new certificate on all devices

## Disabling HTTPS

To disable HTTPS and use HTTP only:

1. Stop CH4C
2. Delete the certificate files:
   ```bash
   rm data/cert.pem data/key.pem
   ```
3. Restart CH4C
4. Only HTTP will be available

## Troubleshooting

### "Certificate Not Trusted" Warning

- **Cause:** Certificate not installed in trusted root store
- **Solution:** Follow the installation steps above for your OS

### "Connection Not Secure" in Browser

- **Cause:** Browser cache or certificate installation incomplete
- **Solution:**
  - Clear browser cache
  - Restart browser completely
  - Verify certificate is in "Trusted Root Certification Authorities"

### HTTPS Server Not Starting

- **Cause:** Port 2442 already in use by another HTTPS process
- **Solution:** HTTP will still work. Check what's using the port:
  ```bash
  # Windows
  netstat -ano | findstr :2442

  # Linux/Mac
  lsof -i :2442
  ```

### Remote Access Clipboard Still Not Working

- **Cause:** Accessing via HTTP instead of HTTPS
- **Solution:** Make sure to use `https://` in the URL (not `http://`)

## Technical Details

### Certificate Specifications

- **Algorithm:** RSA 2048-bit
- **Validity:** 10 years from generation
- **Common Name:** CH4C Local Server
- **Subject Alternative Names:**
  - localhost
  - 127.0.0.1
  - 0.0.0.0

### Why Self-Signed?

For local network use, self-signed certificates are:
- ✅ Free
- ✅ No external dependencies
- ✅ Work with IP addresses
- ✅ No domain name required
- ✅ Full control over certificate lifecycle

Let's Encrypt and other CA certificates require:
- ❌ Domain name
- ❌ Public internet access
- ❌ Regular renewal (90 days)
- ❌ Cannot use IP addresses directly

## Related Documentation

- [REMOTE_ACCESS_SETUP.md](REMOTE_ACCESS_SETUP.md) - VNC Remote Access setup
- [README.md](README.md) - Main CH4C documentation

## Security Notes

- Certificate files are stored in `data/` directory (excluded from git)
- Private key (`key.pem`) should never be shared
- Self-signed certificates are sufficient for local network use
- For public internet access, consider a reverse proxy with Let's Encrypt
