## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked, but suggest obvious opportunities where similar updates might need to be made
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
- Web Admin UI needs to support phone, tablet, desktop

## Build & Verify
- **Build**: `npm run build` (Windows x64, macOS x64 and macOS arm64 executables in `dist/`, via `@yao-pkg/pkg`); `npm run build:win` for Windows only
- **Local install**: `npm install` to install dependencies
- **Syntax check**: `node --check main.js`, and `node -e "require('./constants.js')"` for the admin page HTML
- There's no automated test suite. Changes are verified by running them against the real site on a test machine and reading the logs, so have each automation step log what it found and did (`logTS`). One test run should show where a flow failed.
- Deploying to the test/prod machines, reading their logs and running test streams go through the `ch4c-deploy`, `ch4c-logs` and `ch4c-test-stream` skills in `.claude/skills/`; releases go through `ch4c-release`. The machine skills read details from a gitignored `CLAUDE.local.md`; its format is defined in `CLAUDE.local.example.md`.

## Key Architecture
- **main.js**: Entry point, HTTP routes, per-site search (`search<Site>`) and playback setup (`fullScreenVideo<Site>`, dispatched from `handleSiteSpecificFullscreen`)
- **constants.js**: Configuration constants, plus the admin pages' HTML/JS as template strings (`INSTANT_PAGE_HTML`, `SETTINGS_PAGE_HTML`, `LOGS_PAGE_HTML`, ...)
- **error-handling.js**: Error handling, retries and browser recovery
- **audio-device-manager.js**: Cross-platform audio device management
- **login-manager.js**: Per-site login automation
- **service-manager.js** / **ch4c-launcher.cs**: Windows service (and macOS launchd) install. On Windows the service runs the launcher, which starts CH4C in the user's session and starts it again 5 seconds after it exits.
- **services/**: M3U channel sources (Sling, DirecTV, custom)
- **logger.js**: `logTS`; the last 500 lines are served at `/api/logs`

## Project-Specific Context
- Uses `puppeteer-core` and `rebrowser-puppeteer-core` for bot detection avoidance
- Supports multiple external HDMI encoders
- Browser instances are pooled per encoder for performance
- Audio routing requires platform-specific device name matching
- Supported sites: `handleSiteSpecificFullscreen` in main.js is the source of truth (Amazon, Apple TV+, Disney+, ESPN, Max, Netflix, Peacock, Sling, YouTube, DirecTV, TBS/TNT and others)

## From Start (record from beginning vs. live)
- The instant page always sends `from_beginning=1` or `0`, passed to `/stream` as `fromstart=1|0`. Requests without it (M3U, Channels DVR, API) arrive as `null`.
- Handlers use three states: `false` → stay at the current/saved position; `null` on a live stream → stay live; on-demand (`null` or `true`) → seek to 0 if resumed past 5s; `true` on a live stream → seek to the start of the event, if the site allows rewinding.
- Implemented for Amazon and Peacock (on-demand and live) and Disney+ (on-demand only; its live streams can't be rewound). When adding a service, update the checkbox's hover text in `INSTANT_PAGE_HTML`, which lists them.

## Site Automation Patterns
- Before changing a site's handler, read that site's section in `SITE_NOTES.md` (live detection, rewinding, player quirks), and update it with anything new you learn.
- Drive the player's own controls with real mouse clicks rather than setting `video.currentTime` (breaks DRM sessions on some sites). Seek by clicking near the left end of the player's scrubber.
- Controls usually only render while the mouse hovers over the video, so hover first and retry the lookup.
- Some players put their controls in shadow DOM (Disney+ uses Lit components); use `pierce/` selectors or walk `shadowRoot`s.
- The F key and fullscreen buttons toggle. Confirm `document.fullscreenElement` before pressing again. Chrome refuses fullscreen ("not granted") when the tab isn't in the foreground; bring it forward first (`bringToFront`, plus `AppActivate` on Windows).
- Look an element up again right before clicking it: going fullscreen moves the layout, so a saved position can land on a different control.
- Ads interfere: a pre-roll can swallow key presses and seeks, and players can swap in a new `<video>` element at ad breaks, which loses its audio output device (`setSinkId`) and mute state.

## Editing main.js
- main.js is ~12,000 lines and each site's handler repeats near-identical blocks (seek-to-start, CC, unmute). Anchor every edit on text unique to that site's function, and check `git diff --stat` afterwards for unexpectedly large changes.

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
