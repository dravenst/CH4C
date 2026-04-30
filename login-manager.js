'use strict';

const path = require('path');
const fs = require('fs');
const { logTS } = require('./logger');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Move the mouse along a cubic Bezier curve to avoid straight-line bot detection.
// startX/Y default to a random offset from the target when omitted.
async function bezierMouseMove(page, toX, toY, startX, startY) {
  const fromX = startX !== undefined ? startX : toX + (Math.random() * 300 - 150);
  const fromY = startY !== undefined ? startY : toY + (Math.random() * 200 - 100);
  const cp1x = fromX + (toX - fromX) * 0.3 + (Math.random() * 80 - 40);
  const cp1y = fromY + (toY - fromY) * 0.3 + (Math.random() * 80 - 40);
  const cp2x = fromX + (toX - fromX) * 0.7 + (Math.random() * 80 - 40);
  const cp2y = fromY + (toY - fromY) * 0.7 + (Math.random() * 80 - 40);
  const steps = 15 + Math.floor(Math.random() * 10);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = Math.pow(1-t,3)*fromX + 3*Math.pow(1-t,2)*t*cp1x + 3*(1-t)*t*t*cp2x + t*t*t*toX;
    const y = Math.pow(1-t,3)*fromY + 3*Math.pow(1-t,2)*t*cp1y + 3*(1-t)*t*t*cp2y + t*t*t*toY;
    await page.mouse.move(Math.round(x), Math.round(y));
    await delay(12 + Math.random() * 20);
  }
  await delay(80 + Math.random() * 120);
}

// ─── Site Configurations ────────────────────────────────────────────────────

const LOGIN_SITES = [
  // ── 1. Sling TV ───────────────────────────────────────────────────────────
  {
    id: 'sling',
    name: 'Sling TV',
    type: 'direct',
    // Navigate to home page first to avoid hitting /sign-in directly (bot detection).
    // Logged-out users stay on the home page; logged-in users are redirected to /home or /dashboard.
    // URL fallback: presence of /sign-in in URL = not logged in.
    checkUrl: 'https://www.sling.com/',
    loggedOutUrlFragment: '/sign-in',
  },
  // ── 2. DirecTV Stream ─────────────────────────────────────────────────────
  {
    id: 'directv',
    name: 'DirecTV Stream',
    type: 'direct',
    // DirecTV may redirect to auth.directv.com or another AT&T auth domain when not
    // logged in. pollForUrlRedirect polls the URL and also checks for a login form in
    // the DOM so it catches both a redirect-based and an inline-overlay login page.
    checkUrl: 'https://stream.directv.com/guide',
    // Match any redirect away from stream.directv.com (covers auth.directv.com, att.com, etc.)
    loggedOutUrlFragment: 'directv.com/sign',
    pollForUrlRedirect: true,
    checkLoginWaitMs: 12000,
  },
  // ── 3–14. Remaining sites (alphabetical) ──────────────────────────────────
  {
    id: 'abc',
    name: 'ABC',
    type: 'tve',
    // checkUrl is abc.com/ (home) rather than /watch-live because /watch-live SPA-redirects to
    // the stream content URL (/watch-live/784b058c-...) which has no Login button in the nav bar.
    // The home page has a stable nav with button.Login__button and span.LoginMenu__text.logged.
    checkUrl: 'https://abc.com/',
    // Logged in: "Manage TV Provider" span has class "logged" in the login dropdown.
    // Present in the DOM even when the dropdown is collapsed (added by the SPA after hydration).
    // <span class="LoginMenu__text logged">Manage TV Provider</span>
    loggedInIndicator: 'span.LoginMenu__text.logged',
    providerPageUrl: 'https://abc.com/watch-live',
    // Step 1: hover Login button to expand the CSS :hover dropdown
    // <button class="Login__button" aria-controls="login-menu">Log In</button>
    // Step 2: click "Link TV Provider" — an <a class="AnchorLink LoginMenu__item"> inside the dropdown
    // ("Manage TV Provider" is a <span class="LoginMenu__text logged">, not an <a>, so this is unambiguous)
    // <a class="AnchorLink LoginMenu__item" href="#">Link TV Provider</a>
    providerPageTriggers: [
      { selector: 'button.Login__button', hover: true },
      'a.LoginMenu__item',
    ],
    // Step 3: modal opens — click "More Providers" to reveal the search box
    // <button class="more-providers edition-button Button__primary"><span>more providers</span></button>
    providerPageTriggers2: ['button.more-providers'],
    // <input class="ProviderGrid--searchable__input" placeholder="Search">
    searchSelector: 'input.ProviderGrid--searchable__input, #ProviderGrid--searchable__input',
    // <li class="ProviderGrid--searchable__providers-list-item" title="Armstrong">Armstrong</li>
    resultSelector: 'li.ProviderGrid--searchable__providers-list-item',
    // After SAML completes, Disney's Adobe Pass system shows a "You've been signed in!" modal.
    // <button class="dismiss-button db" aria-label="ok, got it">OK, GOT IT</button>
    postSamlDismiss: 'button.dismiss-button.db',
    // After navigating to checkUrl the SPA needs time to read auth cookies and update the nav bar.
    // Poll for up to 10 s so the indicator has time to appear without triggering a false negative.
    checkLoginWaitMs: 10000,
    // The "Manage TV Provider" span is in the DOM after SPA hydration — hover the Login button
    // first to ensure the SPA has fully initialized the auth state in the nav bar.
    checkLoginPreHover: 'button.Login__button',
  },
  {
    id: 'amc',
    name: 'AMC',
    type: 'tve',
    checkUrl: 'https://www.amc.com/',
    // Not linked: "Sign in" button present in the nav header
    // <div class="sign-in-wrap"><span class="header-auth-button">Sign in</span></div>
    loggedOutIndicator: 'span.header-auth-button',
    providerPageUrl: 'https://www.amc.com/',
    // Clicking Sign in navigates to the TV provider search page
    providerPageTriggers: ['span.header-auth-button'],
    // <input placeholder="Search for your provider" type="text">
    searchSelector: 'input[placeholder="Search for your provider"]',
    // <li class="mvpd-option" role="menuitem"><span>Cox</span></li>
    resultSelector: 'li.mvpd-option[role="menuitem"]',
  },
  {
    id: 'cbs',
    name: 'CBS',
    type: 'tve',
    checkUrl: 'https://www.cbs.com/live-tv/stream/tveverywhere/',
    // Logged out: "More Providers" button present
    // <button class="filter" aria-haspopup="listbox" aria-expanded="false">More Providers</button>
    loggedOutIndicator: 'button.filter[aria-haspopup="listbox"]',
    providerPageUrl: 'https://www.cbs.com/live-tv/stream/tveverywhere/',
    // The "More Providers" dropdown is CSS :hover-based (li.pv-h:hover shows ul.content).
    // Hover the trigger button to open the dropdown; all provider items are pre-rendered in the
    // DOM regardless of dropdown state, so we use a DOM synthetic click (not a mouse click) to
    // select the provider. Moving the mouse to click would exit li.pv-h and collapse the dropdown.
    providerPageTriggers: [{ selector: 'button.filter', hover: true }],
    searchSelector: null, // CBS has no search box — match by aria-label in the expanded list
    // <li role="option"><a href="#" data-providerid="auth_armstrongmywire_com" aria-label="Armstrong">
    resultSelector: 'li[role="option"] a[data-providerid], li[role="option"] a.vue-focusable',
    // Use DOM synthetic click for results: avoids mouse movement that collapses the CSS :hover
    // dropdown. Providers far down the alphabetical list don't need scrolling with DOM click.
    domClickResult: true,
    // After SAML completes, CBS shows a success overlay with a "Start Watching" CTA.
    // <span class="button__text">Start Watching</span>
    // Click it to dismiss the overlay and confirm the auth is finalised before checkLogin.
    postSamlDismiss: 'span.button__text',
  },
  {
    id: 'discovery',
    name: 'Discovery',
    type: 'tve',
    checkUrl: 'https://go.discovery.com/',
    // Logged out: "Link TV Provider" anchor present
    // <a aria-label="Link TV Provider" href="https://auth.go.discovery.com/login-affiliates?...">
    loggedOutIndicator: 'a[aria-label="Link TV Provider"]',
    providerPageUrl: 'https://go.discovery.com/',
    // Trigger navigates to a new page (auth.go.discovery.com) — full page navigation
    providerPageTriggers: ['a[aria-label="Link TV Provider"]'],
    searchSelector: 'input#searchPartners, input.search-input__input__3kbc2, input[aria-label*="TV provider" i]',
    resultSelector: 'ul.affiliate-picker-list__all-partners__2VJgq li button, button.affiliate-partner__link__F4Zt_',
  },
  {
    id: 'disney',
    name: 'Disney+',
    type: 'direct',
    // Navigate to disneyplus.com/home. Two "not logged in" signals are checked each poll:
    // 1. URL redirect: unauthenticated browsers are JS-redirected to disney.com (~5s).
    //    'www.disney.com' does NOT match 'www.disneyplus.com', so this is unambiguous.
    // 2. Element: LOG IN button in DOM while still on disneyplus.com.
    //    <a href="/identity/login" data-testid="log_in">LOG IN</a>
    //    page.$() detects DOM presence regardless of modal overlays.
    checkUrl: 'https://www.disneyplus.com/home',
    loggedOutIndicator: 'a[data-testid="log_in"]',
    loggedOutUrlFragment: 'www.disney.com',
    // Unauthenticated users may see a sign-up offer modal — dismiss it each polling cycle.
    // <button aria-label="Close modal">...</button>
    dismissPopup: 'button[aria-label="Close modal"]',
    // SPA takes several seconds to hydrate; redirect to disney.com takes ~5s
    checkLoginWaitMs: 8000,
  },
  {
    id: 'disneynow',
    name: 'Disney Now',
    type: 'tve',
    checkUrl: 'https://disneynow.com',
    // Logged in: provider logo image shown in nav
    // <div class="navigation__img provider-logo"><img class="navigation__provider" ...></div>
    loggedInIndicator: 'div.navigation__img.provider-logo',
    providerPageUrl: 'https://disneynow.com/my-settings/tv-providers',
    providerPageTriggers: [],
    // Dismiss the intro lightbox popup if it appears
    dismissPopup: 'div.lightbox__closebtn__wrap',
    searchSelector: 'input.SearchBar__input, input[placeholder="Search"]',
    resultSelector: '.SearchBar__results-item',
    // Use keyboard navigation (ArrowDown+Enter) to select the provider result.
    // Avoids Adobe Pass bot-detection logic that fires on mouse click events
    // and causes SAML to redirect back to tv-providers instead of a success page.
    keyboardSelect: true,
    // After the SAML chain returns to the service domain, trust that auth succeeded.
    // Disney Now's frontend makes async Adobe Pass API calls to determine linked-provider
    // status and render the nav logo — this takes several seconds and makes DOM-based
    // checkLogin unreliable immediately after SAML.
    trustSamlCompletion: true,
    // How long to keep the tab open after SAML completes so Adobe Pass SDK can write
    // the auth token to localStorage before the tab is closed.
    samlSettleDelay: 8000,
  },
  {
    id: 'espn',
    name: 'ESPN',
    type: 'tve',
    checkUrl: 'https://www.espn.com/watch/player?network=espn',
    // Logged out: paywall "Sign in with TV provider" button present
    // <button class="Welcome__Button--mvpd">
    loggedOutIndicator: 'button.Welcome__Button--mvpd',
    providerPageUrl: 'https://www.espn.com/watch/player?network=espn',
    // "Sign in with TV provider" opens the WatchProvider panel.
    // providerPageTriggers2 fires only if the search box isn't visible after the primary trigger —
    // the panel sometimes opens already expanded (button says "Back"), in which case the click is skipped.
    providerPageTriggers: ['button.Welcome__Button--mvpd'],
    providerPageTriggers2: ['button.WatchProvider__Button'],
    // <input id="WatchProvider__Search" type="search" placeholder="Search...">
    searchSelector: '#WatchProvider__Search',
    // <ul class="WatchProvider__Affiliates"><li class="WatchProvider__Affiliate__Item"><a href="#">Armstrong</a></li></ul>
    resultSelector: 'li.WatchProvider__Affiliate__Item a, .WatchProvider__Affiliates li a',
  },
  {
    id: 'fox',
    name: 'Fox',
    type: 'tve',
    checkUrl: 'https://www.fox.com/',
    // Not logged in: "TV Provider" button visible in nav
    // <button data-analytics="main-landing-tvprovider-button" ...>TV Provider</button>
    // When a provider is linked this button is absent
    loggedOutIndicator: 'button[data-analytics="main-landing-tvprovider-button"]',
    providerPageUrl: 'https://www.fox.com/',
    // Clicking "TV Provider" navigates to the provider selection page
    providerPageTriggers: ['button[data-analytics="main-landing-tvprovider-button"]'],
    // <input placeholder="Search for a provider" type="text">
    searchSelector: 'input[placeholder="Search for a provider"]',
    // <button data-analytics="mvpd-page-select-mvpd" ...>Armstrong</button>
    resultSelector: 'button[data-analytics="mvpd-page-select-mvpd"]',
  },
  {
    id: 'foxsports',
    name: 'Fox Sports',
    type: 'tve',
    checkUrl: 'https://www.foxsports.com/live/fs1',
    // Not logged in: "Sign in with TV Provider" is present as either:
    //   a link (normal):           <a class="uc cl-wht pvp-mvpd-link pd-l-20" href="/provider/register">
    //   a button (preview expired): <button class="link-button pvp-cta cl-wht fs-14">
    // If neither is in the DOM → provider is already linked (logged in).
    loggedOutIndicator: 'a.pvp-mvpd-link, button.pvp-cta',
    providerPageUrl: 'https://www.foxsports.com/live/fs1',
    // Click whichever "Sign in with TV Provider" element is present.
    // It is a page-navigating link/button — navigates to
    //   https://www.foxsports.com/provider/register?fu=https://www.foxsports.com/live/fs1
    providerPageTriggers: ['a.pvp-mvpd-link, button.pvp-cta'],
    // <input type="text" class="input-text input-bar cl-blk" placeholder="Search a provider">
    searchSelector: 'input.input-text.input-bar, input[placeholder="Search a provider"]',
    // <div class="searched">
    //   <div class="search-results ..."> Search Results </div>
    //   <div><h2 class="mvpd-provider fs-20 cl-gr-2">Armstrong</h2></div>
    // </div>
    resultSelector: 'h2.mvpd-provider, .searched .mvpd-provider',
    // After SAML completes Fox Sports redirects back to:
    //   https://www.foxsports.com/live/fs1#no_universal_links
    // which is the same origin as checkUrl — standard checkLogin works fine.
  },
  {
    id: 'fx',
    name: 'FX / FXX / FXM',
    type: 'tve',
    // Same Disney/Adobe Pass auth system as ABC — identical nav bar, dropdown, and modal.
    // checkUrl is the home page (not /watch-live) to avoid SPA redirect to stream content URL.
    checkUrl: 'https://fxnow.fxnetworks.com/',
    // Logged in: "Manage TV Provider" span gets class "logged" after SPA hydrates auth cookies.
    // <span class="LoginMenu__text logged">Manage TV Provider</span>
    loggedInIndicator: 'span.LoginMenu__text.logged',
    providerPageUrl: 'https://fxnow.fxnetworks.com/watch-live',
    // Step 1: hover Login button to expand the CSS :hover dropdown
    // <button class="Login__button" aria-label="Log In Drop-down collapsed" aria-controls="login-menu">
    // Step 2: click "Link TV Provider"
    // <a class="AnchorLink LoginMenu__item" href="#"><span class="LoginMenu__text">Link TV Provider</span></a>
    providerPageTriggers: [
      { selector: 'button.Login__button', hover: true },
      'a.LoginMenu__item',
    ],
    // Step 3: modal opens — click "More Providers" to reveal the search box
    // <button class="more-providers edition-button Button__primary"><span>more providers</span></button>
    providerPageTriggers2: ['button.more-providers'],
    // <input class="ProviderGrid--searchable__input db" id="ProviderGrid--searchable__input" placeholder="Search">
    searchSelector: 'input.ProviderGrid--searchable__input, #ProviderGrid--searchable__input',
    resultSelector: 'li.ProviderGrid--searchable__providers-list-item',
    postSamlDismiss: 'button.dismiss-button.db',
    checkLoginWaitMs: 10000,
    checkLoginPreHover: 'button.Login__button',
  },
  {
    id: 'hbomax',
    name: 'HBO Max',
    type: 'direct',
    // Navigate to hbomax.com; logged in when the Sign In link is absent from the header.
    // <a id="header-secondary-cta" href="https://auth.hbomax.com/login?flow=login">Sign In</a>
    // The link is only rendered when the user is not authenticated.
    checkUrl: 'https://www.hbomax.com/',
    loggedOutIndicator: 'a#header-secondary-cta',
    // HBO Max SPA takes a few seconds to settle auth state after page load
    checkLoginWaitMs: 5000,
  },
  {
    id: 'history',
    name: 'History Channel',
    type: 'tve',
    checkUrl: 'https://play.history.com/live',
    // Not linked: Sign In anchor present (href contains "mvpd-auth")
    // <a href="https://www.history.com/mvpd-auth?redirect_url=...">Sign In</a>
    loggedOutIndicator: 'a[href*="mvpd-auth"]',
    providerPageUrl: 'https://play.history.com/live',
    // On first visit a Terms of Use banner may appear — dismiss it before proceeding
    // <button data-testid="tou-agree-btn">Accept & Close</button>
    dismissPopup: 'button[data-testid="tou-agree-btn"]',
    // Clicking Sign In navigates to the TV provider selection page
    providerPageTriggers: ['a[href*="mvpd-auth"]'],
    // On the provider page, click "More TV Providers" to reveal the search input
    // <a href="#" aria-label="Show more TV providers">More TV Providers</a>
    providerPageTriggers2: ['a[aria-label="Show more TV providers"]'],
    // <input id="search-field" placeholder="Search for your TV Provider" type="search">
    searchSelector: 'input#search-field, input[placeholder="Search for your TV Provider"]',
    // <a data-mvpd-id="auth_armstrongmywire_com" href="#" role="button" aria-label="Sign in with Armstrong">
    resultSelector: 'a[data-mvpd-id][role="button"]',
  },
  {
    id: 'nbc',
    name: 'NBC / Bravo',
    type: 'tve',
    checkUrl: 'https://www.nbc.com/live',
    // Logged out: "Link TV Provider" nav link present
    // <a href="/mvpd-picker"> in .navigation__item--mvpd
    loggedOutIndicator: '.navigation__item--mvpd a[href="/mvpd-picker"]',
    providerPageUrl: 'https://www.nbc.com/mvpd-picker',
    providerPageTriggers: [],
    // NBC shows a "Is [Provider] still your TV Provider?" modal when a provider was
    // previously linked. Click Yes to confirm and trigger SAML directly (skipping search).
    // If the modal shows a different provider, click No and fall through to the search box.
    confirmModal: {
      modalSelector: 'div.mvpd-modal',
      providerNameSelector: 'div.mvpd-modal h2 span',  // the <span>Armstrong</span> in the heading
      yesSelector: 'button.button.mvpd-modal__cta',
      noSelector: 'button.button.mvpd-modal__cta--cancel',
    },
    searchSelector: 'input.mvpd-predictive__input, input[placeholder="Type provider name to search"]',
    resultSelector: '[class*="predictive"] li, [id*="predictive"] li, [class*="mvpd"] li',
    trustSamlCompletion: true,
    // NBC opens its Adobe Pass SAML auth in a popup via window.open(). Puppeteer's
    // evaluateOnNewDocument evasion scripts are not automatically applied to browser-
    // initiated popup targets. Setting this flag attaches a targetcreated listener
    // that injects navigator.webdriver removal into the popup before any page code
    // runs, so Auth0 and Adobe Pass don't detect automation in the popup context.
    injectPopupEvasion: true,
    // NBC's AccessEnabler uses backgroundLogin:true, which automatically fires a
    // background auth iframe on every page load using the cached provider session
    // (nbcLastMvpdSelected + Adobe Pass cookies). Clearing either of these before
    // navigation causes the iframe to call completeBackgroundLogin("") with an empty
    // token, which fires "Invalid token format", corrupts AccessEnabler's internal
    // state, and causes subsequent completeBackgroundLogin calls (even with a valid
    // token from a real SAML flow) to be silently dropped. Leave both intact.
    //
    // Extended checkLogin wait: NBC's background auth iframe takes longer than the
    // default 3 s to complete. Poll the loggedOutIndicator for up to 15 seconds so
    // the initial "already logged in" check correctly detects the background auth
    // result rather than timing out early and triggering an unnecessary login flow.
    checkLoginWaitMs: 15000,
  },
  {
    id: 'peacock',
    name: 'Peacock',
    type: 'direct',
    // /signin redirects to /watch/home if already logged in, stays on /signin if not
    checkUrl: 'https://www.peacocktv.com/signin',
    loggedOutUrlFragment: '/signin',
  },
  {
    id: 'primevideo',
    name: 'Prime Video',
    type: 'direct',
    checkUrl: 'https://www.amazon.com/gp/video/storefront',
    // Not logged in: "Join Prime" nav link present
    // <a data-testid="pv-nav-join-prime" href="/gp/video/signup/ref=atv_nb_join_prime">Join Prime</a>
    // Absent when already authenticated
    loggedOutIndicator: 'a[data-testid="pv-nav-join-prime"]',
    checkLoginWaitMs: 5000,
  },
  {
    id: 'tbs',
    name: 'TBS',
    type: 'tve',
    checkUrl: 'https://www.tbs.com/watchtbs/east',
    // Logged out: "SIGN IN FOR FULL ACCESS" freeview button present
    // <div class="freeview--button">SIGN IN FOR FULL ACCESS</div>
    loggedOutIndicator: 'div.freeview--button',
    providerPageUrl: 'https://www.tbs.com/watchtbs/east',
    // Step 1: click the freeview "SIGN IN FOR FULL ACCESS" button
    providerPageTriggers: ['div.freeview--button'],
    // Step 1d (optional): if a remembered-provider modal appears, click "Not My TV Provider"
    // to dismiss it and continue to the full provider list modal.
    // <button class="taui-rememberedcancelbutton"><span>Not My TV Provider</span></button>
    providerPageOptionalDismiss: 'button.taui-rememberedcancelbutton',
    // Step 2: click "View All TV Providers" in the provider modal
    // <button class="taui-viewallbutton"><span>View All TV Providers</span></button>
    providerPageTriggers2: ['button.taui-viewallbutton'],
    searchSelector: 'input.taui-mvpdsearch',
    resultSelector: 'div.taui-searchpane ul.taui-mvpdsbyname li, .taui-mvpdsbyname li',
    redirectWindowOpen: true,
  },
  {
    id: 'tnt',
    name: 'TNT',
    type: 'tve',
    // Same taui auth system as TBS — identical selectors, different starting URL
    checkUrl: 'https://www.tntdrama.com/watchtnt/east',
    loggedOutIndicator: 'div.freeview--button',
    providerPageUrl: 'https://www.tntdrama.com/watchtnt/east',
    providerPageTriggers: ['div.freeview--button'],
    providerPageOptionalDismiss: 'button.taui-rememberedcancelbutton',
    providerPageTriggers2: ['button.taui-viewallbutton'],
    searchSelector: 'input.taui-mvpdsearch',
    resultSelector: 'div.taui-searchpane ul.taui-mvpdsbyname li, .taui-mvpdsbyname li',
    redirectWindowOpen: true,
  },
  {
    id: 'usa',
    name: 'USA Network',
    type: 'tve',
    checkUrl: 'https://www.usanetwork.com/live',
    // Not linked: "Link to TV Provider" security-wall button present
    // <div class="security-wall-btn" id="TVE" role="button" aria-label="Link to TV Provider">
    loggedOutIndicator: 'div#TVE[role="button"]',
    providerPageUrl: 'https://www.usanetwork.com/live',
    // Clicking navigates to the provider search page
    providerPageTriggers: ['div#TVE[role="button"]'],
    // <input class="search-input" placeholder="Search" type="text">
    searchSelector: 'input.search-input',
    // <li class="mvpd-provider" role="button" aria-label="Armstrong">
    resultSelector: 'li.mvpd-provider[role="button"]',
  },
];

