/*
 * The browser side every suite shares: one Chromium, a context per viewport (signed in with the side's saved session, or
 * not), page settling, the facts code can measure on a page, screenshot slices, marked screenshots, and the Run each
 * suite is handed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Locator, type Page } from 'playwright';
import type { Config, Screen, Side } from './config.ts';
import { expected, type Finding } from './report.ts';

export type Viewport = Config['viewports'][number];
export type Hit = { url: string; method: string; type: string; status: number; contentType: string; ms: number; bytes: number; page: string; json?: 'ok' | 'invalid'; body?: string; keys?: string[] }; // keys: a JSON body's top-level keys, from the whole body (body is its first 400 characters)
export type Visited = { path: string; status: number; finalPath: string; ms: number; errors: string[]; links: string[] };
/** One side's run: its config, where its evidence goes, its saved session, and what its crawl found (contract and security read it). */
export type Run = {
    cfg: Config; side: Side; dir: string; auth?: string;
    record: (f: Omit<Finding, 'side'>) => void;
    crawl: { pages: Visited[]; hits: Hit[]; done: boolean };
    part?: string; // the part running now, and inside a flow its step: what a recording and a reached route are filed under
    step?: string;
    reached?: Reach[]; // what the run touched, for hits.json and the coverage map (src/coverage.ts)
    prefix?: string; // printed before each of a flow's step lines when flows run in parallel: "[flow-checkout] "
    scoped?: boolean; // ONLY or CHANGED chose the parts: a pass from t.mark gets its marked screenshot too
};
/** One thing a part touched: "GET /orders", "dialog <name>", "table <headers>: sort". */
export type Reach = { part: string; step?: string; what: string };
export type Recording = { side: string; part: string; label: string; videos: string[]; trace?: string };
/** Every recording of the run (RECORD=1), for the report. */
export const recordings: Recording[] = [];

const seconds = (name: string, env: NodeJS.ProcessEnv) => {
    const n = Number(env[name] ?? 0);
    if (!(n >= 0)) throw new Error(`${name} must be a number, 0 or more (got "${env[name]}").`);
    return n;
};
/** How the run's browser starts: HEADED=1 shows it, SLOWMO=<ms> waits that long between its actions; `args` are the config's browser.args. */
export const launchOptions = (env = process.env, args: string[] = []) => ({ headless: env.HEADED !== '1', slowMo: seconds('SLOWMO', env), ...(args.length ? { args } : {}) });
/** START_DELAY=<s>: seconds to count down before the first action (time to start a screen recording). */
export const startDelay = (env = process.env) => seconds('START_DELAY', env);

let browser: Browser | null = null;
const live = new Set<BrowserContext>(); // recorded contexts not closed yet
/** The run's one Chromium; `args` (browser.args) count on the call that starts it. */
export async function launch(args: string[] = []) {
    browser ??= await chromium.launch(launchOptions(process.env, args));
    return browser;
}
/** Closes the browser. A recorded context a suite left open is closed first, so its video and trace are still written. */
export const closeBrowser = async () => {
    for (const ctx of [...live]) await ctx.close().catch(() => {});
    await browser?.close();
    browser = null;
};

/** Counts down START_DELAY seconds, in the terminal and (headed) in the browser window. */
export async function countdown(s = startDelay()) {
    if (!s) return;
    const ctx = launchOptions().headless ? null : await (await launch()).newContext();
    const page = await ctx?.newPage();
    for (let left = Math.ceil(s); left > 0; left--) {
        process.stdout.write(`\rStarting in ${left} s… `);
        await page?.setContent(`<body style="font:48px system-ui;display:grid;place-items:center;height:90vh">tapcheck starts in ${left}…</body>`).catch(() => {});
        await new Promise((done) => setTimeout(done, 1000));
    }
    process.stdout.write('\n');
    await ctx?.close();
}

/** Files `what` under the part (and flow step) running now, once. */
export function reach(r: Run, what: string, step = r.step) {
    const list = (r.reached ??= []), part = r.part ?? '';
    if (!list.some((x) => x.part === part && x.step === step && x.what === what)) list.push({ part, ...(step ? { step } : {}), what });
}
const ASSET = ['image', 'font', 'stylesheet', 'script', 'media', 'manifest'];
/** Answers that mean the app refused the request or has no such route: not reached. */
export const REFUSED = [401, 403, 404, 405];

/** The method the app routes a request by: a form POST that says `_method` (Laravel, Rails, Symfony) or an override header is that method. */
export function routedMethod(q: { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }): string {
    if (q.method() !== 'POST') return q.method();
    let body = '';
    try { body = q.postData() ?? ''; } catch { /* a body that isn't text */ }
    const said = q.headers()['x-http-method-override'] ?? new URL(q.url()).searchParams.get('_method')
        ?? body.match(/(?:^|&)_method=([A-Za-z]+)(?:&|$)|name="_method"\r?\n\r?\n([A-Za-z]+)|"_method"\s*:\s*"([A-Za-z]+)"/)?.slice(1).find(Boolean);
    return said && /^(PUT|PATCH|DELETE)$/i.test(said) ? said.toUpperCase() : 'POST';
}

