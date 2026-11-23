# Site Notes

What each streaming site's player does that CH4C has to work around. Read a site's section before changing its handler in `main.js` (`fullScreenVideo<Site>`, with the play/video wait for some sites in `setupBrowserAudio`). Sites change their players often, so treat these as "true when last tested" and update them when you learn otherwise. Details that only matter inside one function belong in that function's comments, not here.

General patterns that apply to every site are in CLAUDE.md under Site Automation Patterns.

## Quick reference

| Site | Live detection | Live can rewind? | From Start | Fullscreen | Controls in shadow DOM |
|------|----------------|------------------|------------|------------|------------------------|
| Prime Video | URL has `type=live` (read before the player rewrites it) | Yes, scrubber | Yes (live + on-demand) | Player button, F fallback | No |
| Peacock | `/watch/playback/` but not `/watch/playback/vod/` | Yes, live div slider | Yes (live + on-demand) | F key | No |
| Disney+ | None reliable from the URL; live player shows a `live-button` | No | On-demand only | F, then retry with player button + foreground | Yes (Lit) |
| Apple TV+ | Version picker dialog on live events | Picker offers "Watch from Start" | Yes (live via picker, on-demand via scrubber) | Player button (`amp-playback-controls-full-screen`), F fallback | Likely (amp-* components) |
| Netflix | n/a (on-demand) | n/a | On-demand only (unchecked keeps the saved position) | Player button | No |
| Max | n/a | n/a | On-demand only (unchecked keeps the saved position; no live detection, so a live stream that reports a position past 5s would be rewound) | F key | No |

Not listed: sites whose handler just finds the video, unmutes and goes fullscreen (YouTube, Sling, DirecTV, ESPN, TBS/TNT, Discovery, Fox Sports and others). Linear channels (Sling, DirecTV, most TV Everywhere sites) are always live and never rewound.

## Prime Video (`amazon.com`)
- **Two ways in.** A detail page needs its play button clicked; for live events that opens a stream-selector modal whose Watch Live link has `t=2147483647`. A URL with `autoplay=1` (such as that Watch Live link, which Prime Video search returns) opens the player by itself, and clicking the detail page's play button on top of it reloads the player and leaves it paused.
- **Live detection:** `type=live` in the URL. The player drops it from the URL once it opens, so read it at the start of the handler.
- **Seek:** native `input[type="range"][aria-label="Seek"]`, only rendered while hovered. Clicking 3px in from the left lands a few tens of seconds after the start on a multi-hour event.
- **Search:** Amazon may redirect to a human-verification page (`/checkpoint/` in the URL, "I am human") on the storefront or when opening a result. Search checks for it and stops with an error asking for the check to be done through Remote Access (VNC); CH4C doesn't try to get past it. Loading a result's detail URL directly seemed to trigger it, so search clicks the first result with the mouse instead, and only loads the URL if the page doesn't change. Hovering a result card can expand it into a preview with its own Play button, so search checks the point under the mouse is still the result link before clicking.

## Peacock (`peacocktv.com`)
- **Fresh tab per stream:** a tab that has done many navigations gets sent to `/watch/error`, so each stream opens a new tab. Open the new tab before closing the old ones; closing the last tab can make Chrome exit.
- **Profile picker:** Peacock can redirect to `/watch/profiles` before or during playback; the video wait selects the first profile.
- **Privacy dialog:** a "Welcome to Peacock!" privacy choices dialog (`[data-testid="notification-Privacy"]`) can appear during startup; click its GOT IT button. It may reappear on every stream in a profile. It also shows on the profile picker, where it swallows the click on the profile tile, so search closes it before clicking the tile.
- **Audio:** can start muted and at volume 50. Use the player's mute button (`playback-mute-volume`, label "Unmute Sound") and the volume slider shown when hovering it (React range input: set it with the native value setter plus input/change events).
- **Seek:** on-demand uses `input[data-testid="scrubber-bar"]`; live uses a div slider, `.playback-scrubber-bar [role="slider"]`, whose `aria-valuetext` shows the position.
- **Live URLs** (`/watch/playback/live/<id>`) may also include 24/7 channels, which From Start would rewind if checked.
- **Search:** the search input can appear before Peacock's scripts are ready; they then reset it and the typed query is lost (seen about 1 in 5 on the test machine, more often on faster machines). Search reads the value back 1s after typing and retypes if it's gone. Clicking the first result can also be lost (the page stays on search), so search clicks it once more.
- **Episode lookup:** the episode list comes from the `atom.peacocktv.com/.../provider_series_id/...` response. Episode tiles can render before that response has been captured (seen on the slow test machine), so search keeps capturing for up to 10s until the requested episode shows up.