// ─── Provider login page selectors ───────────────────────────────────────────
// Single set of selectors broad enough to cover all known TV provider login pages
// without per-provider special-casing. Single-page vs. two-step form detection
// is handled at runtime by checking password field visibility (see Stage A/B below).

// Username / ID field — covers standard forms plus known non-standard providers:
//   input[name="username"]     — standard, Auth0, Okta widget
//   input[type="email"]        — email-first forms
//   input[id*="user" i]        — id="user" (Xfinity), id="userid" (Cox legacy)
//   #okta-signin-username      — Okta widget (Cox, and providers on *.okta.com)
//   input[name="IDToken1"]     — Verizon / OpenAM identity platform
//   input[name="emailAddress"] — DirecTV
//   input[name="user"]         — Xfinity (name attribute fallback)
const USERNAME_SELECTOR = [
  'input[id="username"]',
  'input[name="username"]',
  'input[type="email"]',
  'input[id*="user" i]',
  '#okta-signin-username',
  'input[name="IDToken1"]',
  'input[name="emailAddress"]',
  'input[name="user"]',
].join(', ');

// Submit / Continue button — covers standard forms plus known non-standard providers:
//   button[type="submit"], input[type="submit"] — universal standard
//   #sign_in                                   — Xfinity
//   button[data-testid="sign-in-button"]       — Xfinity (alternate)
//   button[data-ui="continue"]                 — DirecTV
const CONTINUE_SELECTOR = [
  'button[type="submit"]',
  'input[type="submit"]',
  '#sign_in',
  'button[data-testid="sign-in-button"]',
  'button[data-ui="continue"]',
].join(', ');

const PASSWORD_SELECTOR = 'input[type="password"]';

async function dismissWBDTermsBanner(page, logPrefix) {
  try {
    await page.waitForSelector('[aria-labelledby="wbd-ltp-title"] a', { timeout: 3000, visible: true });
    const agreeEl = await page.evaluateHandle(() => {
      return Array.from(document.querySelectorAll('[aria-labelledby="wbd-ltp-title"] a'))
        .find(a => a.textContent.trim().toLowerCase() === 'agree') || null;
    });
    const el = agreeEl.asElement();
    if (el) {
      logTS(`${logPrefix}: dismissing WBD legal terms banner`);
      const box = await el.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      } else {
        await el.evaluate(e => e.click());
      }
      await delay(500);
    }
  } catch (_) {}
}

// ─── Login status check ───────────────────────────────────────────────────────

