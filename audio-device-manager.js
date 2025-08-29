// Improved audio device detection and management for CH4C

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// log function with timestamp
function logTS(message , ...args) {
  const timestamp = new Date().toLocaleString();
  console.log(`[${timestamp}]`, message, ...args);
}

/**
 * Get all Windows audio devices using Core Audio API
 * This matches what Get-AudioDevice -List shows
 */
class AudioDeviceManager {
  constructor() {
    this.platform = os.platform();
    this.cachedDevices = null;
    this.cacheTimeout = 60000;
    this.lastCacheTime = 0;
  }

  /**
   * Main entry point - gets audio devices with multiple fallback methods
   */
  async getAudioDevices() {
    const now = Date.now();
    if (this.cachedDevices && (now - this.lastCacheTime) < this.cacheTimeout) {
      return this.cachedDevices;
    }

    if (this.platform !== 'win32') {
      console.log('Audio device detection only supported on Windows');
      return this.getDefaultDevices();
    }

    // Try methods in order of reliability
    const methods = [
      () => this.getDevicesViaWaveOut(),
      () => this.getDevicesViaWMI(),
      () => this.getDevicesViaPowerShellSimple(),
      () => this.getDefaultDevices()
    ];

    for (const method of methods) {
      try {
        const devices = await method();
        if (devices && devices.length > 0) {
          this.cachedDevices = devices;
          this.lastCacheTime = now;
          return devices;
        }
      } catch (error) {
        console.log(`Method failed: ${error.message}`);
      }
    }

    return this.getDefaultDevices();
  }

