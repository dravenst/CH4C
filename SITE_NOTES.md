# Site Notes

What each streaming site's player does that CH4C has to work around. Read a site's section before changing its handler in `main.js` (`fullScreenVideo<Site>`, with the play/video wait for some sites in `setupBrowserAudio`). Sites change their players often, so treat these as "true when last tested" and update them when you learn otherwise. Details that only matter inside one function belong in that function's comments, not here.

General patterns that apply to every site are in CLAUDE.md under Site Automation Patterns.

## Quick reference

| Site | Live detection | Live can rewind? | From Start | Fullscreen | Controls in shadow DOM |
|------|----------------|------------------|------------|------------|------------------------|
| Prime Video | URL has `type=live` (read before the player rewrites it) | Yes, scrubber | Yes (live + on-demand) | Player button, F fallback | No |
| Peacock | `/watch/playback/` but not `/watch/playback/vod/` | Yes, live div slider | Yes (live + on-demand) | F key | No |
| Disney+ | None reliable from the URL; live player shows a `live-button` | No | On-demand only | F, then retry with player button + foreground | Yes (Lit) |
| Apple TV+ | Version picker dialog on live events | Picker offers "Watch from Start" | Not yet (always picks Watch Live) | Player button (`amp-playback-controls-full-screen`), F fallback | Likely (amp-* components) |
| Netflix | n/a (on-demand) | n/a | Not yet (always seeks back if resumed) | Player button | No |
| Max | n/a | n/a | Not yet (always seeks back if resumed) | F key | No |

Not listed: sites whose handler just finds the video, unmutes and goes fullscreen (YouTube, Sling, DirecTV, ESPN, TBS/TNT, Discovery, Fox Sports and others). Linear channels (Sling, DirecTV, most TV Everywhere sites) are always live and never rewound.

## Prime Video (`amazon.com`)
- **Two ways in.** A detail page needs its play button clicked; for live events that opens a stream-selector modal whose Watch Live link has `t=2147483647`. A URL with `autoplay=1` (such as that Watch Live link, which Prime Video search returns) opens the player by itself, and clicking the detail page's play button on top of it reloads the player and leaves it paused.
- **Live detection:** `type=live` in the URL. The player drops it from the URL once it opens, so read it at the start of the handler.
- **Seek:** native `input[type="range"][aria-label="Seek"]`, only rendered while hovered. Clicking 3px in from the left lands a few tens of seconds after the start on a multi-hour event.
- **Search:** Amazon may show a human-verification page on the search screen. CH4C doesn't try to get past it.

## Peacock (`peacocktv.com`)
- **Fresh tab per stream:** a tab that has done many navigations gets sent to `/watch/error`, so each stream opens a new tab. Open the new tab before closing the old ones; closing the last tab can make Chrome exit.
- **Profile picker:** Peacock can redirect to `/watch/profiles` before or during playback; the video wait selects the first profile.
- **Privacy dialog:** a "Welcome to Peacock!" privacy choices dialog (`[data-testid="notification-Privacy"]`) can appear during startup; click its GOT IT button. It may reappear on every stream in a profile.
- **Audio:** can start muted and at volume 50. Use the player's mute button (`playback-mute-volume`, label "Unmute Sound") and the volume slider shown when hovering it (React range input: set it with the native value setter plus input/change events).
- **Seek:** on-demand uses `input[data-testid="scrubber-bar"]`; live uses a div slider, `.playback-scrubber-bar [role="slider"]`, whose `aria-valuetext` shows the position.
- **Live URLs** (`/watch/playback/live/<id>`) may also include 24/7 channels, which From Start would rewind if checked.

## Disney+ (`disneyplus.com`)
- **Lit components:** the player's controls (settings, timeline, fullscreen, live button) are inside shadow roots and only render while hovered. Three copies of some controls exist for different viewport widths; use the visible one.
- **Pre-roll ads:** an ad usually plays first (about 20 seconds in when CH4C checks), so the "resumed past 5s" seek runs against the ad and does nothing, and the first F press can be swallowed. Fullscreen is retried until confirmed.
- **Live fullscreen:** F doesn't work on live events, and the player's own fullscreen button is refused by Chrome ("not granted") unless the tab is in the foreground. The retry brings it forward (plus `AppActivate` on Windows) and clicks `button[data-qa="toggle-fullscreen.fullscreenButton"]`.
- **Ad breaks** change the `/play/` URL and swap in a new `<video>` element that plays to the default audio device. A monitor re-applies the encoder's device, quickly after each URL change.
- **Captions:** settings button → "Subtitles, <current>" item (its label shows the current track) → `role="radio"` track buttons; caption tracks have a `cc` badge. Look the settings button up again before clicking it to close the menu, because fullscreen moves it.
- **Live URLs** look like on-demand ones. The `contextId` parameter can contain `from_live`, but it's tracking data about where you clicked from, and search-built URLs don't have it. Live events can't be rewound.

## Apple TV+ (`tv.apple.com`)
- **Live events** open a version picker dialog (Watch Live / Catch Up / Watch from Start); CH4C clicks Watch Live. That's where From Start could hook in.
- **On-demand** uses a capsule play button whose handlers attach about 2 seconds after it appears.
- Player controls are likely shadow-DOM components; the seek code pierces shadow roots.

## Netflix (`netflix.com`)
- No pre-roll ads, so the controls are available right away. Select captions before going fullscreen, not at the same time, because both use the controls.

## TBS / TNT (`tbs.com`, `tntdrama.com`)
- Provider sign-in has to run in a real popup: with a cached provider session, Adobe's `completeBackgroundLogin.html` needs `window.opener` to hand back the token.
- A free preview shows a "SIGN IN FOR FULL ACCESS" button; it's treated as logged out, so CH4C logs in instead of recording the preview.
- Dismiss the WBD "Legal Terms and Privacy" banner, and resume playback if the player is paused after fullscreen.