async function checkLogin(page, siteConfig) {
  try {
    await page.goto(siteConfig.checkUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Dismiss any sign-in confirmation modal that may appear on the check page.
    // Disney/ABC "You've been signed in!" overlays the nav bar so the loggedInIndicator
    // (span.LoginMenu__text.logged) cannot be found, causing every poll to report "not logged in"
    // and triggering an unnecessary login flow. Short 2 s timeout — fast no-op when absent.
    if (siteConfig.postSamlDismiss) {
      try {
        await page.waitForSelector(siteConfig.postSamlDismiss, { timeout: 2000, visible: true });
        logTS(`checkLogin: dismissing sign-in modal for ${siteConfig.id}`);
        await page.click(siteConfig.postSamlDismiss);
        await delay(400);
      } catch (_) {}
    }

    await dismissWBDTermsBanner(page, `checkLogin(${siteConfig.id})`);

    const waitMs = siteConfig.checkLoginWaitMs ?? 3000;

    // Extended polling mode: for sites like NBC/ABC where auth completes asynchronously
    // after DOMContentLoaded. Poll the indicator at 1.5-second intervals and return as
    // soon as auth state is confirmed, up to waitMs.
    //
    // Early-exit behaviour differs by indicator type:
    //   loggedOutIndicator sites (NBC): exit after 3 consecutive "indicator present" readings —
    //     the absence of auth is stable and consistent once confirmed.
    //   loggedInIndicator sites (ABC, Disney): never exit early — the element may appear
    //     after several seconds as the SPA hydrates and reads auth cookies.
    // Helper: try to dismiss a popup/modal if configured (non-destructive no-op when absent)
    const tryDismissPopup = async () => {
      if (!siteConfig.dismissPopup) return;
      try {
        const el = await page.$(siteConfig.dismissPopup);
        if (el) { await el.click(); await delay(400); }
      } catch (_) {}
    };

    if (waitMs > 3000 && (siteConfig.loggedInIndicator || siteConfig.loggedOutIndicator)) {
      // For loggedInIndicator sites, hover a trigger element first so the SPA has a chance
      // to initialise the nav bar before we check. E.g. ABC's Login button opens the dropdown
      // and confirms auth state is reflected in the nav.
      if (siteConfig.checkLoginPreHover) {
        try {
          await page.hover(siteConfig.checkLoginPreHover);
          await delay(700);
        } catch (_) {}
      }
      const deadline = Date.now() + waitMs;
      await delay(1500);
      let notLoggedInStreak = 0;
      while (Date.now() < deadline) {
        // If the page has been redirected to a known "not logged in" URL, bail out immediately.
        // This handles cases where a modal or other interstitial prevents normal element detection
        // but the site ultimately redirects unauthenticated users to a different domain/path.
        if (siteConfig.loggedOutUrlFragment && page.url().includes(siteConfig.loggedOutUrlFragment)) {
          logTS(`checkLogin: redirected to logged-out URL (${page.url()}) — not logged in`);
          return false;
        }
        await tryDismissPopup();
        if (siteConfig.loggedInIndicator) {
          const el = await page.$(siteConfig.loggedInIndicator).catch(() => null);
          if (el !== null) return true;
          // Do NOT exit early for loggedInIndicator — element may appear late as SPA hydrates
        } else {
          const el = await page.$(siteConfig.loggedOutIndicator).catch(() => null);
          if (el === null) return true; // indicator gone = logged in
          notLoggedInStreak++;
          if (notLoggedInStreak >= 3) return false; // consistently not logged in — no need to wait longer
        }
        await delay(1500);
      }
      // Timed out — final definitive check (with pre-hover for loggedInIndicator sites)
      if (siteConfig.checkLoginPreHover) {
        try { await page.hover(siteConfig.checkLoginPreHover); await delay(500); } catch (_) {}
      }
      // Final URL check before element check
      if (siteConfig.loggedOutUrlFragment && page.url().includes(siteConfig.loggedOutUrlFragment)) {
        logTS(`checkLogin: final URL check — redirected to logged-out URL (${page.url()})`);
        return false;
      }
      await tryDismissPopup();
      if (siteConfig.loggedInIndicator) {
        const el = await page.$(siteConfig.loggedInIndicator).catch(() => null);
        return el !== null;
      }
      const el = await page.$(siteConfig.loggedOutIndicator).catch(() => null);
      return el === null;
    }

    // URL-redirect polling mode: for SPAs (e.g. DirecTV) that redirect logged-out users
    // asynchronously after domcontentloaded. Polls every 500 ms for:
    //   (a) URL redirect away from the check domain, or
    //   (b) a login form appearing inline in the DOM.
    // Times out and reports "logged in" only if neither signal fires.
    if (siteConfig.pollForUrlRedirect) {
      const checkDomain = new URL(siteConfig.checkUrl).hostname;
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        const currentUrl = page.url();
        // Signal (a): URL redirect away from the original domain
        if (!currentUrl.includes(checkDomain)) {
          logTS(`checkLogin [${siteConfig.id}]: redirected to ${currentUrl} — not logged in`);
          return false;
        }
        // Signal (b): login form visible inline (covers overlay-based auth flows)
        const hasLoginForm = await page.$(USERNAME_SELECTOR).catch(() => null);
        if (hasLoginForm) {
          logTS(`checkLogin [${siteConfig.id}]: inline login form detected — not logged in`);
          return false;
        }
        await delay(500);
      }
      logTS(`checkLogin [${siteConfig.id}]: post-poll URL: ${page.url()} — no login signals, assuming logged in`);
      return true;
    }

    // Standard single-check mode
    await delay(waitMs);

    // Dismiss any modal that may have appeared during the wait
    await tryDismissPopup();

    // Pre-hover for loggedInIndicator sites that need it (e.g. ABC's Login button)
    if (siteConfig.checkLoginPreHover) {
      try {
        await page.hover(siteConfig.checkLoginPreHover);
        await delay(700);
      } catch (_) {}
    }

    if (siteConfig.loggedInIndicator) {
      const el = await page.$(siteConfig.loggedInIndicator);
      return el !== null;
    }

    if (siteConfig.loggedOutIndicator) {
      const el = await page.$(siteConfig.loggedOutIndicator);
      return el === null;
    }

    // URL fallback
    const url = page.url();
    if (siteConfig.loggedOutUrlFragment) {
      return !url.includes(siteConfig.loggedOutUrlFragment);
    }
    return !url.includes('/login') && !url.includes('/signin') && !url.includes('/sign-in');
  } catch (e) {
    logTS(`checkLogin error for ${siteConfig.id}: ${e.message}`);
    return false;
  }
}

// ─── Direct login handlers ────────────────────────────────────────────────────

async function loginSling(page, username, password) {
  try {
    // Visit home page first to establish cookies and reduce bot detection before sign-in
    await page.goto('https://www.sling.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000);

    await page.goto('https://www.sling.com/sign-in', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000); // allow React app to render

    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
    await page.click('input[name="email"]', { clickCount: 3 }); // triple-click selects any auto-filled value
    await page.type('input[name="email"]', username, { delay: 50 });

    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', password, { delay: 50 });
    await delay(300);

    // Sign In is an <a role="button">, not a <button type="submit">
    await page.click('a[data-test-id="account-form-account-form-adobe-commerce-button-button"]');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      delay(10000)
    ]);
    await delay(2000);

    const url = page.url();
    if (url.includes('/sign-in') || url.includes('/login')) {
      const errorMsg = await page.evaluate(() => {
        const el = document.querySelector('[role="alert"], [class*="error" i]');
        return el ? el.textContent.trim() : null;
      });
      return { success: false, message: errorMsg || 'Login failed — check credentials' };
    }
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * Handle DirecTV post-login interstitials: profile selector and sports-scores preference.
 * Both screens are optional — if absent this is a near-instant no-op.
 *
 * Profile: detected by URL (/user-profiles). This is an immediate check — no polling.
 *   If the page is already there, handle it; otherwise the session already has a profile.
 * Scores: overlay appears after profile selection. Only polled when a profile was clicked.
 *
 * This function is called both after a fresh login AND when already logged in
 * (the "already logged in" path in loginEncoders), so both cases are handled.
 */
async function handleDirectvPostLogin(page) {
  let profileWasClicked = false;

  // ── Profile selector ─────────────────────────────────────────────────────────
  // DirecTV sends unauthenticated-profile sessions straight to /user-profiles.
  // Immediate URL check — if we're there, wait for tiles to render and click the first one.
  // If we're not there, profile is already selected; skip instantly.
  try {
    const url = page.url();
    if (url.includes('/user-profiles')) {
      logTS(`[DirecTV] Profile selector page (${url}) — waiting for tiles`);
      await page.waitForFunction(
        () => document.querySelectorAll('[role="button"], button, li[tabindex], div[tabindex]').length > 0,
        { timeout: 8000, polling: 300 }
      ).catch(() => {});

      // Diagnostic: show what interactive elements exist so we can refine if needed
      const diagInfo = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(
          '[role="button"], button, li[tabindex], div[tabindex], a[href*="profile"]'
        )).slice(0, 10).map(el => ({
          tag: el.tagName,
          role: el.getAttribute('role') || '',
          text: el.textContent.trim().slice(0, 40),
          tabindex: el.getAttribute('tabindex') || ''
        }));
      }).catch(() => []);
      logTS(`[DirecTV] Profile page elements: ${JSON.stringify(diagInfo)}`);

      const profileClicked = await page.evaluate(() => {
        // Profile tiles show: letter-initial square + profile name. No images.
        // Skip "Add Profile", "+", and anything inside nav/header/footer.
        const isCandidate = (el) => {
          const text = el.textContent.trim();
          return text.length > 0 && text.length < 60
            && !/^add\s*profile|^\+|sign.?out|settings|help/i.test(text)
            && !el.closest('nav, header, footer');
        };
        const roleBtn = Array.from(document.querySelectorAll('[role="button"]')).find(isCandidate);
        if (roleBtn) { roleBtn.click(); return 'role-button: ' + roleBtn.textContent.trim().slice(0, 30); }
        const btn = Array.from(document.querySelectorAll('button')).find(isCandidate);
        if (btn) { btn.click(); return 'button: ' + btn.textContent.trim().slice(0, 30); }
        const tile = Array.from(document.querySelectorAll('li[tabindex], div[tabindex]')).find(isCandidate);
        if (tile) { tile.click(); return 'tile: ' + tile.textContent.trim().slice(0, 30); }
        const link = document.querySelector('a[href*="profile" i], a[href*="user" i]');
        if (link && isCandidate(link)) { link.click(); return 'link: ' + link.textContent.trim().slice(0, 30); }
        return null;
      });
      logTS(`[DirecTV] Profile selector: ${profileClicked || 'no clickable profile found'}`);
      if (profileClicked) {
        profileWasClicked = true;
        await delay(3000); // allow post-profile navigation to begin before polling for scores
      }
    } else {
      logTS(`[DirecTV] Profile already selected (page: ${url}) — skipping profile step`);
    }
  } catch (e) {
    logTS(`[DirecTV] Profile selector error: ${e.message}`);
  }

  // ── Sports scores screen ──────────────────────────────────────────────────────
  // The scores overlay appears on the page that loads after profile selection.
  // Only poll when a profile was just clicked — if no profile was clicked this session,
  // the overlay won't appear (it's tied to the initial profile-selection flow).
  if (!profileWasClicked) {
    logTS('[DirecTV] No profile clicked — skipping sports scores check');
    return;
  }
  try {
    let scoresFound = false;
    const scoresDeadline = Date.now() + 12000;
    while (Date.now() < scoresDeadline) {
      const found = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
        return all.some(el => /hide.{0,6}score/i.test(el.textContent));
      }).catch(() => false);
      if (found) { scoresFound = true; break; }
      await delay(400);
    }

    if (scoresFound) {
      logTS('[DirecTV] Sports scores overlay detected — clicking Hide Scores');
      const clicked = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
        const btn = all.find(el => /hide.{0,6}score/i.test(el.textContent));
        if (btn) { btn.click(); return btn.textContent.trim().slice(0, 40); }
        return null;
      });
      logTS(`[DirecTV] Sports scores: ${clicked ? `clicked "${clicked}"` : 'button not found after poll'}`);
      await delay(1000);
    } else {
      logTS('[DirecTV] Sports scores overlay not detected — skipping');
    }
  } catch (e) {
    logTS(`[DirecTV] Sports scores error: ${e.message}`);
  }
}