/** A screen's address: a path on the side's base URL, or a full URL as given. */
export const abs = (r: Run, path: string) => (/^https?:\/\//.test(path) ? path : r.side.baseUrl + path);
export const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
// Hosts where each name under them is someone else's site, so the app's site is the full name.
const SHARED = /\.(vercel\.app|netlify\.app|github\.io|herokuapp\.com|pages\.dev|workers\.dev|onrender\.com|fly\.dev|web\.app|firebaseapp\.com|azurewebsites\.net|cloudfront\.net|amazonaws\.com|appspot\.com|ngrok-free\.app|ngrok\.io|railway\.app|up\.railway\.app|localhost)$/;
/**
 * The site a URL belongs to: its domain without subdomains (app.example.com and api.example.com are both example.com),
 * so an app's own API on another subdomain counts as the app. A bare host, an IP address and a name on a shared host
 * (my-app.vercel.app) stand alone.
 */
// ponytail: last two labels (three for co.uk-style names: a two-letter country under co, com, org, net, ac, gov or edu), not
// the public suffix list; add a list entry if a shared host is missed
export const site = (u: string) => {
    let h: string;
    try { h = new URL(u).hostname; } catch { return ''; }
    if (!h.includes('.') || /^[\d.]+$|:/.test(h) || SHARED.test(h)) return h;
    const parts = h.split('.');
    const n = parts.length > 2 && parts.at(-1)!.length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(parts.at(-2)!) ? 3 : 2;
    return parts.slice(-n).join('.');
};
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48) || 'unlabelled';

/**
 * A context at this viewport: signed in with the side's session unless auth is false. Every suite and flow gets its
 * contexts here, so two things hold for all of them: each answered request to the side's own site is filed for the
 * coverage map (one to another of its hosts, an API at api.<domain>, with that host before the path), and with RECORD=1 the context records a video per page (<side dir>/videos/) and a Playwright trace
 * (<side dir>/traces/), written when the context closes.
 */
/** The contexts that carry the side's session (and still have it). */
const authed = new WeakSet<BrowserContext>();

/** A local storage entry that holds a sign-in rather than what the user chose (a filter, a tab, a theme). */
const SIGN_IN = /auth|token|session|jwt|cred|sb-/i;
/**
 * Saves the session `ctx` ends with to `file`: every cookie, and of local storage only the sign-in entries. Every other
 * entry stays as it was saved at sign-in, so what a run clicked (a filter, a tab) isn't carried into the next part or run.
 */
async function keep(ctx: BrowserContext, file: string) {
    type State = Awaited<ReturnType<BrowserContext['storageState']>>;
    const now = await ctx.storageState();
    let was: State = { cookies: [], origins: [] };
    try { was = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none saved yet: only the sign-in entries */ }
    const origins = [...new Set([...was.origins, ...now.origins].map((o) => o.origin))].map((origin) => {
        const before = was.origins.find((o) => o.origin === origin)?.localStorage ?? [], after = now.origins.find((o) => o.origin === origin)?.localStorage ?? [];
        const fresh = new Map(after.map((e) => [e.name, e.value]));
        const localStorage = before.filter((e) => !SIGN_IN.test(e.name) || fresh.has(e.name)).map((e) => (SIGN_IN.test(e.name) ? { name: e.name, value: fresh.get(e.name)! } : e));
        for (const e of after) if (SIGN_IN.test(e.name) && !before.some((b) => b.name === e.name)) localStorage.push(e);
        return { origin, localStorage };
    }).filter((o) => o.localStorage.length);
    writeFileSync(file, JSON.stringify({ cookies: now.cookies, origins }, null, 2));
}

export async function context(r: Run, vp: Viewport, auth = true, bypassCSP = false, more: BrowserContextOptions = {}): Promise<BrowserContext> {
    const record = process.env.RECORD === '1';
    const ctx = await (await launch()).newContext({ ...(auth && r.auth ? { storageState: r.auth } : {}), viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1, isMobile: vp.mobile, hasTouch: vp.mobile, bypassCSP, ...(record ? { recordVideo: { dir: `${r.dir}/videos` } } : {}), ...more });
    if (auth && r.auth) {
        authed.add(ctx);
        // Sessions whose tokens rotate (Supabase, Auth0, Cognito) are good only in their latest copy: keep it for the next
        // context and the next run, unless this one found the session gone.
        const close = ctx.close.bind(ctx);
        ctx.close = async (...a) => { if (authed.delete(ctx)) await keep(ctx, r.auth!).catch(() => {}); return close(...a); };
    }
    const own = host(r.side.baseUrl), mine = site(r.side.baseUrl);
    // Reached: a request to the app itself that it didn't refuse (401, 403, 405) or not find (404). Page assets aside.
    ctx.on('response', (res) => {
        const q = res.request();
        if (site(q.url()) !== mine || ASSET.includes(q.resourceType()) || REFUSED.includes(res.status())) return;
        const u = new URL(q.url());
        reach(r, `${routedMethod(q)} ${u.host === own ? '' : u.host}${u.pathname}`);
    });
    if (!record) return ctx;

    const label = `${r.part ?? 'run'}-${vp.name}${auth ? '' : '-signed-out'}`;
    const name = `${String(recordings.length + 1).padStart(3, '0')}-${slug(label).replace(/_/g, '-')}`;
    const rec: Recording = { side: r.side.name, part: r.part ?? '', label, videos: [], trace: `${r.dir}/traces/${name}.zip` };
    recordings.push(rec); // now, so the number in the name is taken
    const pages: Page[] = [];
    ctx.on('page', (p) => pages.push(p));
    await ctx.tracing.start({ screenshots: true, snapshots: true, title: label });
    live.add(ctx);
    const close = ctx.close.bind(ctx);
    ctx.close = async (...a) => {
        if (!live.delete(ctx)) return close(...a);
        await ctx.tracing.stop({ path: rec.trace }).catch(() => { rec.trace = undefined; });
        await close(...a); // the videos are complete once the context is closed
        for (const [i, p] of pages.entries()) {
            const file = `${r.dir}/videos/${name}${i ? `-${i + 1}` : ''}.webm`;
            if (await p.video()?.saveAs(file).then(() => true, () => false)) rec.videos.push(file);
            await p.video()?.delete().catch(() => {}); // the copy under Playwright's own random name
        }
    };
    return ctx;
}

