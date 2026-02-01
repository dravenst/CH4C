# CH4C Project Instructions

## Project Overview
Chrome HDMI for Channels (CH4C) is a Node.js application that captures web streams via Chrome/Chromium and routes them through external HDMI encoders for Channels DVR. It combines benefits of Chrome Capture for Channels and HDMI for Channels.

## Development Standards
- Use Node.js (no TypeScript - project uses vanilla JavaScript)
- Follow existing code patterns and naming conventions
- Always test with actual encoders when making streaming changes
- Focus on the Windows platforms, but may want to add Linux and Mac compatibility in the future.

## Build & Test Commands
- **Build**: `npm run build` (creates Windows executable using pkg)
- **Development**: `node main.js --help` to see usage options
- **Local install**: `npm install` to install dependencies

## Key Architecture
- **main.js**: Primary application entry point and Express server
- **error-handling.js**: Comprehensive error handling and recovery systems
- **audio-device-manager.js**: Cross-platform audio device management
- **constants.js**: Configuration constants and site-specific settings

## Project-Specific Context
- Uses `puppeteer-core` and `rebrowser-puppeteer-core` for bot detection avoidance
- Supports multiple external HDMI encoders (LinkPi ENC1-v3 tested)
- Browser instances are pooled per encoder for performance
- Audio routing requires platform-specific device name matching
- Supports major streaming platforms: NBC, NFL Network, Disney, Sling TV, Peacock, Spectrum

## Critical Requirements
- Always validate encoder connections before streaming operations
- Handle browser crashes gracefully with recovery mechanisms  
- Maintain user data directories per encoder for login persistence
- Screen positioning support for multi-monitor encoder setups
- Audio device validation and fallback to defaults

## Testing Notes
- Test on both Windows and Linux when possible
- Verify encoder health monitoring and recovery
- Test browser pool initialization and crash recovery
- Validate audio device detection across platforms
- Check site-specific authentication flows

## Common Issues to Avoid
- Don't assume audio devices exist - always validate and provide fallbacks
- Browser recovery must handle both page-level and browser-level crashes
- Encoder URLs must be validated before use in streaming operations
- Screen positioning calculations depend on platform-specific display metrics