async function loginDirectv(page, username, password) {
  try {
    // Navigate to the DirecTV Stream home page. If not logged in the SPA may redirect
    // to auth.directv.com or show an inline sign-in overlay.
    await page.goto('https://stream.directv.com/guide', { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Poll for up to 12 s for either:
    //   (a) a URL redirect away from stream.directv.com (auth redirect), OR
    //   (b) the email/username input to appear in the DOM (inline login overlay)
    // Either signal means "not logged in — proceed with login form."
    let loginFormVisible = false;
    const pollDeadline = Date.now() + 12000;
    while (Date.now() < pollDeadline) {
      const currentUrl = page.url();
      // Signal (a): redirected away from stream.directv.com
      if (!currentUrl.includes('stream.directv.com')) {
        loginFormVisible = true;
        logTS(`[DirecTV] Auth redirect detected: ${currentUrl}`);
        break;
      }
      // Signal (b): login form appeared inline on stream.directv.com
      const hasLoginInput = await page.$(USERNAME_SELECTOR).catch(() => null);
      if (hasLoginInput) {
        loginFormVisible = true;
        logTS(`[DirecTV] Inline login form detected on ${currentUrl}`);
        break;
      }
      await delay(500);
    }

    logTS(`[DirecTV] Post-navigation URL: ${page.url()} | loginFormVisible=${loginFormVisible}`);

    if (!loginFormVisible) {
      // No login signals after 12 s — already logged in.
      await handleDirectvPostLogin(page);
      return { success: true };
    }

    // Login form is present — either via redirect or inline overlay.
    logTS(`[DirecTV] Login page: ${page.url()}`);

    // ── Step 1: Username/email page ────────────────────────────────────────────
    // DirecTV's known email selector; fall back to the generic USERNAME_SELECTOR.
    const emailSel = 'input[name="emailAddress"]';
    await page.waitForSelector(`${emailSel}, ${USERNAME_SELECTOR}`, { timeout: 15000 });
    const emailInput = await page.$(emailSel) ? emailSel : USERNAME_SELECTOR;
    await page.click(emailInput, { clickCount: 3 });
    await page.type(emailInput, username, { delay: 50 });
    await delay(300);
    logTS(`[DirecTV] Typed username into ${emailInput}`);

    // Click the Continue/Next button on the username page.
    // DirecTV's auth platform may use a non-submit button; find by text content first.
    await delay(500);
    const continueClicked = await page.evaluate(() => {
      const byAttr = document.querySelector('button[data-ui="continue"], button[data-testid*="continue" i], button[data-testid*="next" i]');
      if (byAttr) { byAttr.click(); return byAttr.getAttribute('data-ui') || byAttr.getAttribute('data-testid') || 'attr-match'; }
      const byText = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => /^(continue|next|sign[\s-]?in)$/i.test(el.textContent.trim()));
      if (byText) { byText.click(); return `text:${byText.textContent.trim()}`; }
      const byType = document.querySelector('button[type="submit"], input[type="submit"]');
      if (byType) { byType.click(); return 'type-submit'; }
      return null;
    });
    if (!continueClicked) throw new Error('DirecTV: could not find Continue button on username page');
    logTS(`[DirecTV] Clicked Continue (${continueClicked}) after username`);

    // ── Step 2: Password page ──────────────────────────────────────────────────
    // Wait for the password field — it appears after a page navigation or DOM swap.
    await page.waitForSelector(PASSWORD_SELECTOR, { timeout: 15000 });
    await delay(300);
    logTS('[DirecTV] Password field visible');
    await page.click(PASSWORD_SELECTOR, { clickCount: 3 });
    await page.type(PASSWORD_SELECTOR, password, { delay: 50 });
    await delay(300);

    // Submit the password step — same text-content approach as the username step.
    await delay(500);
    const submitClicked = await page.evaluate(() => {
      const byAttr = document.querySelector('button[data-ui="continue"], button[data-testid*="continue" i], button[data-testid*="sign-in" i], button[data-testid*="signin" i]');
      if (byAttr) { byAttr.click(); return byAttr.getAttribute('data-ui') || byAttr.getAttribute('data-testid') || 'attr-match'; }
      const byText = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => /^(continue|sign[\s-]?in|log[\s-]?in|submit)$/i.test(el.textContent.trim()));
      if (byText) { byText.click(); return `text:${byText.textContent.trim()}`; }
      const byType = document.querySelector('button[type="submit"], input[type="submit"]');
      if (byType) { byType.click(); return 'type-submit'; }
      return null;
    });
    if (!submitClicked) throw new Error('DirecTV: could not find Submit button on password page');
    logTS(`[DirecTV] Clicked Submit (${submitClicked}) after password`);

    // Wait for the SPA to navigate away from the auth domain on success.
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      delay(12000)
    ]);
    await delay(2000);

    const url = page.url();
    logTS(`[DirecTV] Post-submit URL: ${url}`);
    if (!url.includes('stream.directv.com')) {
      const errorMsg = await page.evaluate(() => {
        const el = document.querySelector('[role="alert"], [class*="error" i], [class*="alert" i]');
        return el ? el.textContent.trim() : null;
      });
      return { success: false, message: errorMsg || 'Login failed — check credentials' };
    }

    await handleDirectvPostLogin(page);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function loginPeacock(page, username, password) {
  try {
    await page.goto('https://www.peacocktv.com/signin', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000); // allow React app to render

    // Single-page form: email (name="userIdentifier") + password on same screen
    await page.waitForSelector('input[name="userIdentifier"]', { timeout: 15000 });
    await page.click('input[name="userIdentifier"]', { clickCount: 3 });
    await page.type('input[name="userIdentifier"]', username, { delay: 50 });

    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', password, { delay: 50 });
    await delay(300);

    await page.click('button[data-testid="sign-in-form__submit"]');
    // Wait for first navigation away from /signin
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      delay(10000)
    ]);
    // Peacock chains through /watch/home → /watch/error → /watch/profiles after login.
    // Wait long enough for that redirect chain to fully settle before checking the URL.
    await delay(6000);

    const url = page.url();
    if (url.includes('/signin') || url.includes('/login')) {
      const errorMsg = await page.evaluate(() => {
        const el = document.querySelector('[role="alert"], [id$="-error"]');
        return el ? el.textContent.trim() : null;
      });
      return { success: false, message: errorMsg || 'Login failed — check credentials' };
    }
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// Find an element by selector, recursively piercing shadow roots, polling until found.
// Stencil.js web components (e.g. HBO Max's gi-form / gi-form-input) render their
// internal DOM into shadow roots — standard page.$() only queries the light DOM and
// cannot see them. page.evaluateHandle() runs JS in the page context where shadowRoot
// is accessible, allowing deep traversal across nested shadow trees.
async function findShadowElement(page, selector, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const handle = await page.evaluateHandle((sel) => {
      function deepQuery(root, selector) {
        const el = root.querySelector(selector);
        if (el) return el;
        for (const child of root.querySelectorAll('*')) {
          if (child.shadowRoot) {
            const found = deepQuery(child.shadowRoot, selector);
            if (found) return found;
          }
        }
        return null;
      }
      return deepQuery(document, sel);
    }, selector).catch(() => null);

    if (handle) {
      const el = handle.asElement();
      if (el) return el;
      await handle.dispose().catch(() => {});
    }
    await delay(500);
  }
  return null;
}

// Find the first frame on `page` that contains a matching element, polling until found.
// Disney's login modal loads in a cross-origin iframe from the identity service;
// page.waitForSelector only searches the main frame, so we must iterate page.frames().
async function findFrameContaining(page, selector, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const el = await frame.$(selector);
        if (el) return frame;
      } catch (_) {}
    }
    await delay(500);
  }
  return null;
}

async function loginDisney(page, username, password) {
  try {
    // Navigate to disneyplus.com/home and let the SPA settle
    await page.goto('https://www.disneyplus.com/home', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000);

    // Dismiss any offer/promo modal that may be blocking the nav
    try {
      const modal = await page.$('button[aria-label="Close modal"]');
      if (modal) { await modal.click(); await delay(500); }
    } catch (_) {}

    // Check if already logged in — LOG IN button absent AND still on disneyplus.com means logged in.
    // Unauthenticated users get JS-redirected to disney.com (~5s); if that redirect happened during
    // the 3s delay, the LOG IN button won't exist on disney.com either — don't misread that as logged in.
    let loginBtn = await page.$('a[data-testid="log_in"]');
    if (!loginBtn) {
      if (page.url().includes('www.disney.com') && !page.url().includes('disneyplus.com')) {
        logTS('Disney+: redirected to disney.com — not logged in, navigating back');
        await page.goto('https://www.disneyplus.com/home', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(2000);
        // If we get redirected again immediately, the session is definitely not authenticated
        if (page.url().includes('www.disney.com') && !page.url().includes('disneyplus.com')) {
          throw new Error('Disney+ keeps redirecting to disney.com — unable to reach login page');
        }
        loginBtn = await page.$('a[data-testid="log_in"]');
        if (!loginBtn) throw new Error('Disney+ LOG IN button not found after redirect recovery');
      } else {
        logTS('Disney+: already logged in');
        return { success: true };
      }
    }

    // Click the LOG IN button — navigates to /identity/login (may go through intermediate redirects)
    logTS('Disney+: clicking LOG IN button');
    await loginBtn.click();
    // Disney+ SPA may redirect /home → / → /identity/login in multiple steps.
    // Poll until the URL settles on /identity/login rather than trusting a single waitForNavigation.
    await page.waitForFunction(
      () => window.location.href.includes('/identity/login'),
      { timeout: 15000 }
    ).catch(() => {});

    if (!page.url().includes('/identity/login')) {
      throw new Error(`Expected Disney+ login page, got: ${page.url()}`);
    }

    // Step 1: email
    // <input id="email" type="email"> + <button data-testid="continue-btn">Continue</button>
    await page.waitForSelector('input#email', { timeout: 10000, visible: true });
    await page.click('input#email', { clickCount: 3 });
    await page.type('input#email', username, { delay: 50 });
    await delay(300);
    await page.click('button[data-testid="continue-btn"]');
    await delay(2000);

    // Step 2: password
    // <form class="password-form"><input id="password"><button type="submit">Log In</button></form>
    await page.waitForSelector('input#password', { timeout: 10000, visible: true });
    await page.click('input#password', { clickCount: 3 });
    await page.type('input#password', password, { delay: 50 });
    await delay(300);
    await page.click('form.password-form button[type="submit"]');

    // Wait for redirect back to disneyplus.com after successful login
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      delay(10000),
    ]);

    // Poll for up to 10s — success when no longer on the identity/login page
    // and LOG IN button is gone from the disneyplus.com nav
    let loggedIn = false;
    const verifyDeadline = Date.now() + 10000;
    while (Date.now() < verifyDeadline) {
      const url = page.url();
      if (!url.includes('/identity/login') && !url.includes('disney.com/')) {
        const loginGone = !(await page.$('a[data-testid="log_in"]').catch(() => null));
        if (loginGone) { loggedIn = true; break; }
      }
      await delay(1000);
    }

    if (!loggedIn) {
      const errorMsg = await page.evaluate(() => {
        const el = document.querySelector('[role="alert"], [id$="-error"], [class*="error" i]');
        return el ? el.textContent.trim() : null;
      });
      return { success: false, message: errorMsg || 'Login failed — check credentials or 2FA required' };
    }

    logTS('Disney+: login succeeded');
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function loginHboMax(page, username, password) {
  try {
    await page.goto('https://www.hbomax.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000); // allow SPA to hydrate and auth state to settle

    // Dismiss Terms / Privacy consent modal if it appears on first visit.
    // <button class="...btn--privacy-primary">Agree</button>
    // Use partial class match since the name contains auto-generated hash tokens.
    try {
      await page.waitForSelector('button[class*="btn--privacy-primary"]', { timeout: 4000, visible: true });
      logTS('HBO Max: dismissing Terms/Privacy consent modal');
      await page.click('button[class*="btn--privacy-primary"]');
      await delay(800);
    } catch (_) {
      // Modal not present — normal for returning visitors
    }

    // Check DOM presence of the Sign In link — it's absent when logged in.
    // Do NOT use boundingBox(): on narrow screens the link collapses into a hamburger
    // menu (display:none) but stays in the DOM — DOM presence alone is the signal.
    const signInLink = await page.$('a#header-secondary-cta');
    if (!signInLink) return { success: true }; // link absent = already logged in

    // Navigate directly to the auth URL from the link's href.
    // Clicking the link is unreliable because it has target="_top", which Puppeteer's
    // waitForNavigation does not track correctly.
    logTS('HBO Max: navigating to auth login page');
    await page.goto('https://auth.hbomax.com/login?flow=login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(2000); // allow React auth app to render

    // Dismiss Terms / Privacy consent modal if it appears on the auth page too.
    try {
      await page.waitForSelector('button[class*="btn--privacy-primary"]', { timeout: 4000, visible: true });
      logTS('HBO Max: dismissing Terms/Privacy consent modal on auth page');
      await page.click('button[class*="btn--privacy-primary"]');
      await delay(800);
    } catch (_) {
      // Modal not present
    }

    // The login form is rendered by Stencil.js web components (gi-form, gi-form-input).
    // Stencil components use shadow DOM — standard page.$() cannot pierce shadow roots,
    // and the inputs are invisible to frame.$() too. Use findShadowElement() which
    // recursively traverses shadowRoot trees via page.evaluateHandle().
    //
    // Also allow extra settle time: Stencil marks components "hydrated" after JS init,
    // which takes longer than the initial DOMContentLoaded event.
    await delay(2000); // extra wait for Stencil hydration on top of the 2s already elapsed

    // Email/phone input — id changed to sign-in-phoneEmail-input in newer auth UI
    const emailSelector = 'input#sign-in-phoneEmail-input';
    logTS('HBO Max: searching for email input in shadow DOM');
    const emailInput = await findShadowElement(page, emailSelector, 15000);
    if (!emailInput) throw new Error('HBO Max email input not found — Stencil shadow DOM may not have hydrated');

    // Step 1: focus the shadow DOM input and type via page.keyboard (avoids CDP coordinate
    // issues with shadow-hosted elements; keyboard events always go to the focused element)
    await emailInput.evaluate(el => { el.focus(); el.select(); });
    await page.keyboard.type(username, { delay: 50 });
    await delay(300);

    // Continue button — DOM click is reliable for shadow DOM; avoids coordinate math
    const emailContinueSelector = 'button[data-testid="gisdk.gi-sign-in-email.continue_button"]';
    const continueBtn = await findShadowElement(page, emailContinueSelector, 5000);
    if (continueBtn) {
      logTS('HBO Max: clicking Continue after email');
      await continueBtn.evaluate(el => el.click());
    } else {
      logTS('HBO Max: no Continue button found — pressing Enter');
      await page.keyboard.press('Enter');
    }

    // Wait for the password step to render (Stencil swaps the form contents in place)
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {}),
      delay(3000),
    ]);
    await delay(1000); // allow Stencil to re-render the password step

    // Step 2: password — same shadow DOM approach
    const passwordSelector = 'input#sign-in-password-password-input';
    logTS('HBO Max: searching for password input in shadow DOM');
    const passwordInput = await findShadowElement(page, passwordSelector, 15000);
    if (!passwordInput) throw new Error('HBO Max password input not found');

    await passwordInput.evaluate(el => { el.focus(); el.select(); });
    await page.keyboard.type(password, { delay: 50 });
    await delay(300);

    // Sign In button
    const passwordSignInSelector = 'button[data-testid="gisdk.gi-sign-in-password.continue_button"]';
    const signInBtn = await findShadowElement(page, passwordSignInSelector, 5000);
    if (signInBtn) {
      logTS('HBO Max: clicking Sign In after password');
      await signInBtn.evaluate(el => el.click());
    } else {
      logTS('HBO Max: no Sign In button found — pressing Enter');
      await page.keyboard.press('Enter');
    }

    // Wait for redirect back to hbomax.com after successful auth
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
      delay(10000),
    ]);
    await delay(3000); // allow SPA to process auth cookies and update nav

    const url = page.url();
    if (url.includes('auth.hbomax.com') || url.includes('/login')) {
      // Still on auth domain — likely wrong credentials
      const errorMsg = await page.evaluate(() => {
        const el = document.querySelector('[role="alert"], [class*="error" i], [class*="Error" i]');
        return el ? el.textContent.trim() : null;
      }).catch(() => null);
      return { success: false, message: errorMsg || 'Login failed — check credentials' };
    }

    // Verify: Sign In link absent from DOM = logged in.
    // DOM presence only (not boundingBox) — hamburger menu hides it on narrow screens.
    const stillSignedOut = await page.$('a#header-secondary-cta').catch(() => null);
    if (stillSignedOut) {
      return { success: false, message: 'Login failed — check credentials' };
    }
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function loginPrimeVideo(page, username, password) {
  try {
    // Remove the WebAuthn/passkey API before any page code runs.
    // Amazon checks for window.PublicKeyCredential at load time and only shows
    // the passkey prompt when the API is present. With it absent, Amazon falls
    // back to the traditional email + password flow automatically.
    await page.evaluateOnNewDocument(() => {
      try {
        Object.defineProperty(window, 'PublicKeyCredential', {
          get: () => undefined,
          configurable: true,
        });
      } catch (_) {}
    });

    await page.goto('https://www.amazon.com/gp/video/storefront', { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000); // allow SPA to hydrate

    // Check for Join Prime link — absent when logged in
    const joinPrimeLink = await page.$('a[data-testid="pv-nav-join-prime"]');
    if (!joinPrimeLink) return { success: true };

    // Click Join Prime — navigates to Amazon's standard sign-in page
    await joinPrimeLink.click();
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }),
      delay(5000),
    ]);
    await delay(2000); // allow auth page to render

    // Step 1: email
    // <input id="ap_email_login" type="email" name="email">
    await page.waitForSelector('input#ap_email_login', { timeout: 15000, visible: true });
    await page.click('input#ap_email_login', { clickCount: 3 });
    await page.type('input#ap_email_login', username, { delay: 50 });
    await delay(300);

    // Continue button — <input type="submit"> inside span#continue (no id on the input itself)
    // <span id="continue"><span class="a-button-inner"><input class="a-button-input" type="submit"></span></span>
    const continueEl = await page.$('span#continue input[type="submit"]');
    const continueBox = continueEl ? await continueEl.boundingBox() : null;
    if (continueBox && continueBox.width > 0) {
      const cx = continueBox.x + continueBox.width / 2;
      const cy = continueBox.y + continueBox.height / 2;
      await bezierMouseMove(page, cx, cy);
      await page.mouse.click(cx, cy);
    } else if (continueEl) {
      await continueEl.evaluate(el => el.click());
    } else {
      await page.keyboard.press('Enter');
    }

    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }),
      delay(4000),
    ]);
    await delay(500);

    // Step 2: password
    // <input id="ap_password" type="password" name="password">
    await page.waitForSelector('input#ap_password', { timeout: 15000, visible: true });
    await page.click('input#ap_password', { clickCount: 3 });
    await page.type('input#ap_password', password, { delay: 50 });
    await delay(300);

    // Sign In button — <input id="signInSubmit" type="submit">
    const signInEl = await page.$('input#signInSubmit[type="submit"]');
    const signInBox = signInEl ? await signInEl.boundingBox() : null;
    if (signInBox && signInBox.width > 0) {
      const cx = signInBox.x + signInBox.width / 2;
      const cy = signInBox.y + signInBox.height / 2;
      await bezierMouseMove(page, cx, cy);
      await page.mouse.click(cx, cy);
    } else if (signInEl) {
      await signInEl.evaluate(el => el.click());
    } else {
      await page.keyboard.press('Enter');
    }

    // Wait for redirect back to primevideo.com
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
      delay(10000),
    ]);
    await delay(3000);

    // If still on the Amazon auth page (signin/ap), login failed
    const url = page.url();
    if (url.includes('/ap/signin') || url.includes('/ap/cvf')) {
      const errorMsg = await page.evaluate(() => {
        const el = document.querySelector('#auth-error-message-box, .a-alert-content');
        return el ? el.textContent.trim() : null;
      }).catch(() => null);
      return { success: false, message: errorMsg || 'Login failed — check credentials' };
    }

    // Verify Join Prime link is gone (back on amazon.com/gp/video)
    const stillSignedOut = await page.$('a[data-testid="pv-nav-join-prime"]').catch(() => null);
    if (stillSignedOut) {
      return { success: false, message: 'Login failed — check credentials' };
    }
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ─── TVE login handler ────────────────────────────────────────────────────────