/** Console errors and uncaught page errors, collected from now on. With `base` (the side's base URL), not those raised
 * while the page is on another site: a click on "Continue with …" leaves for that site's own page, whose errors aren't the app's. */
export function watch(page: Page, base?: string) {
    const errors: string[] = [];
    const away = () => { const at = site(page.url()); return !!base && !!at && at !== site(base); };
    page.on('pageerror', (e) => !away() && errors.push(e.message));
    // Not the page's own: a trace (RECORD=1) puts a script in every frame, and a sandboxed frame refuses it out loud.
    page.on('console', (m) => m.type() === 'error' && !away() && !/Blocked script execution in .* sandboxed/.test(m.text()) && errors.push(m.text()));
    return errors;
}

/**
 * Network idle, then the DOM quiet for 500 ms (at most 5 s more), so late-rendering widgets are judged as people see them.
 * page.evaluate has no timeout, and a page's own timers never fire when its CSP sandboxes it without allow-scripts (an
 * email preview, say) or its main thread never yields, so the 6 s cap is kept here, outside the page.
 */
export async function settle(page: Page) {
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    let cap: NodeJS.Timeout | undefined;
    const outside = new Promise<void>((done) => { cap = setTimeout(done, 6000); });
    const quiet = page.evaluate(() => new Promise<void>((done) => {
        let timer = setTimeout(finish, 500);
        const cap = setTimeout(finish, 5000);
        const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 500); });
        obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        function finish() { obs.disconnect(); clearTimeout(timer); clearTimeout(cap); done(); }
    })).catch(() => {});
    await Promise.race([quiet, outside]);
    clearTimeout(cap);
}

export class SessionExpired extends Error {}
// LOGIN=1 only does something on a manual side; form and command sides sign in afresh on every run.
const again = (r: Run) => ('manual' in r.side.login ? 'run again with LOGIN=1' : 'it ended during the run, or this user may not open that page');
/** Being sent to a sign-in page on a side that signs in means the session is gone: stop rather than audit the login page. */
export function guard(r: Run, requested: string, landed: string) {
    if ('none' in r.side.login) return;
    if (r.cfg.loginPaths.test(new URL(landed).pathname) && !r.cfg.loginPaths.test(requested.split('?')[0])) {
        throw new SessionExpired(`Sent to sign in at ${landed}: the ${r.side.name} session has expired (${again(r)}).`);
    }
}
/** guard, and on a signed-in page also the side's `signedIn` selector: an app that shows its sign-in form in place, at
 * the same address (a hash-routed app), sends no one anywhere, so only what is on the page tells. */
export async function signedIn(r: Run, page: Page, requested: string) {
    if (!authed.has(page.context())) return guard(r, requested, page.url());
    try {
        guard(r, requested, page.url());
        if (r.side.signedIn && !(await page.locator(r.side.signedIn).first().waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false))) {
            throw new SessionExpired(`${requested} has no ${r.side.signedIn} on it: the ${r.side.name} session has expired (${again(r)}).`);
        }
    } catch (e) {
        authed.delete(page.context()); // not saved over the last good copy
        throw e;
    }
}

/** A hash route (`/#scanner`, `/#/orders`): an app that routes in the fragment shows a different screen for each. */
export const hashRoute = (path: string) => /#[!/]?[A-Za-z]/.test(path);

/** Where the page is, as a path: the hash too when `path` (what was asked for) is a hash route. */
export function here(url: string, path: string) {
    const u = new URL(url);
    return u.pathname + (hashRoute(path) ? u.hash : '');
}

/** A hash screen that opened is reached as "GET /#scanner": the request the browser sent for it only says "GET /". */
export function reachHash(r: Run, page: Page, path: string, status = 0) {
    if (hashRoute(path) && status >= 200 && status < 400) reach(r, `GET ${here(page.url(), path)}`);
}

/** page.goto as a document load. Going to another hash of the page that's open only changes the fragment: the browser
 * sends nothing, so there is no response (status 0) and the app may not start afresh. Leave the page first. */
export async function load(page: Page, url: string, opts: Parameters<Page['goto']>[1] = { waitUntil: 'domcontentloaded' }) {
    if (url.includes('#') && page.url().split('#')[0] === url.split('#')[0]) await page.goto('about:blank');
    return page.goto(url, opts);
}

/** Opens a page of the app and waits for it to settle. A load that fails (a timeout on a busy app, a navigation
 * aborted or cut short by another) is tried once more before the error counts; a download is not a page and isn't. */