## Disney+ (`disneyplus.com`)
- **Lit components:** the player's controls (settings, timeline, fullscreen, live button) are inside shadow roots and only render while hovered. Three copies of some controls exist for different viewport widths; use the visible one.
- **Pre-roll ads:** an ad usually plays first (about 20 seconds in when CH4C checks), so the "resumed past 5s" seek runs against the ad and does nothing, and the first F press can be swallowed. Fullscreen is retried until confirmed.
- **Live fullscreen:** F doesn't work on live events, and the player's own fullscreen button is refused by Chrome ("not granted") unless the tab is in the foreground. The retry brings it forward (plus `AppActivate` on Windows) and clicks `button[data-qa="toggle-fullscreen.fullscreenButton"]`.
- **Ad breaks** change the `/play/` URL and swap in a new `<video>` element that plays to the default audio device. A monitor re-applies the encoder's device, quickly after each URL change.
- **Captions:** settings button → "Subtitles, <current>" item (its label shows the current track) → `role="radio"` track buttons; caption tracks have a `cc` badge. Look the settings button up again before clicking it to close the menu, because fullscreen moves it.
- **Live URLs** look like on-demand ones. The `contextId` parameter can contain `from_live`, but it's tracking data about where you clicked from, and search-built URLs don't have it. Live events can't be rewound.

## Apple TV+ (`tv.apple.com`)
- **Live events** open a version picker dialog (Watch Live / Catch Up / Watch from Start). CH4C picks Watch from Start when From Start is checked, otherwise Watch Live, matching the button label (`button[data-testid^="version-picker-cta"]`), and skips the scrubber seek.
- **On-demand** uses a capsule play button (`button[data-testid="capsule-button"]` with a `ResourceImagePlayGlyph` span, a progress bar and the time left as its label). Its handlers attach about 2 seconds after it appears, and a click can do nothing with the URL unchanged, so the click is retried until a video appears.
- Player controls are likely shadow-DOM components; the seek code pierces shadow roots.

## Netflix (`netflix.com`)
- No pre-roll ads, so the controls are available right away. Select captions before going fullscreen, not at the same time, because both use the controls.

## TBS / TNT (`tbs.com`, `tntdrama.com`)
- Provider sign-in has to run in a real popup: with a cached provider session, Adobe's `completeBackgroundLogin.html` needs `window.opener` to hand back the token.
- A free preview shows a "SIGN IN FOR FULL ACCESS" button; it's treated as logged out, so CH4C logs in instead of recording the preview.
- Dismiss the WBD "Legal Terms and Privacy" banner, and resume playback if the player is paused after fullscreen.

## History (`play.history.com`)
- When signed in, the page keeps its "Sign In" link (`a[href*="mvpd-auth"]`, the logged-out indicator) in the DOM but hidden. CH4C's in-stream logout checks only count a visible indicator; counting a hidden one flagged History as logged out on every tune, and the login then failed because it waits for a visible link.
- Fullscreen: a script `click()` on the player's "Show Fullscreen" button was reported as clicked but didn't take effect. The handler now clicks it with the real mouse while hovering, confirms `document.fullscreenElement`, and retries with the window brought to the foreground.

## Discovery (`play.discovery.com`)
- `go.discovery.com` now redirects to `play.discovery.com`. `/channel/<name>` URLs are no longer valid: they go to `/error` (an error with an OK button) whether or not you're signed in. Live channels are `/channel/watch/<id>/<id>`; Discovery's is `/channel/watch/94d97d27-d193-57ab-9d10-e9ffdc2e7c2e/ce3cc4f8-1a5d-599a-9ec2-b6577571c377`. The login check loads that and treats a redirect to `/error` as signed out (assumed; not yet seen signed out).
- Sign-in starts from the account icon at the top right (`button[data-testid="profile_button"]`), whose menu has a sign-in link to `/auth/providers`. Its text varies ("Sign In", "Sign in with TV Provider"), so it's matched by its href. The provider page's search box (`input[name="searchPartners"]`, inside a `gi-form-input` gisdk web component) is in shadow DOM, so it's found with a `pierce/` selector. The search results' markup wasn't captured when this was written, so CH4C clicks the first button or link whose text or label contains the provider name.
- Loading the home page signed out goes to `/consent-wall`, a legal terms page that stays until Agree is clicked. The WBD banner selector used for TBS/TNT doesn't match it, so the TVE flow clicks a visible button or link whose text starts with "Agree" while the URL is `/consent-wall`.
- Sign-in pages are under `/auth/`: the `/auth/providers` picker, then, after the provider signs in, `/auth/partner-sync?code=...&flow=provider`, which saves the provider link. Then `/auth/partner-authorize`, then `/auth/purchase-confirmation`, which says the sign-in succeeded and stays there. `providerPickerPath: '/auth/'` keeps the wait after clicking the provider going through the `/auth/` pages (leaving partner-sync early loses the link), and `providerSuccessPath` ends it at purchase-confirmation. With a saved Armstrong session no provider login screen appears; partner-sync comes about 4s after the click.
- Sign-in clicks use the real mouse only (`triggerMouseOnly`); other sites also send a script click on each trigger.
- Bot detection blocked the encoder's browser after a few manual and automated sign-in attempts in a row. Space out test runs. The block is an Akamai "Access Denied" page (HTTP 403, a reference number and an `errors.edgesuite.net` link) served on the very first page load, so it isn't caused by any click in that run. The login check stops with an error when it sees a 403 or that title, rather than running the sign-in against a blocked site.