  /**
   * Method 1: Use waveOut API via PowerShell (most reliable)
   */
  async getDevicesViaWaveOut() {
    return new Promise((resolve, reject) => {
      // Create a temporary PowerShell script file to avoid escaping issues
      const tempScript = path.join(os.tmpdir(), `audio_devices_${Date.now()}.ps1`);
      
      const scriptContent = `
try {
  # Method 1: Try Get-AudioDevice first (most accurate when available)
  $devices = @()
  try {
    $audioDevices = Get-AudioDevice -List | Where-Object { $_.Type -eq "Playbook" -or $_.Type -eq "Playback" }
    foreach ($device in $audioDevices) {
      if ($device.Name -and $device.Name.Trim() -ne "") { 
        $devices += $device.Name.Trim()
      }
    }
    if ($devices.Count -gt 0) {
      $devices | ConvertTo-Json -Compress
      exit
    }
  } catch {
    Write-Host "Get-AudioDevice not available, trying alternative methods..."
  }
  
  # Method 2: Try to get full endpoint names using WMI and DirectShow
  try {
    # Get audio endpoints with full names using WMI Win32_PnPEntity
    $audioDevices = Get-WmiObject -Class Win32_PnPEntity | Where-Object { 
      $_.Name -match "audio" -or 
      $_.Name -match "HDMI" -or 
      $_.Name -match "Speaker" -or 
      $_.Name -match "Encoder" -or
      $_.Name -match "USB" -or
      $_.Name -match "MACROSILICON" -or
      $_.DeviceID -match "HDAUDIO" -or
      $_.DeviceID -match "USB\\\\VID" -or
      $_.Service -eq "HDAudBus" -or
      $_.Service -eq "usbaudio"
    }
    
    foreach ($device in $audioDevices) {
      if ($device.Name -and $device.Name.Trim() -ne "" -and $device.Name -notmatch "Generic") {
        $name = $device.Name.Trim()
        # Clean up common suffixes that don't help with identification
        $name = $name -replace "\\s*\\(.*High Definition.*\\)\\s*$", ""
        $name = $name -replace "\\s*- .*$", ""
        if ($name -and $name.Length -gt 3) {
          $devices += $name
        }
      }
    }
    
    if ($devices.Count -gt 0) {
      # Remove duplicates and sort
      $devices = $devices | Sort-Object -Unique
      $devices | ConvertTo-Json -Compress
      exit
    }
  } catch {
    Write-Host "PnP method failed, trying audio endpoint enumeration..."
  }
  
  # Method 3: Try PowerShell with Audio endpoint enumeration
  try {
    Add-Type -AssemblyName System.Core
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    using System.Text;
    
    public class SimpleAudioEnum {
        [DllImport("winmm.dll")]
        public static extern uint waveOutGetNumDevs();
        
        [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
        public static extern uint waveOutGetDevCaps(uint uDeviceID, out WAVEOUTCAPS pwoc, uint cbwoc);
        
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct WAVEOUTCAPS {
            public ushort wMid;
            public ushort wPid;
            public uint vDriverVersion;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]  // Increased size
            public string szPname;
            public uint dwFormats;
            public ushort wChannels;
            public ushort wReserved1;
            public uint dwSupport;
        }
        
        public static string[] GetDeviceNames() {
            uint numDevices = waveOutGetNumDevs();
            string[] devices = new string[numDevices];
            
            for (uint i = 0; i < numDevices; i++) {
                WAVEOUTCAPS caps;
                if (waveOutGetDevCaps(i, out caps, (uint)Marshal.SizeOf<WAVEOUTCAPS>()) == 0) {
                    devices[i] = caps.szPname ?? "";
                }
            }
            return devices;
        }
    }
"@
    
    $waveDevices = [SimpleAudioEnum]::GetDeviceNames()
    $devices = @()
    
    foreach ($device in $waveDevices) {
      if ($device -and $device.Trim() -ne "") {
        $devices += $device.Trim()
      }
    }
    
    if ($devices.Count -gt 0) {
      $devices | ConvertTo-Json -Compress
      exit
    }
  } catch {
    Write-Host "Enhanced WaveOut method failed, trying registry..."
  }
  
  # Method 4: Direct registry enumeration of audio endpoints
  try {
    $devices = @()
    $renderPath = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render"
    
    if (Test-Path $renderPath) {
      $deviceKeys = Get-ChildItem $renderPath
      
      foreach ($deviceKey in $deviceKeys) {
        try {
          $propsPath = Join-Path $deviceKey.PSPath "Properties"
          if (Test-Path $propsPath) {
            # Try to get the device description (different property)
            $desc = Get-ItemProperty -Path $propsPath -Name "{a45c254e-df1c-4efd-8020-67d146a850e0},2" -ErrorAction SilentlyContinue
            if ($desc -and $desc."{a45c254e-df1c-4efd-8020-67d146a850e0},2") {
              $deviceName = $desc."{a45c254e-df1c-4efd-8020-67d146a850e0},2"
              if ($deviceName -and $deviceName.Trim() -ne "") {
                $devices += $deviceName.Trim()
              }
            } else {
              # Fallback to friendly name
              $friendly = Get-ItemProperty -Path $propsPath -Name "{a45c254e-df1c-4efd-8020-67d146a850e0},14" -ErrorAction SilentlyContinue
              if ($friendly -and $friendly."{a45c254e-df1c-4efd-8020-67d146a850e0},14") {
                $deviceName = $friendly."{a45c254e-df1c-4efd-8020-67d146a850e0},14"
                if ($deviceName -and $deviceName.Trim() -ne "") {
                  $devices += $deviceName.Trim()
                }
              }
            }
          }
        } catch {
          # Skip this device
          continue
        }
      }
    }
    
    if ($devices.Count -gt 0) {
      $devices = $devices | Sort-Object -Unique
      $devices | ConvertTo-Json -Compress
      exit
    }
  } catch {
    Write-Host "Registry method failed, trying WMI..."
  }
  
  # Method 5: Standard WMI fallback
  try {
    $devices = @()
    Get-WmiObject -Class Win32_SoundDevice | ForEach-Object {
      if ($_.Name -and $_.Name.Trim() -ne "") {
        $devices += $_.Name.Trim()
      }
    }
    
    if ($devices.Count -gt 0) {
      $devices | ConvertTo-Json -Compress
      exit
    }
  } catch {
    Write-Host "All methods failed"
  }
  
  # Final fallback
  Write-Output "[]"
  
} catch {
  Write-Output "[]"
}
`.trim();

      // Write script to temporary file
      fs.writeFileSync(tempScript, scriptContent, 'utf8');

      exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempScript}"`,
        { encoding: 'utf8', windowsHide: true, timeout: 10000 },
        (error, stdout, stderr) => {
          // Clean up temp file
          try {
            fs.unlinkSync(tempScript);
          } catch (e) {
            // Ignore cleanup errors
          }

          if (error) {
            console.log('WaveOut method error:', error.message);
            reject(error);
            return;
          }

          // Process the full output - look for JSON content
          const fullOutput = stdout.trim();
          
          // Try to find JSON in the output (could be on any line)
          const lines = fullOutput.split('\n').map(line => line.trim()).filter(line => line);
          let jsonLine = null;
          
          // Look for a line that starts with '[' or contains JSON-like content
          for (const line of lines) {
            if (line.startsWith('[') || line.startsWith('"')) {
              jsonLine = line;
              break;
            }
          }
          
          // If no obvious JSON line found, try the last non-empty line
          const cleanOutput = jsonLine || lines[lines.length - 1] || '[]';
          
          try {
            // Handle both array and single string outputs
            let allDevices = [];
            const parsed = JSON.parse(cleanOutput);
            
            if (Array.isArray(parsed)) {
              allDevices = parsed;
            } else if (typeof parsed === 'string') {
              allDevices = [parsed];
            } else if (parsed && typeof parsed === 'object') {
              allDevices = Object.values(parsed);
            }

            // Filter to only actual audio devices
            const audioKeywords = [
              'speaker', 'headphone', 'audio', 'sound', 'hdmi', 'encoder', 
              'microphone', 'mic', 'realtek', 'nvidia', 'digital', 'analog',
              'bluetooth', 'wireless', 'usb audio', 'line'
            ];
            
            const devices = allDevices.filter(d => {
              if (!d || typeof d !== 'string' || d.trim().length === 0) return false;
              
              const deviceLower = d.toLowerCase();
              
              // Include if it contains audio keywords
              const hasAudioKeyword = audioKeywords.some(keyword => 
                deviceLower.includes(keyword)
              );
              
              // Exclude obvious non-audio devices
              const excludeKeywords = [
                'webcam', 'camera', 'controller', 'hub', 'root', 'composite',
                'input device', 'receiver', 'mouse', 'keyboard', 'bluetooth', 'wireless'
              ];
              
              const hasExcludeKeyword = excludeKeywords.some(keyword => 
                deviceLower.includes(keyword) && !deviceLower.includes('audio')
              );
              
              return hasAudioKeyword && !hasExcludeKeyword;
            });
            
            if (devices.length > 0) {
              logTS(`Found ${devices.length} audio devices via WaveOut`);
              devices.forEach(d => logTS(`  - ${d}`));
              resolve(devices);
            } else {
              reject(new Error('No audio devices found'));
            }
          } catch (parseError) {
            console.log('Failed to parse WaveOut output:', cleanOutput);
            reject(parseError);
          }
        });
    });
  }

  /**
   * Method 2: Use WMI (fallback)
   */
  async getDevicesViaWMI() {
    return new Promise((resolve, reject) => {
      exec('wmic sounddev get Name /format:list',
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }

          const devices = [];
          const lines = stdout.split('\n');
          
          lines.forEach(line => {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('Name=')) {
              const name = trimmedLine.substring(5).trim();
              if (name && name.length > 0 && name !== 'Name') {
                devices.push(name);
              }
            }
          });

          if (devices.length > 0) {
            console.log(`Found ${devices.length} audio devices via WMI`);
            devices.forEach(d => console.log(`  - ${d}`));
            resolve(devices);
          } else {
            reject(new Error('No devices found'));
          }
        });
    });
  }

  /**
   * Method 3: Simple PowerShell command
   */
  async getDevicesViaPowerShellSimple() {
    return new Promise((resolve, reject) => {
      // Very simple PowerShell that lists sound devices
      const script = 'Get-CimInstance Win32_SoundDevice | Select-Object -ExpandProperty Name';
      
      exec(`powershell -NoProfile -Command "${script}"`,
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }

          const devices = stdout.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('WARNING:') && !line.startsWith('ERROR:'));

          if (devices.length > 0) {
            console.log(`Found ${devices.length} audio devices via PowerShell`);
            devices.forEach(d => console.log(`  - ${d}`));
            resolve(devices);
          } else {
            reject(new Error('No devices found'));
          }
        });
    });
  }

  /**
   * Default devices as final fallback
   */
  getDefaultDevices() {
    console.log('Using default audio device names');
    const defaults = [
      'Speakers',
      'Headphones', 
      'HDMI',
      'Digital Audio',
      'Encoder',
      'USB Audio',
      'Microphone'
    ];
    return defaults;
  }

  /**
   * Find matching device with fuzzy matching for common typos
   */
  findDevice(searchTerm, devices) {
    if (!searchTerm || !devices || devices.length === 0) return null;
    
    const search = searchTerm.toLowerCase().trim();
    
    // Handle common typos
    const typoCorrections = {
      'endoder': 'encoder',
      'encorder': 'encoder',
      'encodor': 'encoder',
      'spekers': 'speakers',
      'headfones': 'headphones',
      'microphone': 'microphone'
    };
    
    const correctedSearch = typoCorrections[search] || search;
    
    // Try exact match with corrected term
    let device = devices.find(d => 
      d && d.toLowerCase() === correctedSearch
    );
    if (device) return device;
    
    // Try exact match with original term
    device = devices.find(d => 
      d && d.toLowerCase() === search
    );
    if (device) return device;
    
    // Try contains with corrected term
    device = devices.find(d => 
      d && d.toLowerCase().includes(correctedSearch)
    );
    if (device) return device;
    
    // Try contains with original term
    device = devices.find(d => 
      d && d.toLowerCase().includes(search)
    );
    if (device) return device;
    
    // Try word match with corrected term
    const correctedWords = correctedSearch.split(/\s+/);
    device = devices.find(d => {
      if (!d) return false;
      const deviceLower = d.toLowerCase();
      return correctedWords.some(word => deviceLower.includes(word));
    });
    if (device) return device;
    
    // Try word match with original term
    const searchWords = search.split(/\s+/);
    device = devices.find(d => {
      if (!d) return false;
      const deviceLower = d.toLowerCase();
      return searchWords.some(word => deviceLower.includes(word));
    });
    
    return device;
  }

  /**
   * Validate device with detailed logging
   */
  async validateDevice(searchTerm) {
    logTS(`Validating audio device: "${searchTerm}"`);
    
    try {
      const devices = await this.getAudioDevices();
      
      if (!devices || devices.length === 0) {
        console.log('No audio devices could be detected');
        return {
          valid: false,
          deviceName: null,
          error: 'No audio devices detected'
        };
      }

      const device = this.findDevice(searchTerm, devices);
      
      if (device) {
        logTS(`✓ Matched "${searchTerm}" to: "${device}"`);
        return {
          valid: true,
          deviceName: device
        };
      } else {
        logTS(`✗ No match found for "${searchTerm}"`);
        logTS(`Available devices: ${devices.join(', ')}`);
        
        // Suggest similar devices
        const suggestions = this.getSuggestions(searchTerm, devices);
        if (suggestions.length > 0) {
          console.log(`Did you mean: ${suggestions.join(', ')}?`);
        }
        
        return {
          valid: false,
          deviceName: null,
          available: devices,
          suggestions: suggestions
        };
      }
    } catch (error) {
      console.error('Error validating device:', error.message);
      return {
        valid: false,
        deviceName: null,
        error: error.message
      };
    }
  }

  /**
   * Get suggestions for similar device names
   */
  getSuggestions(searchTerm, devices) {
    if (!searchTerm || !devices) return [];
    
    const search = searchTerm.toLowerCase();
    const suggestions = [];
    
    // Find devices that share common words
    const searchWords = search.split(/\s+/);
    
    devices.forEach(device => {
      const deviceLower = device.toLowerCase();
      const deviceWords = deviceLower.split(/\s+/);
      
      // Check for partial matches
      const commonWords = searchWords.filter(word => 
        deviceWords.some(dWord => 
          dWord.includes(word) || word.includes(dWord)
        )
      );
      
      if (commonWords.length > 0) {
        suggestions.push(device);
      }
    });
    
    return [...new Set(suggestions)]; // Remove duplicates
  }
}