export async function open(r: Run, page: Page, path: string) {
    const go = () => load(page, abs(r, path));
    const res = await go().catch(async (e: Error) => {
        if (/Download is starting/.test(e.message)) throw e;
        await page.waitForTimeout(1000);
        return go();
    });
    await settle(page);
    await signedIn(r, page, path);
    reachHash(r, page, path, res?.status());
    return res;
}

/** A screen's path: given directly, or the first link on `from` whose path matches `link`. Null when no link matches. */
export async function resolve(r: Run, page: Page, s: Screen): Promise<string | null> {
    if (s.path) return s.path;
    await open(r, page, s.from!);
    const re = new RegExp(s.link!, 'i');
    const hrefs = await page.$$eval('a[href]', (as) => as.map((a) => (a as HTMLAnchorElement).pathname));
    const hit = hrefs.find((h) => re.test(h));
    return hit ? hit + (s.suffix ?? '') : null;
}

/**
 * The screen as up to `max` viewport-sized slices, top to bottom, saved as <run dir>/shots/<key>-<n>.png (Jev takes
 * images 280–1568 px a side). When the document scrolls less than a quarter of the viewport but a panel in it scrolls (an
 * app shell with its content in a scrolling main area), the largest such panel is scrolled instead, a panel's height at
 * a time: a document that scrolls a few pixels would give the same screen twice.
 */
type Frac = { left: number; right: number; top: number; bottom: number };
/**
 * What is in the window as it is now, as fractions of it (as Jev's boxes are): the rows that scroll sideways (a rail of
 * chips with a › button, a wide table), the small controls fixed in place over the page (a chat button), text
 * shortened on purpose (an ellipsis by CSS, or "…" in the text itself), and where two lines of text or controls are
 * drawn on each other: neither inside the other, both visible (clipped to what their scrolling parents show), and in one
 * layer, so not one that scrolls past the other (a chip under a row's › button, rows under a sticky header or a chat button);
 * and text cut off: by a parent that hides what overflows it, or by the side of the window, not shortened with "…" and not
 * in a row that scrolls sideways.
 */
export const layout = (page: Page) => page.evaluate(() => {
    const rails: Frac[] = [], floaters: Frac[] = [], shortened: Frac[] = [], overlaps: Frac[] = [], cuts: Frac[] = [];
    const frac = (b: DOMRect) => ({ left: b.left / innerWidth, right: b.right / innerWidth, top: b.top / innerHeight, bottom: b.bottom / innerHeight });
    for (const el of document.querySelectorAll('body *')) {
        const s = getComputedStyle(el), b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0 || b.bottom <= 0 || b.top >= innerHeight || s.visibility === 'hidden') continue;
        if (/auto|scroll|hidden/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 4 && b.width >= 100) rails.push(frac(b));
        if (s.position === 'fixed' && b.width < innerWidth * 0.4 && b.height < innerHeight * 0.3) floaters.push(frac(b));
        const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
        if (own && ((s.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth) || /(…|\.\.\.)$/.test(own))) shortened.push(frac(b));
    }
    // Each line of visible text and each control, with the element it belongs to, cut to what the window and its
    // scrolling or clipping parents show, and its layer: the nearest fixed or sticky parent or row that scrolls sideways.
    const pieces: { el: Element; b: DOMRect; layer: Element | null }[] = [];
    const layers = new Map<Element, Element | null>();
    const layer = (el: Element | null): Element | null => {
        if (!el || el === document.body) return null;
        if (layers.has(el)) return layers.get(el)!;
        const s = getComputedStyle(el);
        const own = /fixed|sticky/.test(s.position) || (/auto|scroll/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 4) ? el : layer(el.parentElement);
        layers.set(el, own);
        return own;
    };
    const shown = (el: Element, b: DOMRect) => {
        let l = Math.max(b.left, 0), t = Math.max(b.top, 0), r = Math.min(b.right, innerWidth), btm = Math.min(b.bottom, innerHeight);
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
            const c = p.getBoundingClientRect();
            l = Math.max(l, c.left); t = Math.max(t, c.top); r = Math.min(r, c.right); btm = Math.min(btm, c.bottom);
        }
        return r - l > 0 && btm - t > 0 ? new DOMRect(l, t, r - l, btm - t) : null;
    };
    const add = (el: Element, b: DOMRect) => { const v = shown(el, b); if (v) pieces.push({ el, b: v, layer: layer(el) }); };
    // What of a line of text a parent that hides its overflow, or a side of the window, leaves to be seen; the page
    // scrolling up and down shows the rest, so the window's top and bottom don't cut.
    const cut = (el: Element, b: DOMRect) => {
        if (b.bottom <= 0 || b.top >= innerHeight) return;
        let l = Math.max(b.left, 0), t = b.top, r = Math.min(b.right, innerWidth), btm = b.bottom;
        for (let p: Element | null = el; p && p !== document.body; p = p.parentElement) {
            const s = getComputedStyle(p);
            if (p !== el && /auto|scroll/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 4) return; // a row that scrolls sideways
            if (s.textOverflow === 'ellipsis') return; // shortened with "…"
            const c = p.getBoundingClientRect();
            if (p !== el || el.childElementCount === 0) {
                if (/hidden|clip/.test(s.overflowX)) { l = Math.max(l, c.left); r = Math.min(r, c.right); }
                if (/hidden|clip/.test(s.overflowY)) { t = Math.max(t, c.top); btm = Math.min(btm, c.bottom); }
            }
        }
        // A sliver left (a visually hidden label, 1 px) is hidden, not cut; most of it shown is whole.
        if (r - l >= 4 && btm - t >= 4 && (r - l) * (btm - t) < b.width * b.height * 0.9) cuts.push(frac(new DOMRect(l, Math.max(t, 0), r - l, Math.min(btm, innerHeight) - Math.max(t, 0))));
    };
    const visible = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n && pieces.length < 3000; n = w.nextNode()) {
        const el = n.parentElement;
        if (!n.textContent?.trim() || !el || !visible(el)) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        for (const b of range.getClientRects()) { add(el, b); cut(el, b); }
    }
    for (const el of document.querySelectorAll('button, input, select, textarea, [role=button]')) if (visible(el)) add(el, el.getBoundingClientRect());
    // ponytail: every pair, O(n²) over at most ~3000 pieces in the window; a grid of cells if a page ever has far more.
    for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i], c = pieces[j];
        if (a.layer !== c.layer) continue;
        const x = Math.min(a.b.right, c.b.right) - Math.max(a.b.left, c.b.left), y = Math.min(a.b.bottom, c.b.bottom) - Math.max(a.b.top, c.b.top);
        if (x <= 2 || y <= 2 || a.el.contains(c.el) || c.el.contains(a.el)) continue;
        overlaps.push(frac(new DOMRect(Math.max(a.b.left, c.b.left), Math.max(a.b.top, c.b.top), x, y)));
    }
    return { rails, floaters, shortened, overlaps, cuts };
}).catch(() => ({ rails: [] as Frac[], floaters: [] as Frac[], shortened: [] as Frac[], overlaps: [] as Frac[], cuts: [] as Frac[] }));
/**
 * The visible controls in the window whose name says they open help: "Help", "FAQ", "Ask …" (an assistant), "Chat",
 * "Learn", "… guide", "?". Whole names only, so a word of the product's own ("support" as a price level) doesn't count.
 */