async function loginTve(page, siteConfig, tveProviderName, tveProviderUsername, tveProviderPassword) {
  let popupEvasionCleanup = null; // declared outside try so catch can call it
  try {
    // Step 1: navigate to provider selection page.
    // Pre-clear Adobe Pass session cookies so firstbookend.php (authbypass) finds
    // no valid session and falls through to the real IDP for credential entry.
    if (siteConfig.clearAdobePassCookies) {
      try {
        const cdpClient = await page.createCDPSession();
        const { cookies } = await cdpClient.send('Network.getAllCookies');
        const adobeCookies = cookies.filter(c =>
          c.domain && (c.domain.includes('adobe.auth-gateway.net') ||
                       c.domain.includes('entitlement.auth.adobe.com'))
        );
        for (const cookie of adobeCookies) {
          await cdpClient.send('Network.deleteCookies', {
            name: cookie.name, domain: cookie.domain, path: cookie.path || '/',
          });
        }
        await cdpClient.detach();
        logTS(`TVE: cleared ${adobeCookies.length} Adobe Pass cookie(s) for ${siteConfig.id}`);
      } catch (e) {
        logTS(`TVE: Adobe Pass cookie clear error: ${e.message}`);
      }
    }
    // Register localStorage clear BEFORE the first navigation so it runs before
    // any page scripts. NBC's backgroundLogin:true config auto-triggers authbypass
    // for the cached provider (e.g. Xfinity from a previous run) the moment the
    // page loads — if nbcLastMvpdSelected is still in localStorage, that unwanted
    // background auth fires before our code can clear anything. evaluateOnNewDocument
    // runs before all page scripts, eliminating the race. We remove the script after
    // the first navigation so it doesn't re-clear the auth token AccessEnabler writes
    // to localStorage after successful auth.
    let localStorageClearScriptId = null;
    if (siteConfig.clearLocalStorageKeys && siteConfig.clearLocalStorageKeys.length > 0) {
      try {
        const script = await page.evaluateOnNewDocument((keys) => {
          keys.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
        }, siteConfig.clearLocalStorageKeys);
        localStorageClearScriptId = script.identifier;
        logTS(`TVE: registered pre-navigation localStorage clear [${siteConfig.clearLocalStorageKeys.join(', ')}] for ${siteConfig.id}`);
      } catch (e) {
        logTS(`TVE: localStorage pre-clear registration error: ${e.message}`);
      }
    }

    await page.goto(siteConfig.providerPageUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(2000);

    await dismissWBDTermsBanner(page, `TVE(${siteConfig.id})`);

    // Intercept window.open() on TAUI-based sites (TBS, TNT) — the TAUI provider picker
    // calls window.open('about:blank') then sets popup.location.href = providerUrl on the
    // returned object. We return a fake window whose location setter redirects the main tab,
    // keeping the SAML chain in the current tab so the post-click polling loop can track it.
    if (siteConfig.redirectWindowOpen) {
      try {
        await page.evaluate(() => {
          window.open = (url) => {
            if (url && url !== 'about:blank' && url !== '') {
              window.location.href = url;
              return null;
            }
            // Return a fake window object — TAUI will set location.href on it next
            const locObj = {
              get href() { return 'about:blank'; },
              set href(val) { if (val && val !== 'about:blank' && val !== '') window.location.href = val; },
            };
            return {
              get location() { return locObj; },
              set location(val) {
                const href = typeof val === 'string' ? val : val && val.href;
                if (href && href !== 'about:blank' && href !== '') window.location.href = href;
              },
              focus: () => {}, close: () => {}, closed: false, opener: window,
            };
          };
        });
        logTS(`TVE: window.open redirect injected for ${siteConfig.id}`);
      } catch (_) {}
    }

    // Remove the one-shot localStorage clear script so subsequent navigations
    // (e.g. checkUrl) don't re-clear the auth token AccessEnabler just wrote.
    if (localStorageClearScriptId) {
      try {
        const cdp = await page.createCDPSession();
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: localStorageClearScriptId });
        await cdp.detach();
      } catch (_) {}
    }

    // Dismiss any intro popup if configured (e.g. Disney Now lightbox)
    if (siteConfig.dismissPopup) {
      try {
        const popupEl = await page.$(siteConfig.dismissPopup);
        if (popupEl) {
          await popupEl.click();
          await delay(500);
        }
      } catch (_) {}
    }

    // Dismiss any "You've been signed in!" confirmation modal already visible on the provider page
    // (e.g. ABC/FX modal persists on the stream page from a prior login session).
    // Instant DOM check — the 2 s settle above gives the modal time to appear if it was going to.
    // Previously used waitForSelector(3 s) which burned 3 s every time the modal was absent,
    // adding noticeable delay before the trigger chain on every ABC login attempt.
    if (siteConfig.postSamlDismiss) {
      try {
        const dismissEl = await page.$(siteConfig.postSamlDismiss);
        if (dismissEl) {
          const box = await dismissEl.boundingBox();
          if (box && box.width > 0 && box.height > 0) {
            logTS(`TVE: dismissing pre-existing confirmation modal on providerPageUrl for ${siteConfig.id}`);
            await dismissEl.evaluate(el => el.click());
            await delay(500);
          }
        }
      } catch (_) {}
    }

    // Step 1b: inject bot-detection-avoidance scripts into any popup that opens.
    // Puppeteer's evaluateOnNewDocument evasion is only applied to pages created
    // directly by Puppeteer — not to popup windows opened by page JavaScript via
    // window.open(). NBC opens the Adobe Pass SAML in such a popup, and Adobe Pass /
    // Auth0 may detect navigator.webdriver in the popup's context. We attach a
    // targetcreated listener here and call evaluateOnNewDocument on the new target
    // immediately, before its first real navigation loads any page code.
    if (siteConfig.injectPopupEvasion) {
      const browserInst = page.browser();
      const onNewTarget = async (target) => {
        if (target.type() !== 'page') return;
        if (target === page.target()) return; // ignore our own login tab
        try {
          const newPg = await target.page();
          if (!newPg) return;

          // NOTE: We intentionally do NOT strip cookies from the TV provider's
          // authbypass endpoint. The authbypass flow relies on the browser profile
          // having a valid cached session at the provider (e.g. Armstrong). Stripping
          // those cookies causes the provider to return an empty SAML assertion
          // instead of redirecting to a login form — the empty assertion propagates
          // all the way to completeBackgroundLogin("") and auth silently fails.
          // The pre-navigation cookie clear (clearAdobePassCookies, above) already
          // handles Adobe's own session; provider-side cookies must remain intact.

          await newPg.evaluateOnNewDocument(() => {
            // Hide navigator.webdriver (the primary automation signal checked by Auth0)
            try {
              Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
                configurable: true,
              });
            } catch (_) {}
            // Remove Chrome DevTools Protocol automation artifacts
            try {
              ['$cdc_asdjflasudklajsdfls__', '__webdriver_evaluate', '__selenium_evaluate',
               '__webdriver_script_func', '__webdriver_script_fn']
                .forEach(k => { try { delete window[k]; } catch (_) {} });
            } catch (_) {}
          });
          logTS(`TVE: injected evasion into popup for ${siteConfig.id}`);
        } catch (e) {
          logTS(`TVE: popup evasion injection error: ${e.message}`);
        }
      };
      browserInst.on('targetcreated', onNewTarget);
      popupEvasionCleanup = () => browserInst.off('targetcreated', onNewTarget);
    }

    // Step 1c: walk through trigger chain
    // Each entry may be a plain selector string (click) or { selector, hover: true } (hover only).
    if (siteConfig.providerPageTriggers && siteConfig.providerPageTriggers.length > 0) {
      for (const trigger of siteConfig.providerPageTriggers) {
        const triggerSelector = typeof trigger === 'string' ? trigger : trigger.selector;
        const hoverOnly      = typeof trigger === 'object' && trigger.hover === true;
        try {
          logTS(`TVE: waiting for trigger "${triggerSelector}"`);
          await page.waitForSelector(triggerSelector, { timeout: 10000, visible: true });
          await delay(300); // let any entry animation settle

          const triggerEl = await page.$(triggerSelector);
          let triggerBox = triggerEl ? await triggerEl.boundingBox() : null;
          if (triggerBox && triggerBox.width > 0 && triggerBox.height > 0) {
            await triggerEl.evaluate(el => el.scrollIntoView({ block: 'center' }));
            await delay(200);
            // Re-fetch bounding box after scrollIntoView — element position may have shifted
            triggerBox = await triggerEl.boundingBox() || triggerBox;
            const tx = triggerBox.x + triggerBox.width / 2;
            const ty = triggerBox.y + triggerBox.height / 2;
            if (hoverOnly) {
              logTS(`TVE: hovering trigger "${triggerSelector}" at (${Math.round(tx)}, ${Math.round(ty)})`);
              await bezierMouseMove(page, tx, ty);
              await delay(1200); // let CSS :hover dropdown fully open and any transition complete
            } else {
              logTS(`TVE: clicking trigger "${triggerSelector}" at (${Math.round(tx)}, ${Math.round(ty)})`);
              await bezierMouseMove(page, tx, ty);
              // <a href="#"> elements (e.g. ABC "Link TV Provider"): a normal click fires hash
              // navigation which can cause React Router to re-render and dismiss the opening modal.
              // Use a single programmatic click with preventDefault to suppress hash navigation
              // while still firing React's onClick synthetic event.
              const isHashAnchor = await triggerEl.evaluate(el =>
                el.tagName === 'A' && (el.getAttribute('href') === '#' || el.getAttribute('href') === '')
              );
              if (isHashAnchor) {
                await triggerEl.evaluate(el => {
                  el.addEventListener('click', e => e.preventDefault(), { once: true });
                  el.click();
                });
              } else {
                // Fire both CDP mouse click and DOM click — overlay/modal buttons on some sites
                // (TBS/TNT taui-viewallbutton, ESPN) need one or the other depending on their
                // event listener type (native vs React synthetic)
                await page.mouse.click(tx, ty);
                await delay(80);
                await triggerEl.evaluate(el => el.click());
              }
            }
          } else {
            if (hoverOnly) {
              await page.hover(triggerSelector);
              await delay(600);
            } else {
              logTS(`TVE: clicking trigger "${triggerSelector}" (no bounding box — fallback click)`);
              await page.click(triggerSelector);
            }
          }

          if (!hoverOnly) {
            // Race: page-navigate triggers (Discovery <a>) vs modal-open triggers (ESPN/FX/TBS)
            await Promise.race([
              page.waitForNavigation({ timeout: 5000, waitUntil: 'domcontentloaded' }),
              delay(2500),
            ]);
          }
          await delay(500);
        } catch (e) {
          logTS(`TVE trigger click error (${triggerSelector}): ${e.message}`);
        }
      }
    }

    // Step 1d: click optional intermediate dismiss button if present (e.g. TBS/TNT
    // "Not My TV Provider" modal that appears when a provider was previously remembered).
    // Uses waitForSelector with a short timeout — if it doesn't appear, skip silently.
    if (siteConfig.providerPageOptionalDismiss) {
      try {
        await page.waitForSelector(siteConfig.providerPageOptionalDismiss, { timeout: 3000, visible: true });
        logTS(`TVE: dismissing optional intermediate modal "${siteConfig.providerPageOptionalDismiss}" for ${siteConfig.id}`);
        const dismissEl = await page.$(siteConfig.providerPageOptionalDismiss);
        if (dismissEl) {
          await dismissEl.evaluate(el => el.scrollIntoView({ block: 'center' }));
          await delay(200);
          const dismissBox = await dismissEl.boundingBox();
          if (dismissBox && dismissBox.width > 0 && dismissBox.height > 0) {
            const dx = dismissBox.x + dismissBox.width / 2;
            const dy = dismissBox.y + dismissBox.height / 2;
            await bezierMouseMove(page, dx, dy);
            await page.mouse.click(dx, dy);
            await delay(80);
            await dismissEl.evaluate(el => el.click());
          } else {
            await dismissEl.evaluate(el => el.click());
          }
          await delay(1000);
        }
      } catch (_) {
        // Not present — normal (first time linking, no remembered provider)
      }
    }

    // Step 1e: handle confirmation modal (e.g. NBC "Is [Provider] still your TV Provider?")
    // Always click No — this dismisses the modal and falls through to the full search/select
    // flow regardless of which provider was previously linked. Clicking Yes would bypass the
    // search step and use authbypass with the cached session, which prevents changing providers
    // and is harder to recover from if the cached session is stale.
    let skippedSearch = false;
    if (siteConfig.confirmModal) {
      try {
        await delay(1000); // let any modal animation complete
        const modalEl = await page.$(siteConfig.confirmModal.modalSelector);
        if (modalEl) {
          const modalProviderName = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? el.textContent.trim() : '';
          }, siteConfig.confirmModal.providerNameSelector);
          logTS(`TVE: confirmation modal detected for ${siteConfig.id}, modal provider: "${modalProviderName}" — clicking No to use full search flow`);
          await page.click(siteConfig.confirmModal.noSelector);
          await delay(500);
        }
      } catch (e) {
        logTS(`TVE: confirmModal handling error: ${e.message}`);
      }
    }

    // Step 2: search for provider (skipped if no searchSelector or modal was confirmed)
    if (!skippedSearch && siteConfig.searchSelector) {
      // Some sites (ESPN) may need a secondary trigger click before the search box appears.
      // Try finding the search box first; if not found within 4s, fire providerPageTriggers2.
      let searchFound = false;
      try {
        await page.waitForSelector(siteConfig.searchSelector, { timeout: 4000, visible: true });
        searchFound = true;
      } catch (_) {}

      if (!searchFound && siteConfig.providerPageTriggers2) {
        for (const triggerSelector of siteConfig.providerPageTriggers2) {
          try {
            await page.waitForSelector(triggerSelector, { timeout: 15000, visible: true });
            // Read button text — skip if it already says "Back" (panel is already expanded)
            const triggerEl = await page.$(triggerSelector);
            const triggerText = triggerEl ? await triggerEl.evaluate(el => el.textContent.trim()) : '';
            logTS(`TVE: secondary trigger "${triggerSelector}" text: "${triggerText}"`);
            if (/back/i.test(triggerText)) {
              logTS(`TVE: secondary trigger says "Back" — panel already expanded, skipping click`);
            } else {
              await delay(300);
              logTS(`TVE: clicking secondary trigger "${triggerSelector}"`);
              await triggerEl.evaluate(el => el.scrollIntoView({ block: 'center' }));
              await delay(200);
              // Try both a real CDP mouse click and a DOM click so both React synthetic events
              // and native listeners fire (ESPN needs DOM click; ABC may need CDP mouse click)
              const triggerBox = await triggerEl.boundingBox();
              if (triggerBox && triggerBox.width > 0 && triggerBox.height > 0) {
                const tx = triggerBox.x + triggerBox.width  * (0.3 + Math.random() * 0.4);
                const ty = triggerBox.y + triggerBox.height * (0.3 + Math.random() * 0.4);
                await bezierMouseMove(page, tx, ty);
                await delay(150);
                await Promise.all([
                  Promise.race([
                    page.waitForNavigation({ timeout: 5000, waitUntil: 'domcontentloaded' }),
                    delay(2500),
                  ]),
                  (async () => {
                    await page.mouse.click(tx, ty);
                    await delay(100);
                    await triggerEl.evaluate(el => el.click());
                  })(),
                ]);
              } else {
                await triggerEl.evaluate(el => el.click());
                await Promise.race([
                  page.waitForNavigation({ timeout: 5000, waitUntil: 'domcontentloaded' }),
                  delay(2500),
                ]);
              }
              await delay(500);
            }
          } catch (e) {
            logTS(`TVE secondary trigger error (${triggerSelector}): ${e.message}`);
          }
        }
      }

      await page.waitForSelector(siteConfig.searchSelector, { timeout: 15000, visible: true });

      // Scroll back to top — prior scrollIntoView calls on trigger buttons may have
      // shifted the page, pushing the provider search modal out of the visible area.
      await page.evaluate(() => window.scrollTo(0, 0));
      await delay(300);

      // Simulate human: briefly explore the page before focusing the search box
      const vp = page.viewport() || { width: 1280, height: 720 };
      for (let i = 0; i < 3; i++) {
        await bezierMouseMove(page,
          Math.random() * vp.width * 0.8 + vp.width * 0.1,
          Math.random() * vp.height * 0.6 + vp.height * 0.1
        );
        await delay(150 + Math.random() * 300);
      }

      // Move to the search box with a Bezier path and click it
      const searchBox = await page.$(siteConfig.searchSelector);
      const searchBoxRect = searchBox ? await searchBox.boundingBox() : null;
      if (searchBoxRect) {
        const sx = searchBoxRect.x + searchBoxRect.width / 2;
        const sy = searchBoxRect.y + searchBoxRect.height / 2;
        await bezierMouseMove(page, sx, sy);
        await page.mouse.click(sx, sy);
      } else {
        await page.click(siteConfig.searchSelector);
      }
      await delay(200 + Math.random() * 200);

      // Type with slightly variable character delay to mimic human typing rhythm
      for (const char of tveProviderName) {
        await page.keyboard.type(char);
        await delay(40 + Math.random() * 60);
      }
      await delay(2000); // wait for results to populate
    } else if (!skippedSearch) {
      await delay(1000); // CBS: brief wait after list expansion
    }

    // Step 3: select matching result (skipped when confirmModal was clicked)
    let clicked = skippedSearch; // treat as "clicked" so we proceed to SAML polling
    const needle = tveProviderName.toLowerCase();

    if (siteConfig.keyboardSelect && siteConfig.searchSelector) {
      // Keyboard-navigation approach: focus is already on the search input after typing.
      // ArrowDown moves focus to the first result in the dropdown; Enter selects it.
      // This generates trusted keyboard events and avoids Adobe Pass bot-detection
      // logic that is triggered by mouse-click events on the provider result items.
      logTS(`TVE: waiting for results then using keyboard selection for ${siteConfig.id}`);
      await page.waitForSelector(siteConfig.resultSelector, { timeout: 10000 });
      await delay(300);

      // Press ArrowDown to move focus from the search input to the first result
      await page.keyboard.press('ArrowDown');
      await delay(400 + Math.random() * 200);

      const focusedText = await page.evaluate(() => {
        const el = document.activeElement;
        return el ? el.textContent.trim() : '(none)';
      });

      if (focusedText.toLowerCase().includes(needle)) {
        // Focus landed on the right result — press Enter to select
        await Promise.all([
          Promise.race([
            page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }),
            delay(3000),
          ]),
          page.keyboard.press('Enter'),
        ]);
        clicked = true;
      } else if (focusedText !== '(none)' && focusedText !== '') {
        // Focus moved somewhere — press Enter anyway (first result is usually the best match)
        logTS(`TVE: focused result "${focusedText}" doesn't match "${tveProviderName}" exactly, pressing Enter anyway`);
        await Promise.all([
          Promise.race([
            page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }),
            delay(3000),
          ]),
          page.keyboard.press('Enter'),
        ]);
        clicked = true;
      } else {
        logTS(`TVE: keyboard ArrowDown didn't move focus, falling back to mouse click`);
      }
    }

    if (!clicked) {
      // Mouse click fallback (used by all non-keyboardSelect sites, or if keyboard focus failed)
      await page.waitForSelector(siteConfig.resultSelector, { timeout: 10000 });
      const results = await page.$$(siteConfig.resultSelector);

      for (const result of results) {
        const { text, ariaLabel } = await result.evaluate(el => ({
          text: el.textContent.trim(),
          ariaLabel: el.getAttribute('aria-label') || '',
        }));
        if (text.toLowerCase().includes(needle) || ariaLabel.toLowerCase().includes(needle)) {
          if (siteConfig.domClickResult) {
            // CSS hover dropdown (CBS): moving the mouse to click would exit the hover zone and
            // collapse the dropdown. Use a DOM synthetic click instead — it fires the Vue/JS
            // click handler directly without touching the mouse position, and works on elements
            // anywhere in the list regardless of their scroll position in the dropdown.
            logTS(`TVE: DOM-clicking result "${text}" (domClickResult)`);
            await Promise.all([
              Promise.race([
                page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }),
                delay(3000),
              ]),
              result.evaluate(el => el.click()),
            ]);
            clicked = true;
            break;
          }

          // Check bounding box first — if the element is already visible (e.g. CSS hover
          // dropdown), DON'T call scrollIntoView: scrolling moves the page and takes the
          // button out from under the mouse cursor, collapsing the :hover dropdown.
          let box = await result.boundingBox();
          if (!box || box.height === 0) {
            // Not visible yet — scroll it into view and re-check
            await result.evaluate(el => el.scrollIntoView({ block: 'center' }));
            await delay(400 + Math.random() * 200);
            box = await result.boundingBox();
          }
          logTS(`TVE: clicking result "${text}" box=${JSON.stringify(box)}`);
          if (box && box.width > 0 && box.height > 0) {
            const x = box.x + box.width  * (0.3 + Math.random() * 0.4);
            const y = box.y + box.height * (0.3 + Math.random() * 0.4);
            await bezierMouseMove(page, x, y);
            await delay(300 + Math.random() * 300);
            await Promise.all([
              Promise.race([
                page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }),
                delay(3000),
              ]),
              page.mouse.click(x, y),
            ]);
          } else {
            // Element is in DOM but has zero height (CSS-collapsed dropdown).
            // Puppeteer's result.click() throws on zero-height elements — use a DOM
            // synthetic click instead, which fires regardless of CSS visibility.
            await Promise.all([
              Promise.race([
                page.waitForNavigation({ timeout: 30000, waitUntil: 'domcontentloaded' }),
                delay(3000),
              ]),
              result.evaluate(el => el.click()),
            ]);
          }
          clicked = true;
          break;
        }
      }
    }

    if (!clicked) {
      return { success: false, message: `Provider "${tveProviderName}" not found in results. Check the name matches exactly as shown on the site.` };
    }

    // Step 4: Poll page.url() and page.$() to determine what happened after the provider click.
    // waitForFunction/waitForSelector lose their evaluation context during cross-origin SAML
    // redirect chains, making them unreliable here. page.url() is always current.
    //
    // Outcomes:
    //   'back'  — URL returned to streaming service domain (silent/cached SAML)
    //   'login' — Provider login page appeared with a username/email field
    //   'timeout' — Neither detected within 25 seconds
    const serviceDomain = new URL(siteConfig.providerPageUrl).hostname;
    const pollDeadline = Date.now() + 25000;
    let outcome = 'timeout';

    while (Date.now() < pollDeadline) {
      await delay(500);
      try {
        const currentUrl = page.url();
        const currentHostname = new URL(currentUrl).hostname;
        if (currentHostname.endsWith(serviceDomain)) {
          outcome = 'back';
          break;
        }
        const usernameEl = await page.$(USERNAME_SELECTOR).catch(() => null);
        if (usernameEl) {
          outcome = 'login';
          break;
        }
      } catch (_) {
        // page.url() or page.$() may throw during rapid navigation — keep polling
      }
    }

    logTS(`TVE: post-click outcome=${outcome} url=${page.url()} for ${siteConfig.id}`);

    // Tracks whether the SAML chain definitively returned to the streaming service domain.
    // Used by trustSamlCompletion to skip the post-login DOM verification.
    let samlReturnedToService = false;
    // Set to the frame object where the login form was found (iframe case).
    let loginFrame = null;
    // Set to a Puppeteer Page object when the login form is in a separate popup/tab.
    // NBC's mvpd-picker opens the authbypass SAML chain in a popup window rather than
    // navigating the main tab — so page.url() never leaves nbc.com but a separate page
    // target navigates through adobe.auth-gateway.net → provider auth → authorize.agoc.com.
    let loginPopupPage = null;

    // ── 'back' handling ─────────────────────────────────────────────────────────
    // Initial outcome=back means the page URL was already on the service domain when
    // we first checked. Two sub-cases can follow:
    //   a) Authbypass cached: SAML completes in background and main page moves to a
    //      success URL (e.g. /provider-linked). → stay 'back', samlReturnedToService=true
    //   b) Authbypass expired: SAML opens a login page — either in the main tab
    //      (NBC/Adobe Pass navigates the page) or in a child iframe. → transition to 'login'
    if (outcome === 'back') {
      samlReturnedToService = true; // tentative — cleared if we timeout or detect login page
      const pickerPath = new URL(siteConfig.providerPageUrl).pathname;
      // 20s window: Adobe Pass SDK may take several seconds to initiate the SAML redirect
      const settleDeadline = Date.now() + 20000;
      let samlSettledSuccess = false;

      while (Date.now() < settleDeadline) {
        await delay(300);
        try {
          const currentUrl = new URL(page.url());
          const onServiceDomain = currentUrl.hostname.endsWith(serviceDomain);

          // Sub-case b1: main tab navigated off the service domain.
          // NBC (and Disney Now for expired authbypass) navigates the main tab through
          // the SAML redirect chain to the TV provider's login page.
          if (!onServiceDomain) {
            const usernameEl = await page.$(USERNAME_SELECTOR).catch(() => null);
            if (usernameEl) {
              logTS(`TVE: back-SAML main-tab login at ${new URL(page.url()).hostname} — switching to login flow`);
              samlReturnedToService = false;
              loginFrame = null; // null = use page.mainFrame() (main tab is the login target)
              outcome = 'login';
              break;
            }
            // Still navigating through SAML redirect chain — keep polling
            continue;
          }

          // Sub-case b2: Adobe Pass opened the SAML in a child iframe.
          // The main tab stays on the service domain; scan all non-service-domain frames.
          const childFrames = page.frames().filter(f => f !== page.mainFrame() && !!f.url() && !f.url().startsWith('about:'));
          for (const frame of childFrames) {
            try {
              const frameHost = new URL(frame.url()).hostname;
              if (!frameHost.endsWith(serviceDomain)) {
                const usernameEl = await frame.$(USERNAME_SELECTOR).catch(() => null);
                if (usernameEl) {
                  logTS(`TVE: back-SAML iframe login page at ${frame.url()} — switching to login flow`);
                  samlReturnedToService = false;
                  loginFrame = frame;
                  outcome = 'login';
                  break;
                }
              }
            } catch (_) {}
          }
          if (outcome === 'login') break;

          // Sub-case b3: Adobe Pass opened the SAML in a separate popup/tab.
          // NBC's mvpd-picker calls window.open() for the authbypass redirect chain, so the
          // main tab stays on nbc.com and page.url() never changes. The popup is a separate
          // Puppeteer page target — we find it by scanning browser.targets() for any page
          // on a non-service domain that has a username input field.
          try {
            const browser = page.browser();
            for (const target of browser.targets()) {
              if (target.type() !== 'page') continue;
              if (target === page.target()) continue;
              try {
                const otherPage = await target.page();
                if (!otherPage) continue;
                const otherUrl = otherPage.url();
                if (!otherUrl || otherUrl === 'about:blank' || otherUrl === 'about:newtab') continue;
                let otherHost;
                try { otherHost = new URL(otherUrl).hostname; } catch (_) { continue; }
                if (!otherHost.endsWith(serviceDomain)) {
                  const usernameEl = await otherPage.$(USERNAME_SELECTOR).catch(() => null);
                  if (usernameEl) {
                    logTS(`TVE: back-SAML popup login at ${new URL(otherUrl).hostname} — switching to login flow`);
                    samlReturnedToService = false;
                    loginPopupPage = otherPage;
                    outcome = 'login';
                    break;
                  }
                }
              } catch (_) {}
            }
          } catch (_) {}
          if (outcome === 'login') break;

          // Sub-case a: returned to a success page on the service domain
          if (onServiceDomain && currentUrl.pathname !== pickerPath) {
            logTS(`TVE: background SAML settled at ${page.url()}`);
            samlSettledSuccess = true;
            await delay(500);
            break;
          }
        } catch (_) {}
      }

      // Settle loop timed out without detecting a login page or success navigation.
      // Don't blindly trust this as success — clear the flag and fall through to checkLogin.
      if (outcome === 'back' && !samlSettledSuccess) {
        logTS(`TVE: back-settle timed out for ${siteConfig.id} — running checkLogin to verify`);
        samlReturnedToService = false;
      }
    }

    // ── 'login' handling ─────────────────────────────────────────────────────────
    // Runs for the original outcome=login AND when the 'back' branch detected a login page.
    // loginPopupPage set → login form is in a separate popup/tab (sites without interceptWindowOpen)
    // loginFrame set     → login form is in a child iframe on the service page
    // neither set        → main tab navigated directly to the provider login page
    //                      (includes interceptWindowOpen sites where window.open was redirected)
    if (outcome === 'login') {
      // For popup case: use the popup page and its keyboard.
      // For iframe/main-tab cases: use our page with the appropriate frame.
      const targetPage  = loginPopupPage || page;
      const activeFrame = loginFrame     || targetPage.mainFrame();
      const providerUrl = activeFrame.url();
      logTS(`TVE: Stage A — typing username (${new URL(providerUrl).hostname})`);

      // For popup case: attach a close listener NOW so we don't miss the close event
      // that fires while we're awaiting credential entry steps.
      // Puppeteer's page.url() does NOT throw when a page is closed — it returns the
      // last cached URL, making the catch-based approach unreliable.
      let popupClosed = false;
      if (loginPopupPage) {
        loginPopupPage.once('close', () => { popupClosed = true; });
      }

      // Stage A: username
      await activeFrame.waitForSelector(USERNAME_SELECTOR, { timeout: 15000, visible: true });

      // Detect single-page forms (e.g. Okta): password field already visible alongside username.
      // On these forms the submit button sends both fields at once — clicking it after username
      // alone would submit without a password, causing auth to fail.  Skip the Continue click and
      // fall straight through to Stage B where we fill the password and submit together.
      const passwordVisibleNow = await activeFrame.$(PASSWORD_SELECTOR).then(
        el => el ? el.evaluate(e => {
          const s = window.getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        }) : false
      ).catch(() => false);
      const singlePageForm = passwordVisibleNow;
      if (singlePageForm) {
        logTS(`TVE: single-page login form detected (password visible on arrival) — skipping Continue click`);
      }

      await activeFrame.focus(USERNAME_SELECTOR);
      await targetPage.keyboard.down('Control');
      await targetPage.keyboard.press('a');
      await targetPage.keyboard.up('Control');
      await delay(100);
      await targetPage.keyboard.type(tveProviderUsername, { delay: 50 });
      await delay(400);

      if (!singlePageForm) {
        // Two-step form: click Continue to reveal the password field on a separate step.
        // Use bezierMouseMove + mouse.click — generates a trusted OS-level mouse event
        // rather than a synthetic CDP click (important for React/Angular event listeners).
        const btnEl = await activeFrame.$(CONTINUE_SELECTOR);
        const btnBox = btnEl ? await btnEl.boundingBox() : null;
        if (btnBox && btnBox.width > 0 && btnBox.height > 0) {
          const cx = btnBox.x + btnBox.width  * (0.3 + Math.random() * 0.4);
          const cy = btnBox.y + btnBox.height * (0.3 + Math.random() * 0.4);
          await bezierMouseMove(targetPage, cx, cy);
          await delay(200 + Math.random() * 200);
          await targetPage.mouse.click(cx, cy);
        } else if (btnEl) {
          // Element found but not visible/positioned — click via CDP
          await activeFrame.click(CONTINUE_SELECTOR);
        } else {
          // No standard submit button found (e.g. React Native Web div-based buttons).
          // Press Enter on the focused field — universally supported fallback.
          logTS(`TVE: Stage A — no standard submit button found; pressing Enter`);
          await targetPage.keyboard.press('Enter');
        }
        // Race: some providers reveal the password field on the same page (DOM update),
        // others navigate to a new page (e.g. DirecTV).  Wait for whichever comes first
        // so Stage B's waitForSelector runs on a settled execution context.
        await Promise.race([
          targetPage.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => {}),
          delay(2000),
        ]);
        await delay(300);
      }

      // Stage B: password
      await activeFrame.waitForSelector(PASSWORD_SELECTOR, { timeout: 15000, visible: true });
      logTS(`TVE: Stage B — typing password`);
      await activeFrame.focus(PASSWORD_SELECTOR);
      await targetPage.keyboard.down('Control');
      await targetPage.keyboard.press('a');
      await targetPage.keyboard.up('Control');
      await delay(100);
      await targetPage.keyboard.type(tveProviderPassword, { delay: 50 });
      await delay(400);
      {
        const btnEl = await activeFrame.$(CONTINUE_SELECTOR);
        const btnBox = btnEl ? await btnEl.boundingBox() : null;
        if (btnBox && btnBox.width > 0 && btnBox.height > 0) {
          const cx = btnBox.x + btnBox.width  * (0.3 + Math.random() * 0.4);
          const cy = btnBox.y + btnBox.height * (0.3 + Math.random() * 0.4);
          await bezierMouseMove(targetPage, cx, cy);
          await delay(200 + Math.random() * 200);
          await targetPage.mouse.click(cx, cy);
        } else if (btnEl) {
          // Element found but not visible/positioned — click via CDP
          await activeFrame.click(CONTINUE_SELECTOR);
        } else {
          // No standard submit button found — press Enter as universal fallback.
          logTS(`TVE: Stage B — no standard submit button found; pressing Enter`);
          await targetPage.keyboard.press('Enter');
        }
      }

      // After submitting, poll for the SAML chain to complete.
      const loginDeadline = Date.now() + 30000;
      if (loginPopupPage) {
        // Popup case: NBC closes the popup after auth completes, and the main tab
        // navigates from /mvpd-picker to /provider-linked via window.opener callback.
        // Watch for THREE signals — any one of them means SAML succeeded:
        //   1. popupClosed flag (set by the 'close' event listener above)
        //   2. popup.url() changed to service domain (popup redirected back)
        //   3. page.url() (main tab) moved to a non-picker path on service domain
        const popupPickerPath = new URL(siteConfig.providerPageUrl).pathname;
        while (Date.now() < loginDeadline) {
          await delay(300);

          // Signal 1: close event (most reliable — fires synchronously in Node.js event loop)
          if (popupClosed) {
            logTS(`TVE: popup closed after auth — SAML complete`);
            samlReturnedToService = true;
            break;
          }

          try {
            // Signal 2: popup navigated back to service domain
            const popupHost = new URL(loginPopupPage.url()).hostname;
            if (popupHost.endsWith(serviceDomain)) {
              logTS(`TVE: popup SAML returned to service domain at ${loginPopupPage.url()}`);
              samlReturnedToService = true;
              break;
            }
          } catch (_) {
            // url() threw — popup was destroyed
            logTS(`TVE: popup destroyed — SAML complete`);
            samlReturnedToService = true;
            break;
          }

          try {
            // Signal 3: main tab navigated to a success page (e.g. /provider-linked).
            // NBC's SPA receives the auth callback from the popup via window.opener and
            // navigates away from the picker page to confirm the link succeeded.
            const mainUrl = new URL(page.url());
            if (mainUrl.hostname.endsWith(serviceDomain) && mainUrl.pathname !== popupPickerPath) {
              logTS(`TVE: main tab navigated to ${page.url()} — popup auth complete`);
              samlReturnedToService = true;
              break;
            }
          } catch (_) {}
        }
        await delay(2000); // let NBC's SPA finish processing the auth callback
      } else {
        // Main-tab auth (loginFrame=null): page navigated away; wait for return to service domain.
        // Iframe auth (loginFrame set): main tab stays on service domain; wait for path change.
        const startingPath = new URL(page.url()).pathname;
        while (Date.now() < loginDeadline) {
          await delay(500);
          try {
            const h = new URL(page.url()).hostname;
            const p = new URL(page.url()).pathname;
            if (loginFrame) {
              if (h.endsWith(serviceDomain) && p !== startingPath) {
                logTS(`TVE: iframe SAML complete, main tab now at ${page.url()}`);
                samlReturnedToService = true;
                break;
              }
            } else {
              if (h.endsWith(serviceDomain)) {
                logTS(`TVE: main-tab SAML returned to service domain at ${page.url()}`);
                samlReturnedToService = true;
                break;
              }
            }
          } catch (_) {}
        }
        await delay(3000); // let the final page fully settle

        // Dismiss any post-SAML confirmation modal (e.g. Disney/ABC "You've been signed in!").
        // The modal appears asynchronously on the SAML return page — wait up to 7s for it to appear,
        // then click it away before checkLogin navigates.
        if (siteConfig.postSamlDismiss) {
          try {
            await page.waitForSelector(siteConfig.postSamlDismiss, { timeout: 7000, visible: true });
            logTS(`TVE: dismissing post-SAML confirmation modal for ${siteConfig.id}`);
            await page.click(siteConfig.postSamlDismiss);
            await delay(600);
          } catch (_) {
            // Modal didn't appear — not an error (may have already been dismissed or not shown)
          }
        }
      }
    }

    if (outcome === 'timeout') {
      // SAML never returned; something went wrong
      await delay(5000);
    }

    // Remove popup evasion listener — no more popups expected at this point
    if (popupEvasionCleanup) popupEvasionCleanup();

    // Step 5: verify login
    // If the site sets trustSamlCompletion and the SAML chain returned to the service domain,
    // navigate to checkUrl on the SAME TAB and verify auth there.
    //
    // Why same-tab navigation instead of closing and reopening:
    //   NBC's SPA completes auth finalization during the routing transition AWAY from
    //   /provider-linked. If we close the tab at /provider-linked the finalization never
    //   fires. Navigating to checkUrl (nbc.com/live) on the same tab triggers NBC's SPA
    //   router and allows the auth setup to complete, then we confirm the result.
    if (siteConfig.trustSamlCompletion && samlReturnedToService) {
      const settleMs = siteConfig.samlSettleDelay ?? 6000;
      logTS(`TVE: SAML chain complete for ${siteConfig.id} — settling ${settleMs}ms then verifying`);
      await delay(settleMs);

      let loggedIn = await checkLogin(page, siteConfig);
      if (loggedIn) {
        logTS(`TVE: auth confirmed on same tab after SAML for ${siteConfig.id}`);
        return { success: true };
      }
      // One retry — NBC's SPA sometimes needs a second navigation to settle
      logTS(`TVE: same-tab checkLogin returned false, retrying in 5 s...`);
      await delay(5000);
      loggedIn = await checkLogin(page, siteConfig);
      if (loggedIn) {
        return { success: true };
      }
      return { success: false, message: `Provider-linked page appeared but auth did not persist on ${siteConfig.checkUrl} — SAML may have been silently rejected` };
    }

    // Dismiss any post-SAML success overlay that appears for non-trustSamlCompletion sites
    // (e.g. CBS "Start Watching" button). For sites that DO use trustSamlCompletion (NBC,
    // Disney), this is already handled inside the login branch above.
    // Short timeout: if the overlay isn't present (outcome=timeout, or already gone), skip quickly.
    if (siteConfig.postSamlDismiss && !siteConfig.trustSamlCompletion) {
      try {
        await page.waitForSelector(siteConfig.postSamlDismiss, { timeout: 5000, visible: true });
        logTS(`TVE: dismissing post-SAML overlay for ${siteConfig.id}`);
        await page.click(siteConfig.postSamlDismiss);
        await delay(800);
      } catch (_) {
        // Not present — normal when there is no overlay (e.g. already dismissed, or no overlay for this flow)
      }
    }

    const loggedIn = await checkLogin(page, siteConfig);
    if (loggedIn) {
      return { success: true };
    }

    // Try to extract an error message from the current page
    const errorMsg = await page.evaluate(() => {
      const el = document.querySelector('[class*="error"], [class*="Error"], [role="alert"], [class*="message"]');
      return el ? el.textContent.trim() : null;
    });
    return { success: false, message: errorMsg || 'Login may have failed — please verify in the browser' };

  } catch (e) {
    if (popupEvasionCleanup) popupEvasionCleanup();
    return { success: false, message: e.message };
  }
}