// Test function
async function testAudioDevices() {
  const manager = new AudioDeviceManager();
  
  console.log('Testing audio device detection...\n');
  console.log('System:', os.platform(), os.release());
  console.log('Node version:', process.version);
  
  try {
    const devices = await manager.getAudioDevices();
    
    if (devices && devices.length > 0) {
      console.log(`\nSuccessfully detected ${devices.length} audio devices:`);
      devices.forEach((d, i) => {
        console.log(`  ${i + 1}. ${d}`);
      });
      
      // Test matching including typos
      console.log('\nTesting device matching:');
      const tests = ['Encoder', 'Endoder', 'HDMI', 'Speakers', 'USB'];
      
      for (const test of tests) {
        const result = await manager.validateDevice(test);
        if (result.valid) {
          console.log(`  ✓ "${test}" → "${result.deviceName}"`);
        } else {
          console.log(`  ✗ "${test}" → Not found`);
          if (result.suggestions && result.suggestions.length > 0) {
            console.log(`    Suggestions: ${result.suggestions.join(', ')}`);
          }
        }
      }
    } else {
      console.log('No audio devices detected - using defaults');
    }
  } catch (error) {
    console.error('Test failed:', error);
  }
}

// Export
module.exports = {
  AudioDeviceManager,
  testAudioDevices
};

// Run test if this file is executed directly
if (require.main === module) {
  testAudioDevices().catch(console.error);
}