export const helpControls = (page: Page) => page.evaluate(() => [...new Set([...document.querySelectorAll('a[href], button, [role=button], summary')].flatMap((el) => {
    const b = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (b.width === 0 || b.height === 0 || b.bottom <= 0 || b.top >= innerHeight || b.right <= 0 || b.left >= innerWidth || s.visibility === 'hidden') return [];
    const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return /^(help|faq|support|contact( us)?|chat|docs?|documentation|tutorials?|learn(ing)?|getting started|how it works)\b|^ask\b|\bguide$|^\?$/i.test(name) && name.length <= 40 ? [name] : [];
}))]).catch(() => [] as string[]);

/**
 * Where the text of each item of the opened menu or dialog ([data-tapcheck-popup]) starts: the items that hold no other
 * item, with how many there are and how far apart their starts are, in px. Items laid out in a row are far apart, so
 * only a column whose items start together reads as in line.
 */
export const itemStarts = (page: Page) => page.evaluate(() => {
    const root = document.querySelector('[data-tapcheck-popup]');
    if (!root) return null;
    const ITEM = '[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],li,button,a';
    const items = [...root.querySelectorAll(ITEM)].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !el.querySelector(ITEM); });
    if (items.length < 2) return null;
    const starts = items.map((el) => {
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent?.trim()) { const r = document.createRange(); r.selectNodeContents(n); return r.getBoundingClientRect().left; }
        return el.getBoundingClientRect().left;
    });
    return { n: items.length, spread: Math.round(Math.max(...starts) - Math.min(...starts)) };
}).catch(() => null);

/** layout() at the moment each slice was taken, by its file: Jev's boxes on a slice are read against it. */
export const shotLayout = new Map<string, Awaited<ReturnType<typeof layout>>>();

export async function slices(r: Run, page: Page, key: string, height: number, vh: number, max = 3) {
    mkdirSync(`${r.dir}/shots`, { recursive: true });
    const panel = height >= vh * 1.25 ? null : await page.evaluate(() => {
        let best: Element | null = null, area = 0;
        for (const el of document.querySelectorAll('body *')) {
            if (el.scrollHeight <= el.clientHeight + 1 || !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
            const b = el.getBoundingClientRect(), a = Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0));
            if (a > area) { best = el; area = a; }
        }
        if (!best || area < innerWidth * innerHeight * 0.25) return null; // a small list, not the screen's content
        best.setAttribute('data-tapcheck-slices', '');
        return { total: best.scrollHeight, step: best.clientHeight, at: best.scrollTop };
    });
    const total = panel?.total ?? height, step = panel?.step ?? vh;
    const n = Math.min(max, Math.max(1, Math.ceil(total / step)));
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
        await page.evaluate((y) => { const el = document.querySelector('[data-tapcheck-slices]'); if (el) el.scrollTop = y; else scrollTo(0, y); }, i * step);
        await page.waitForTimeout(250);
        const file = `${r.dir}/shots/${key}-${i + 1}.png`;
        await page.screenshot({ path: file });
        shotLayout.set(file, await layout(page));
        out.push(file);
    }
    await page.evaluate((at) => {
        const el = document.querySelector('[data-tapcheck-slices]');
        if (el) { el.scrollTop = at; el.removeAttribute('data-tapcheck-slices'); } else scrollTo(0, 0);
    }, panel?.at ?? 0);
    return out;
}

