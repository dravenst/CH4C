## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.


# CH4C Project Instructions
## Project Overview
Chrome HDMI for Channels (CH4C) is a Node.js application that captures web streams via Chrome/Chromium and routes them through external HDMI encoders for Channels DVR.

## Development Standards
- Use Node.js (no TypeScript - project uses vanilla JavaScript)
- Focus on the Windows and Mac platforms, but may want to add Linux compatibility in the future.

## Build & Test Commands
- **Build**: `npm run build` (creates Windows executable using pkg)
- **Local install**: `npm install` to install dependencies

## Key Architecture
- **main.js**: Primary application entry point
- **error-handling.js**: Comprehensive error handling and recovery systems
- **audio-device-manager.js**: Cross-platform audio device management
- **constants.js**: Configuration constants and site-specific settings

## Project-Specific Context
- Uses `puppeteer-core` and `rebrowser-puppeteer-core` for bot detection avoidance
- Supports multiple external HDMI encoders
- Browser instances are pooled per encoder for performance
- Audio routing requires platform-specific device name matching
- Supports major streaming platforms: NBC, NFL Network, Disney, Sling TV, Peacock, Spectrum

## Critical Requirements
- Handle browser crashes gracefully with recovery mechanisms  
- Maintain user data directories per encoder for login persistence

## Testing Notes
- Test on both Windows and Mac when possible
- Verify encoder health monitoring and recovery
- Test browser pool initialization and crash recovery
- Validate audio device detection across platforms
- Check site-specific authentication flows

## Common Issues to Avoid
- Don't assume audio devices exist - always validate and provide fallbacks
- Browser recovery must handle both page-level and browser-level crashes