// ─── Per-site login dispatcher ────────────────────────────────────────────────

async function performLogin(page, siteConfig, credentials) {
  const { username, password, tveProviderName, tveProviderUsername, tveProviderPassword } = credentials;

  if (siteConfig.type === 'direct') {
    if (siteConfig.id === 'sling') {
      return await loginSling(page, username, password);
    }
    if (siteConfig.id === 'directv') {
      return await loginDirectv(page, username, password);
    }
    if (siteConfig.id === 'peacock') {
      return await loginPeacock(page, username, password);
    }
    if (siteConfig.id === 'disney') {
      return await loginDisney(page, username, password);
    }
    if (siteConfig.id === 'hbomax') {
      return await loginHboMax(page, username, password);
    }
    if (siteConfig.id === 'primevideo') {
      return await loginPrimeVideo(page, username, password);
    }
    return { success: false, message: `No login handler for direct site: ${siteConfig.id}` };
  }

  if (siteConfig.type === 'tve') {
    return await loginTve(page, siteConfig, tveProviderName, tveProviderUsername, tveProviderPassword);
  }

  return { success: false, message: `Unknown site type: ${siteConfig.type}` };
}

// ─── Main exported function ───────────────────────────────────────────────────

async function loginEncoders({
  siteId,
  username,
  password,
  tveProviderName,
  tveProviderUsername,
  tveProviderPassword,
  encoders,
  browsers,
  activeStreams,
  statusCallback,
}) {
  const siteConfig = LOGIN_SITES.find(s => s.id === siteId);
  if (!siteConfig) {
    statusCallback({ type: 'error', message: `Unknown site: ${siteId}` });
    return;
  }

  // Collect only currently-connected browsers
  const runningEntries = [];
  for (const [encoderUrl, browser] of browsers.entries()) {
    if (browser && browser.isConnected()) {
      const encoderIndex = encoders.findIndex(e => e.url === encoderUrl);
      runningEntries.push({ encoderUrl, browser, encoderIndex });
    }
  }

  if (runningEntries.length === 0) {
    statusCallback({ type: 'complete', success: 0, failed: 0, message: 'No running encoder browsers found. Start a stream first.' });
    return;
  }

  statusCallback({ type: 'start', total: runningEntries.length, siteName: siteConfig.name });

  let successCount = 0;
  let failCount = 0;

  for (const { encoderUrl, browser, encoderIndex } of runningEntries) {
    const label = encoderIndex >= 0 ? encoderIndex + 1 : encoderUrl;
    const encoderConfig = encoderIndex >= 0 ? encoders[encoderIndex] : null;
    const encoderLeft = encoderConfig?.width || 0;
    const encoderTop  = encoderConfig?.height || 0;

    // Skip encoders that are actively streaming to avoid disrupting the output
    if (activeStreams && activeStreams.has(encoderUrl)) {
      statusCallback({ type: 'skipped', encoderIndex, encoderUrl, message: 'Stream is active — stop the stream before logging in' });
      failCount++;
      continue;
    }

    statusCallback({ type: 'checking', encoderIndex, encoderUrl });

    let page = null;
    try {
      page = await browser.newPage();

      // Silently grant geolocation permission for every origin this login flow will visit.
      // Some sites (e.g. CBS.com) trigger a "Know your location?" browser permission popup
      // that blocks the page from fully loading. overridePermissions suppresses the dialog
      // and auto-allows the permission so the page proceeds normally.
      try {
        const loginOrigins = [...new Set(
          [siteConfig.checkUrl, siteConfig.providerPageUrl]
            .filter(Boolean)
            .map(u => new URL(u).origin)
        )];
        for (const origin of loginOrigins) {
          await page.browserContext().overridePermissions(origin, ['geolocation']);
        }
      } catch (_) {}

      // Apply the same webdriver/CDP evasion we use for popups.
      // Without this, NBC's SPA detects the Puppeteer-controlled page context,
      // causing OneTrust geo/CORS failures, CMP category-9 components not loading,
      // and LaunchDarkly serving a bot-flagged feature set — all of which affect
      // how AccessEnabler initializes and processes the auth token.
      await page.evaluateOnNewDocument(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
          });
        } catch (_) {}
        try {
          ['$cdc_asdjflasudklajsdfls__', '__webdriver_evaluate', '__selenium_evaluate',
           '__webdriver_script_func', '__webdriver_script_fn']
            .forEach(k => { try { delete window[k]; } catch (_) {} });
        } catch (_) {}
      });

      // Set Accept-Language only — do NOT set a custom Accept header here.
      // setExtraHTTPHeaders applies to ALL requests from this tab (XHR/fetch
      // included). Sending an HTML-focused Accept value on XHR requests (e.g.
      // OneTrust's geolocation call) is abnormal and causes some CDNs to omit
      // the Access-Control-Allow-Origin header, breaking CORS and preventing
      // third-party scripts (like AccessEnabler-dependent consent flows) from
      // initializing before backgroundLogin fires.
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });

      // Expand the window and CSS viewport so nav bars render their full desktop layout.
      // Many streaming sites collapse the Login button or TV Provider link when the
      // viewport is narrower than ~1400px.
      //
      // Target: 1920×1080, but capped at the actual screen size so elements are never
      // rendered beyond the physical display boundary (which breaks form interaction on
      // smaller monitors, e.g. 1312px-wide screens).
      //
      // Two approaches used together:
      //   1. Browser.setWindowBounds (CDP) — physically resizes the OS window.
      //      Two calls required: first un-minimize, then resize (state change must settle).
      //   2. page.setViewport() — sets the CSS layout viewport. This is what CSS media
      //      queries actually measure, so it works even if the physical window can't resize.
      // The window is re-minimized in the finally block after login completes.

      // Query the actual screen dimensions from the browser before resizing.
      // window.screen.availWidth/Height excludes taskbars; fall back to screen.width/height.
      let targetWidth = 1920, targetHeight = 1080;
      try {
        const screenSize = await page.evaluate(() => ({
          w: window.screen.availWidth  || window.screen.width  || 1920,
          h: window.screen.availHeight || window.screen.height || 1080,
        }));
        targetWidth  = Math.min(screenSize.w, 1920);
        targetHeight = Math.min(screenSize.h, 1080);
        logTS(`Login: screen ${screenSize.w}×${screenSize.h} → target viewport ${targetWidth}×${targetHeight}`);
      } catch (_) {}

      try {
        const session = await page.createCDPSession();
        const { windowId } = await session.send('Browser.getWindowForTarget');
        // Step 1: un-minimize
        await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
        await delay(300);
        // Step 2: resize to target dimensions, keeping the window on the encoder's configured monitor
        await session.send('Browser.setWindowBounds', { windowId, bounds: { left: encoderLeft, top: encoderTop, width: targetWidth, height: targetHeight } });
        await session.detach();
      } catch (_) {}
      // Set CSS viewport explicitly — this is what responsive CSS media queries respond to.
      try {
        await page.setViewport({ width: targetWidth, height: targetHeight, deviceScaleFactor: 1 });
      } catch (_) {}
      await page.bringToFront();
      await delay(500); // allow the window to render at full size

      const isLoggedIn = await checkLogin(page, siteConfig);

      if (isLoggedIn) {
        // For DirecTV, checkLogin may leave the page at /user-profiles or with a scores
        // overlay pending. handleDirectvPostLogin is a near-instant no-op when neither
        // interstitial is present, so it's safe to call on every "already logged in" result.
        if (siteConfig.id === 'directv') {
          await handleDirectvPostLogin(page);
        }
        statusCallback({ type: 'already_logged_in', encoderIndex, encoderUrl });
        successCount++;
        continue;
      }

      statusCallback({ type: 'logging_in', encoderIndex, encoderUrl });

      const result = await performLogin(page, siteConfig, {
        username,
        password,
        tveProviderName,
        tveProviderUsername,
        tveProviderPassword,
      });

      if (result.success) {
        statusCallback({ type: 'success', encoderIndex, encoderUrl });
        successCount++;
      } else {
        statusCallback({ type: 'error', encoderIndex, encoderUrl, message: result.message });
        failCount++;
      }

    } catch (e) {
      logTS(`Login error for encoder ${label}: ${e.message}`);
      statusCallback({ type: 'error', encoderIndex, encoderUrl, message: e.message });
      failCount++;
    } finally {
      if (page) {
        try { await page.close(); } catch (_) {}
      }
      // Re-minimize the browser window via CDP
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          const session = await pages[0].createCDPSession();
          const { windowId } = await session.send('Browser.getWindowForTarget');
          await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
          await session.detach();
        }
      } catch (_) {}
    }
  }

  statusCallback({ type: 'complete', success: successCount, failed: failCount });
}

module.exports = { LOGIN_SITES, loginEncoders, loginSling, loginDirectv };