export type Control = { tag: string; role: string; label: string; x: number; y: number; w: number; h: number; href?: string };

/** What code measures exactly: sideways scroll, broken images, off-screen and small controls, text coverage, headings. */
export async function facts(page: Page) {
    return page.evaluate(() => {
        const vw = innerWidth, vh = innerHeight;
        const visible = (el: Element) => {
            const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && !el.closest('[aria-hidden=true]');
        };
        // Tagged for a marked screenshot (MARK=1), as the other measured elements are.
        const broken = [...document.images].filter((i) => visible(i) && i.complete && i.naturalWidth === 0).map((i) => { i.setAttribute('data-tapcheck-mark-broken', 'does not load'); return i.currentSrc || i.src; });
        const els = [...document.querySelectorAll('a[href], button, [role=button], input:not([type=hidden]), select, textarea, summary')].filter(visible).slice(0, 250);
        const controls = els.map((el) => {
                const r = el.getBoundingClientRect();
                const label = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).placeholder || '')
                    .replace(/\s+/g, ' ').trim().slice(0, 60);
                return { tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', label, x: Math.round(r.left), y: Math.round(r.top + scrollY),
                    w: Math.round(r.width), h: Math.round(r.height), href: (el as HTMLAnchorElement).href || undefined };
            });
        // Text coverage of the first screen: the share of the viewport covered by text runs (negative space is what's left).
        let ink = 0;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (!n.textContent?.trim() || !n.parentElement || !visible(n.parentElement)) continue;
            range.selectNodeContents(n);
            for (const r of range.getClientRects()) {
                ink += Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            }
        }
        // WCAG 2.2 target size (2.5.8): controls in the first screen smaller than 24 × 24 px, inline text links aside.
        // Off-screen: past the viewport's left or right edge, unless in a rail that scrolls sideways (its chips are a swipe away).
        const rail = (el: Element) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (p.scrollWidth > p.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(p).overflowX)) return true; return false; };
        const off = controls.filter((c, i) => (c.x < -1 || c.x + c.w > vw + 1) && !rail(els[i]));
        const small = controls.filter((c) => c.y < vh && (c.w < 24 || c.h < 24) && c.tag !== 'a').map((c) => `${c.tag} "${c.label}" ${c.w}×${c.h}`);
        return {
            title: document.title, lang: document.documentElement.lang, overflowX: document.documentElement.scrollWidth > vw + 1,
            brokenImages: broken, offscreen: off.length, offscreenLabels: off.slice(0, 5).map((c) => c.label || `<${c.tag}>`), controls,
            height: document.documentElement.scrollHeight, textCoverage: Math.round((ink / (vw * vh)) * 1000) / 1000, smallTargets: small,
            h1: document.querySelectorAll('h1').length,
        };
    });
}

export type MarkKind = 'bug' | 'pass' | 'setting' | 'question';
/** One thing a marked screenshot points at: a selector or a Playwright locator (each element it matches gets a box), or a plain box in viewport pixels. */
export type Mark = { target: string | Locator | { x: number; y: number; width: number; height: number }; note?: string; kind?: MarkKind };
const KIND = { fail: 'bug', warn: 'question', info: 'setting', pass: 'pass' } as const;
const COLOUR: Record<MarkKind, string> = { bug: '#dc2626', pass: '#15803d', setting: '#2563eb', question: '#b45309' };
const MAX_MARKS = 8; // boxes per screenshot; the banner says how many more there are
let shotNo = 0; // in every marked screenshot's name: a slug is cut at 48 characters, so two could share one

type Drawn = { box?: { x: number; y: number; width: number; height: number }; note?: string; attr?: string; colour: string };
/**
 * Runs in the page: a box, a numbered marker and a note per target, in a layer above everything. Markers and notes go
 * where they cover no other marker or note (and, if they can, no other target). Returns how many targets weren't drawn.
 */
function draw({ marks, max }: { marks: Drawn[]; max: number }) {
    const vw = innerWidth, vh = innerHeight;
    const root = document.createElement('div');
    root.id = 'tapcheck-marks';
    root.style.cssText = 'position:fixed;inset:0;width:auto;height:auto;margin:0;border:0;padding:0;background:none;overflow:hidden;z-index:2147483647;pointer-events:none;font:600 13px/1.3 system-ui,sans-serif;color:#fff;text-align:left';
    document.documentElement.append(root);
    // The top layer, or an open modal dialog would cover the marks; where there is no popover the z-index has to do.
    try { root.popover = 'manual'; root.showPopover(); } catch { root.removeAttribute('popover'); }
    const add = (css: string, text: string) => { const d = document.createElement('div'); d.style.cssText = `position:absolute;box-sizing:border-box;${css}`; d.textContent = text; root.append(d); return d; };
    const all = marks.flatMap((m, i) => (m.box ? [{ ...m.box, note: m.note ?? '' }] : [...document.querySelectorAll(`[data-tapcheck-m${i}]`)].map((el) => {
        const b = el.getBoundingClientRect();
        return { x: b.left, y: b.top, width: b.width, height: b.height, note: m.note ?? (m.attr && el.getAttribute(m.attr)) ?? '' };
    })).map((b) => ({ ...b, colour: m.colour })));
    const shown = all.filter((b) => b.width > 0 && b.height > 0 && b.x < vw && b.y < vh && b.x + b.width > 0 && b.y + b.height > 0).slice(0, max);
    type Rect = { x: number; y: number; w: number; h: number };
    const labels: Rect[] = [];
    const boxes: Rect[] = shown.map((b) => ({ x: b.x - 3, y: b.y - 3, w: b.width + 6, h: b.height + 6 }));
    const hits = (a: Rect, b: Rect) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2;
    const inside = (v: number, size: number, limit: number) => Math.max(2, Math.min(v, limit - size - 2));
    // The nearest clear spot: the wanted ones, then each moved down or up a step at a time; one clear of the other labels
    // and the other targets, else of the other labels. A marker would rather cover a target than leave its box.
    const place = (w: number, h: number, want: [number, number][], own: number, marker = false) => {
        const steps = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6], others = boxes.filter((_, i) => i !== own);
        const spots = steps.flatMap((k) => want.map(([x, y]) => ({ x: inside(x, w, vw), y: inside(y + k * (h + 3), h, vh), w, h, k }))).filter((s) => !labels.some((l) => hits(s, l)));
        const clear = (s: Rect) => !others.some((b) => hits(s, b)), near = spots.filter((s) => s.k === 0);
        const spot = near.find(clear) ?? (marker ? near[0] : undefined) ?? spots.find(clear) ?? spots[0]
            ?? { x: inside(want[0][0], w, vw), y: inside(want[0][1], h, vh), w, h };
        labels.push(spot);
        return spot;
    };
    for (const b of shown) {
        const l = Math.max(0, b.x - 3), t = Math.max(0, b.y - 3); // 3 px around the element, cut at the window's edge
        add(`left:${l}px;top:${t}px;width:${Math.min(vw, b.x + b.width + 3) - l}px;height:${Math.min(vh, b.y + b.height + 3) - t}px;border:3px solid ${b.colour};border-radius:4px`, '');
    }
    // Every marker first, so each gets a spot by its box: on its top left corner, else another corner, else beside it.
    for (const [i, b] of shown.entries()) {
        const mid = b.y + b.height / 2 - 12;
        const m = place(24, 24, [[b.x - 14, b.y - 14], [b.x + b.width - 10, b.y - 14], [b.x - 14, b.y + b.height - 10], [b.x + b.width - 10, b.y + b.height - 10], [b.x - 28, mid], [b.x + b.width + 4, mid]], i, true);
        add(`left:${m.x}px;top:${m.y}px;width:24px;height:24px;border-radius:50%;background:${b.colour};border:2px solid #fff;display:grid;place-items:center;font-size:12px`, String(i + 1));
    }
    for (const [i, b] of shown.entries()) {
        if (!b.note) continue;
        // The note: right of the box (or of a marker beside it), left of it, at the right end inside it (a row as wide as the
        // window), under it or above it.
        const n = add(`max-width:300px;padding:3px 8px;border-radius:3px;background:${b.colour};border:1px solid #fff`, `${i + 1} ${b.note.length > 90 ? `${b.note.slice(0, 90).replace(/\s+\S*$/, '')}…` : b.note}`);
        const s = n.getBoundingClientRect();
        const at = place(s.width, s.height, [[b.x + b.width + 8, b.y], [b.x + b.width + 32, b.y], [b.x - 8 - s.width, b.y], [b.x - 32 - s.width, b.y], [b.x + b.width - s.width - 6, b.y], [b.x, b.y + b.height + 6], [b.x, b.y - 6 - s.height]]
            .filter(([x], k) => k > 4 || (x >= 0 && x + s.width <= vw && (k < 4 || b.width > 2 * s.width))) as [number, number][], i);
        n.style.left = `${at.x}px`;
        n.style.top = `${at.y}px`;
    }
    return all.length - shown.length; // past the cap, or not on this screen
}

/** `s` cut to `n` characters at a word, with "…" when anything was left out. */
export const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s·,;:—-]+$/, '')}…`);
let blank: Page | undefined; // where a screenshot gets its banner: a page of its own, so the app's own page is never covered
/** `png` with a banner above it, in the status's colour, saying the check and its detail; written to `file`. */
async function frame(png: Buffer, file: string, banner: { status: Finding['status']; title: string; detail?: string }, more = 0) {
    if (!blank || blank.isClosed()) blank = await (await (await launch()).newContext({ deviceScaleFactor: 1 })).newPage();
    const esc = (t: string) => t.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
    // The check's name says what should be true ("text is not cut off"), so the banner says it is the check that failed.
    const said = (banner as { expected?: boolean }).expected ? 'EXPECTED' : { fail: 'FAILED CHECK', warn: 'CHECK TO REVIEW', info: 'INFO', pass: 'PASSED CHECK' }[banner.status];
    const title = clip(`${said}: ${banner.title}`, 160) + (more ? ` (+${more} more)` : '');
    const detail = clip(banner.detail ?? '', 260);
    await blank.setContent(`<body style="margin:0;background:#fff"><div id="tapcheck-banner" style="padding:10px 16px;background:${COLOUR[KIND[banner.status]]};color:#fff;font:600 18px/1.3 system-ui,sans-serif">${esc(title)}${detail ? `<div style="font:400 14px/1.35 system-ui,sans-serif;margin-top:2px">${esc(detail)}</div>` : ''}</div><img style="display:block" src="data:image/png;base64,${png.toString('base64')}">`);
    const width = await blank.evaluate(async () => { const i = document.images[0]; await i.decode(); return i.naturalWidth; });
    await blank.setViewportSize({ width, height: 200 });
    await blank.screenshot({ path: file, fullPage: true });
}

/**
 * A marked screenshot, <run dir>/shots/marked-<n>-<name>.png: the page as it is with a box, a numbered marker and a note
 * on each target (at most 8; the banner counts the rest), under a banner in the status's colour (red fail, amber warn,
 * green pass, blue info) saying the check and its detail. The first target is scrolled into view. The overlay is drawn
 * in the page and taken out again, with the scroll position put back. Undefined when it couldn't be taken: a marked
 * screenshot is an extra, and never fails the check it shows.
 */
const name = (r: Run, label: string) => `${r.dir}/shots/marked-${String(++shotNo).padStart(3, '0')}-${slug(label)}.png`;
export async function marked(r: Run, page: Page, label: string, banner: { status: Finding['status']; title: string; detail?: string; of?: { suite: string; where: string } }, marks: Mark[] = []): Promise<string | undefined> {
    const file = name(r, label);
    // The banner says what the finding will say: an `expect` rule that matches makes it an expected info row.
    if (banner.of && r.cfg.expect?.length) {
        const f = expected({ suite: banner.of.suite, side: '', where: banner.of.where, check: banner.title, status: banner.status, detail: banner.detail }, r.cfg.expect);
        if (f.status !== banner.status) banner = { ...banner, status: f.status, detail: f.detail, expected: true } as typeof banner;
    }
    let at: number[] | undefined;
    try {
        mkdirSync(`${r.dir}/shots`, { recursive: true });
        const list: Drawn[] = [];
        for (const [i, m] of marks.entries()) {
            const t = m.target, box = typeof t !== 'string' && 'x' in t ? t : undefined;
            if (!box) await (typeof t === 'string' ? page.locator(t) : t as Locator).evaluateAll((els, a) => els.forEach((el) => el.setAttribute(a, '')), `data-tapcheck-m${i}`).catch(() => {});
            // An element a suite tagged while measuring carries its own note in the tag.
            list.push({ box, note: m.note, attr: typeof t === 'string' ? /^\[(data-tapcheck-mark-[a-z]+)\]$/.exec(t)?.[1] : undefined, colour: COLOUR[m.kind ?? KIND[banner.status]] });
        }
        at = await page.evaluate((n) => {
            const at = [scrollX, scrollY];
            for (let i = 0; i < n; i++) {
                const el = document.querySelector(`[data-tapcheck-m${i}]`);
                if (!el) continue;
                const b = el.getBoundingClientRect();
                if (b.top < 0 || b.left < 0 || b.bottom > innerHeight || b.right > innerWidth) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
                break;
            }
            return at;
        }, marks.length);
        // What is still moving (a sidebar closing after focus left it) settles first; endless ones (a spinner) are left.
        await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
            new Promise((done) => setTimeout(done, 1000))])).catch(() => {});
        const more = await page.evaluate(draw, { marks: list, max: MAX_MARKS });
        const png = await page.screenshot();
        await frame(png, file, banner, more);
        return file;
    } catch {
        return undefined;
    } finally {
        await page.evaluate(({ n, at }) => {
            document.getElementById('tapcheck-marks')?.remove();
            for (let i = 0; i < n; i++) document.querySelectorAll(`[data-tapcheck-m${i}]`).forEach((el) => el.removeAttribute(`data-tapcheck-m${i}`));
            if (at) scrollTo(at[0], at[1]);
        }, { n: marks.length, at }).catch(() => {});
    }
}

/**
 * With marks on, each fail and warning of `list` that has a screenshot but no marked one (what Jev judged, a failed flow
 * step) gets a copy of it with the banner alone, put first in its evidence. Jev says what is wrong, not where, so no
 * box is drawn, and a finding with several screenshots (a screen's slices) gets a banner on each of the first three:
 * what it is about may be on any of them.
 */
export async function banners(r: Run, list: Finding[]) {
    for (const f of list.filter((f) => (f.status === 'fail' || f.status === 'warn') && /\.png$/.test(f.evidence?.[0] ?? '') && !f.evidence![0].includes('/shots/marked-'))) {
        const shots = f.evidence!.filter((e) => /\.png$/.test(e)).slice(0, 3), done: string[] = [];
        for (const [i, shot] of shots.entries()) {
            const file = name(r, `${f.suite} ${f.where} ${f.check}`);
            try {
                mkdirSync(`${r.dir}/shots`, { recursive: true });
                await frame(readFileSync(shot), file, { status: f.status, title: f.check, detail: [f.where, f.detail, shots.length > 1 ? `screenshot ${i + 1} of ${shots.length}` : ''].filter(Boolean).join(' · ') });
                done.push(file);
            } catch { /* the screenshot is gone or isn't one: the finding stands without a banner */ }
        }
        if (done.length) f.evidence = [...done, ...f.evidence!]; // a new list: findings of one look share theirs
    }
}
