/*
 * Full UI audit, per screen (the configured screens, plus up to audit.max crawled pages; paths matching audit.skip are
 * left out). Measured by code; Jev only adds its look.
 * - desktop, light: text cut off or shortened with no way to read it, controls that overlap (and can't be scrolled
 *   apart, as a floating button and the page under it can), targets under 24 px (of at most 300 controls, those in the
 *   window first), leaked placeholders, heading levels, images without alt text, the focus ring on each Tab stop (a few
 *   from the top, then from the start of the main content); every menu and dialog the screen's markup says it opens
 *   (aria-haspopup, aria-expanded, popovertarget) is opened and, once it has loaded, measured the same way, plus
 *   whether it fits on the screen;
 * - desktop, dark (prefers-color-scheme: dark): axe's colour-contrast rule, which also catches text that became
 *   invisible (only what passes in light mode: the rest is the a11y suite's), and backgrounds that stayed white. A page
 *   whose own colours and large surfaces don't react to the colour scheme is one info finding;
 * - tablet (768 px) and phone (375 px): sideways scroll, cut-off text, overlap, small targets;
 * - across the screens: buttons and fields of one kind that come in several sizes, radii or colours (a field drawn by
 *   its wrapper is measured there; cards that are buttons and page numbers are left out), labels in Title Case next to
 *   labels in sentence case (not data: digits, prices, rows of a list), and, with `design:` in tapcheck.yml, computed colours, fonts, radii and
 *   spacing that are not among the tokens (warnings, the most used offenders first);
 * - Jev's look, when Jev is on: the VISUAL questions (src/questions.ts) about the desktop screen and about each opened
 *   menu and dialog, within the run's budget. With JEV=off or no key that is one info finding and the rest still runs.
 * It only opens menus and dialogs and closes them with Escape: never a control whose label is one of the usability
 * suite's UNSAFE words, never a submit button. audit.json holds everything found.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { device, mainViewport, type Config } from '../config.ts';
import { context, hashRoute, itemStarts, launch, marked, open, resolve, SessionExpired, settle, slices, slug, type Run, type Viewport } from '../browser.ts';
import { ask, BudgetReached, img, looked, whyOff } from '../jev.ts';
import { POPUP_VISUAL, VISUAL } from '../questions.ts';
import { AXE, toMain } from './a11y.ts';
import { UNSAFE } from './usability.ts';
import { visual } from './ux.ts';

const S = 'audit';
const NARROW: Viewport[] = [{ name: 'tablet', width: 768, height: 1024, mobile: false }, { name: 'phone', width: 375, height: 812, mobile: true }]; // only the chosen devices'
const WARN = new Set(['shortened text can be read in full', 'heading levels in order']); // the other measured checks fail
// The checks that know their elements: measure() tags each with data-tapcheck-mark-<this> (its value the element's note), for a marked screenshot.
const MARKS: Record<string, string> = { 'no sideways scroll': 'wide', 'text is not cut off': 'cut', 'shortened text can be read in full': 'short', 'controls do not overlap': 'overlap',
    'targets at least 24 px': 'small', 'images have alt text': 'alt' };
const TABS = 20, TOP = 5, MAX_POPUPS = 4;
/** How long a dialog's requests may run before it is judged; a test shortens it. */
export const timing = { popupLoad: 15_000 };

/**
 * The opened menu or dialog ([data-tapcheck-popup]) cut out of the screen, at least 280 px a side (the least Jev takes),
 * saved as `file`. Undefined when it fills most of the screen anyway (a full-screen dialog) or has no box.
 */
export async function popupShot(page: Page, file: string): Promise<string | undefined> {
    const vp = page.viewportSize();
    const b = await page.locator('[data-tapcheck-popup]').last().boundingBox().catch(() => null);
    if (!vp || !b || b.width * b.height > 0.6 * vp.width * vp.height) return undefined;
    const side = (start: number, size: number, limit: number) => {
        const s = Math.min(limit, Math.max(280, Math.ceil(size))), at = Math.max(0, Math.min(Math.floor(start - (s - size) / 2), limit - s));
        return [at, s];
    };
    const [x, width] = side(Math.max(0, b.x), Math.min(b.width, vp.width), vp.width), [y, height] = side(Math.max(0, b.y), Math.min(b.height, vp.height), vp.height);
    await page.screenshot({ path: file, clip: { x, y, width, height } });
    return file;
}

const POPUP = '[role=menu], [role=listbox], dialog[open], [role=dialog], [role=alertdialog], [popover]:popover-open';
// ponytail: primary, secondary and danger is the most a button kind gets before its colours count as inconsistent; fields get one.
const PAINTS: Record<string, number> = { button: 3, 'icon button': 3, 'text button': 2 };
const EXAMPLES = 150; // controls and labels cut out of their screens, for the consistency findings' example sheets
const SHEET_ROWS = 8;

/**
 * One image for a finding across the screens: a row per look, each with an example cut out of its screen, what the
 * look is, and the swatches of the colours it names. Written to `file`; undefined when no row has an example.
 */
export async function sheet(file: string, title: string, rows: { file?: string; text: string; at?: string }[]) {
    const shown = rows.filter((x) => x.file && existsSync(x.file)).slice(0, SHEET_ROWS);
    if (!shown.length) return undefined;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const swatches = (t: string) => (t.match(/(rgba?|color)\([^)]*\)/g) ?? []).map((c) => `<i style="display:inline-block;width:14px;height:14px;border:1px solid #999;border-radius:3px;vertical-align:-2px;margin:0 2px;background:${c}"></i>`).join('');
    const more = rows.length - shown.length;
    const page = await (await launch()).newPage({ viewport: { width: 960, height: 200 } });
    try {
        await page.setContent(`<body style="margin:0;background:#fff;font:14px/1.4 system-ui,sans-serif;color:#111"><div style="padding:10px 16px;background:#b45309;color:#fff;font-weight:600">${esc(title)}</div>`
            + shown.map((x, i) => `<div style="display:flex;gap:16px;align-items:center;padding:10px 16px;border-bottom:1px solid #e5e7eb"><b style="width:20px">${i + 1}</b>`
                + `<div style="width:320px;display:flex;justify-content:center;background:repeating-conic-gradient(#f3f4f6 0 25%,#fff 0 50%) 0 0/12px 12px;padding:6px;border-radius:4px"><img style="max-width:308px;max-height:90px" src="data:image/png;base64,${readFileSync(x.file!).toString('base64')}"></div>`
                + `<div style="flex:1">${esc(x.text)}${swatches(x.text) ? `<div style="margin-top:4px">${swatches(x.text)}</div>` : ''}${x.at ? `<div style="color:#6b7280">first on ${esc(x.at)}</div>` : ''}</div></div>`).join('')
            + (more > 0 ? `<div style="padding:8px 16px;color:#6b7280">+${more} more, listed in the finding and in audit.json</div>` : '') + '</body>');
        // An example that came out as one flat colour (the control was moving or covered when it was cut out) says so.
        await page.evaluate(async () => {
            for (const im of [...document.images]) {
                await im.decode().catch(() => {});
                const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
                const g = c.getContext('2d')!; g.drawImage(im, 0, 0);
                const d = g.getImageData(0, 0, c.width, c.height).data;
                let flat = true;
                for (let i = 4; i < d.length && flat; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 24) flat = false;
                if (flat) im.replaceWith(Object.assign(document.createElement('span'), { textContent: 'no example: it was blank when cut out', style: 'color:#6b7280;font-size:12px' }));
            }
        });
        await page.screenshot({ path: file, fullPage: true });
        return file;
    } finally {
        await page.close();
    }
}

type Item = { kind: string; shape: string; paint: string; label: string };

/**
 * Runs in the page. Measures everything under `root` (a selector; the whole page without one). `extras` adds the
 * desktop-only checks and collects the controls, labels and (with `design`) the styles outside the tokens.
 */
function measure({ root: rootSel, extras, design }: { root?: string; extras: boolean; design?: Config['design'] }) {
    const root = (rootSel && document.querySelector(rootSel)) || document.body;
    const vw = innerWidth, vh = innerHeight;
    const visible = (el: Element) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && Number(s.opacity) > 0 && !el.closest('[aria-hidden=true], [hidden]'); };
    const txt = (el: Element) => ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const name = (el: Element) => (el.getAttribute('aria-label') || txt(el) || el.getAttribute('title') || (el as HTMLInputElement).placeholder || el.tagName.toLowerCase()).slice(0, 40);
    const desc = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`;
    const ownText = (el: Element) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim());
    const px = (v: string) => Math.round(parseFloat(v) || 0);
    const all = [...root.querySelectorAll('*')].filter(visible);
    const cut = new Set<string>(), short = new Set<string>(), overlap = new Set<string>(), small = new Set<string>();
    const problems: Record<string, string[]> = {};
    const mark = (el: Element, what: string, note: string) => el.setAttribute(`data-tapcheck-mark-${what}`, note);
    for (const what of ['wide', 'cut', 'short', 'overlap', 'small', 'alt']) document.querySelectorAll(`[data-tapcheck-mark-${what}]`).forEach((el) => el.removeAttribute(`data-tapcheck-mark-${what}`)); // an earlier measure's

    if (!rootSel) {
        const wide = document.documentElement.scrollWidth > vw + 1 && all.filter((e) => e.getBoundingClientRect().right > vw + 1).sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
        if (wide) mark(wide, 'wide', `widest: ${desc(wide)}`);
        problems['no sideways scroll'] = document.documentElement.scrollWidth > vw + 1 ? [`the page is ${document.documentElement.scrollWidth} px wide in a ${vw} px window${wide ? `; widest: ${desc(wide)}` : ''}`] : [];
    } else {
        const b = root.getBoundingClientRect();
        const out = b.left < -1 || b.top < -1 || b.right > vw + 1 || (getComputedStyle(root).position === 'fixed' && b.bottom > vh + 1);
        problems['fits on the screen'] = out ? [`it spans ${Math.round(b.left)},${Math.round(b.top)} to ${Math.round(b.right)},${Math.round(b.bottom)} in a ${vw} × ${vh} window`] : [];
    }

    // Text wider than its box, in an element that holds text itself (not a carousel or another clipping container).
    for (const el of all) {
        if (el.children.length > 2 || el.matches('input, select, textarea') || !txt(el)) continue;
        const s = getComputedStyle(el);
        if (el.scrollWidth <= el.clientWidth + 1 || !/hidden|clip/.test(s.overflowX)) continue;
        if (!ownText(el) && ![...el.children].every((c) => getComputedStyle(c).display.startsWith('inline'))) continue;
        if (s.textOverflow !== 'ellipsis') { cut.add(`"${txt(el)}" (${desc(el)})`); mark(el, 'cut', 'text cut off'); }
        else if (!el.getAttribute('title') && !el.getAttribute('aria-label') && !el.closest('[title], [aria-describedby]')) { short.add(`"${txt(el)}" (${desc(el)})`); mark(el, 'short', 'shortened, with no way to read it'); }
    }

    // Controls, each clipped to what its scrolling ancestors leave visible.
    const seen = (el: Element) => {
        const r = el.getBoundingClientRect();
        let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
            const cs = getComputedStyle(p);
            if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
            const c = p.getBoundingClientRect();
            l = Math.max(l, c.left); t = Math.max(t, c.top); rt = Math.min(rt, c.right); b = Math.min(b, c.bottom);
        }
        return { left: l, top: t, right: rt, bottom: b, width: Math.max(0, rt - l), height: Math.max(0, b - t) };
    };
    const inView = (el: Element) => { const s = seen(el); return Math.max(0, Math.min(s.right, vw) - Math.max(s.left, 0)) * Math.max(0, Math.min(s.bottom, vh) - Math.max(s.top, 0)); };
    // At most 300 controls are measured: those in the window first, then the rest as the page orders them.
    const every = all.filter((e) => e.matches('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch]'));
    const capped = every.length > 300 ? `measured the first 300 of ${every.length} controls, those in the window first` : '';
    const controls = (capped ? every.map((el) => ({ el, on: inView(el) > 0 })).sort((a, b) => +b.on - +a.on).map((c) => c.el) : every).slice(0, 300)
        .map((el) => ({ el, box: seen(el) })).filter((c) => c.box.width > 1 && c.box.height > 1);
    type Box = ReturnType<typeof seen>;
    const over = (a: Box, b: Box) => {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return w > 4 && h > 4 && w * h > 0.25 * Math.min(a.width * a.height, b.width * b.height);
    };
    // Whether a person can scroll `m` clear of `o`: a floating button over a long page, an arrow over the row it scrolls.
    // Each thing around `m` that scrolls (the page last) is scrolled for real, just far enough each way, and put back.
    // Clear means the two no longer overlap and `m` is no less in view; when both move together, or there is no room
    // left to scroll (a short page), they still overlap.
    const scrollsClear = (m: Element, o: Element) => {
        const doc = document.scrollingElement, a = m.getBoundingClientRect(), b = o.getBoundingClientRect(), before = inView(m);
        const scrolls = (el: Element, axis: 'overflowX' | 'overflowY') => (el === doc ? [document.documentElement, document.body].every((e) => !/hidden|clip/.test(getComputedStyle(e)[axis])) : /auto|scroll/.test(getComputedStyle(el)[axis]));
        for (let p = m.parentElement; p; p = p.parentElement) {
            const sc = p === document.documentElement ? doc : p === document.body ? null : p;
            if (!sc) continue;
            for (const [dx, dy] of [[0, a.bottom - b.top], [0, a.top - b.bottom], [a.right - b.left, 0], [a.left - b.right, 0]]) {
                if (!scrolls(sc, dx ? 'overflowX' : 'overflowY')) continue;
                const x = sc.scrollLeft, y = sc.scrollTop;
                sc.scrollTo({ left: x + dx, top: y + dy, behavior: 'instant' });
                const clear = (sc.scrollLeft !== x || sc.scrollTop !== y) && !over(seen(m), seen(o)) && inView(m) >= before - 1;
                sc.scrollTo({ left: x, top: y, behavior: 'instant' });
                if (clear) return true;
            }
        }
        return false;
    };
    for (const [i, a] of controls.entries()) for (const b of controls.slice(i + 1)) {
        if (a.el.contains(b.el) || b.el.contains(a.el) || (a.el.closest('label') && a.el.closest('label') === b.el.closest('label'))) continue;
        if (over(a.box, b.box) && !scrollsClear(a.el, b.el) && !scrollsClear(b.el, a.el)) { overlap.add(`${name(a.el)} ↔ ${name(b.el)}`); for (const c of [a, b]) mark(c.el, 'overlap', `${name(a.el)} ↔ ${name(b.el)}`); }
    }
    // WCAG 2.2 target size (2.5.8): under 24 px fails unless a 24 px area centred on it touches no other target. Links in a sentence are exempt.
    for (const { el } of controls) {
        const r = el.getBoundingClientRect();
        if (Math.min(r.width, r.height) >= 24 || (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label'))) continue;
        if (el.matches('a') && el.closest('p, li, td, dd') && getComputedStyle(el).display === 'inline') continue;
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2, hw = Math.max(12, r.width / 2), hh = Math.max(12, r.height / 2);
        const crowded = controls.some((o) => { const t = o.el.getBoundingClientRect(); return o.el !== el && !o.el.contains(el) && !el.contains(o.el) && t.left < cx + hw && t.right > cx - hw && t.top < cy + hh && t.bottom > cy - hh; });
        if (crowded) { small.add(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`); mark(el, 'small', `${Math.round(r.width)}×${Math.round(r.height)} px`); }
    }
    Object.assign(problems, { 'text is not cut off': [...cut], 'shortened text can be read in full': [...short], 'controls do not overlap': [...overlap], 'targets at least 24 px': [...small] });

    const items: Item[] = [], labels: string[] = [], off: [string, string, string][] = [];
    if (!extras) return { problems, items, labels, off, capped };
    // Each control and label measured is tagged with its index, so an example of each look can be cut out of the page.
    document.querySelectorAll('[data-tapcheck-item], [data-tapcheck-say]').forEach((e) => { e.removeAttribute('data-tapcheck-item'); e.removeAttribute('data-tapcheck-say'); });

    // Placeholders that reached the screen: a value that printed as undefined, NaN or [object Object], or an unfilled template.
    const leaked = new Set<string>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent!.trim(), el = n.parentElement;
        if (!t || !el || el.closest('script, style, code, pre, textarea, [aria-hidden=true]') || !el.getClientRects().length) continue;
        if (/^(undefined|null)$|\bNaN\b|\[object Object\]|\{\{[^}]*\}\}|\$\{[^}]*\}/.test(t)) leaked.add(t.slice(0, 60));
    }
    const heads = [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible);
    problems['no leaked placeholders'] = [...leaked];
    problems['heading levels in order'] = heads.slice(1).flatMap((h, i) => (+h.tagName[1] > +heads[i].tagName[1] + 1 ? [`${heads[i].tagName.toLowerCase()} → ${h.tagName.toLowerCase()} "${txt(h)}"`] : []));
    problems['images have alt text'] = [...root.querySelectorAll('img')].filter((i) => visible(i) && !i.hasAttribute('alt') && !i.getAttribute('aria-label')).map((i) => { mark(i, 'alt', 'no alt text'); return i.src.slice(-60); });

    // Controls by kind, with the look that should be the same wherever the kind is used.
    const plain = (e: Element) => { const s = getComputedStyle(e); return s.backgroundColor === 'rgba(0, 0, 0, 0)' && !parseFloat(s.borderTopWidth) && !parseFloat(s.borderBottomWidth); };
    /** Whether the element's text is on more than one line. */
    const lines = (e: Element) => {
        const range = document.createRange(), rects: DOMRect[] = [], walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) { range.selectNodeContents(n); rects.push(...range.getClientRects()); }
        return rects.some((a) => a.width > 0 && rects.some((b) => b.width > 0 && b.top >= a.bottom - 1));
    };
    // A label is wording the app chose: not data (a digit, a price, a percentage) and not a sentence or a headline (over five words).
    const say = (l: string, el: Element) => { if (!/[\d$€£¥₹%]/.test(l) && l.split(/\s+/).length <= 5) { el.setAttribute('data-tapcheck-say', String(labels.length)); labels.push(l); } };
    for (const el of all) {
        const tag = el.tagName.toLowerCase(), f = el as HTMLInputElement;
        const button = el.matches('button, input[type=submit], input[type=button], input[type=reset], [role=button]') && !el.matches('[role=tab], [role=menuitem], [role=switch], :disabled, [aria-disabled=true]');
        const field = tag === 'select' || tag === 'textarea' || (tag === 'input' && ['text', 'email', 'url', 'tel', 'number', 'password', 'search', 'date'].includes(f.type));
        if (!button && !field) continue;
        const label = field ? (f.labels?.[0] ? txt(f.labels[0]) : name(el)) : txt(el) || (tag === 'input' ? f.value : '');
        // A field with no background or border of its own is drawn by a wrapper: the nearest of three ancestors that has
        // one, holds no other field and isn't far larger (a card or toolbar around it) is measured. With none the field is left out.
        let box: Element | null = el;
        for (let n = 0; field && box && plain(box); n++) {
            const up: Element | null = n < 3 ? box.parentElement : null;
            box = up && up.querySelectorAll('input:not([type=hidden]), select, textarea').length === 1 && up.clientWidth <= 2 * el.clientWidth + 48 && up.clientHeight <= 4 * el.clientHeight ? up : null;
        }
        if (!box) continue;
        const s = getComputedStyle(el), b = getComputedStyle(box), r = box.getBoundingClientRect();
        // Not one of a kind with the rest: a card that is a button (over 64 px high, or text on several lines) and a page number.
        if (button && (r.height > 64 || /^\d+$/.test(label) || lines(el))) continue;
        const bare = s.backgroundColor === 'rgba(0, 0, 0, 0)' && !parseFloat(s.borderTopWidth);
        const kind = field ? (tag === 'input' ? 'text input' : tag) : !label ? 'icon button' : bare ? 'text button' : 'button';
        // A bare control that takes its colour from the data beside it (a ⚡ in a "56% BULL" tag) is coloured by that data:
        // green, red and amber there are one scheme, not three.
        const up = el.parentElement, rest = up ? up.textContent!.replace(el.textContent ?? '', '') : '';
        const ink = bare && up && getComputedStyle(up).color === s.color && /[\d$€£¥₹%]/.test(rest) ? 'the colour of the data beside it' : s.color;
        box.setAttribute('data-tapcheck-item', String(items.length));
        items.push({ kind, label, shape: `${kind === 'textarea' ? '' : `${Math.round(r.height)} px high, `}radius ${px(b.borderTopLeftRadius)} px, ${px(s.fontSize)} px text`,
            paint: `${ink} on ${b.backgroundColor}, ${parseFloat(b.borderTopWidth) ? `border ${b.borderTopColor}` : 'no border'}` });
        // A button among three or more of its kind side by side is a row of data (a list of events, of tickers), not a label.
        const row = (e: Element) => (e.closest('li') ?? e).parentElement, like = (e: Element) => e.tagName === el.tagName && e.className === el.className;
        if (button && label && [...(row(el)?.querySelectorAll(tag) ?? [])].filter((e) => row(e) === row(el) && like(e)).length < 3) say(label, el);
    }
    for (const h of [...heads, ...root.querySelectorAll('[role=tab]')]) if (visible(h) && txt(h)) say(txt(h), h);

    if (design) {
        // Any CSS colour as sRGB bytes, by painting it; null when it is fully transparent.
        const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
        const memo = new Map<string, number[] | null>();
        const rgb = (c: string) => {
            if (!memo.has(c)) { cv.clearRect(0, 0, 1, 1); cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); const d = cv.getImageData(0, 0, 1, 1).data; memo.set(c, d[3] ? [d[0], d[1], d[2]] : null); }
            return memo.get(c)!;
        };
        const tokens = (design.colors ?? []).map((c) => rgb(c)!);
        const colour = (c: string, use: string, el: Element) => {
            const v = rgb(c);
            if (v && !tokens.some((t) => Math.abs(t[0] - v[0]) + Math.abs(t[1] - v[1]) + Math.abs(t[2] - v[2]) <= 6)) off.push(['colors', `#${v.map((x) => x.toString(16).padStart(2, '0')).join('')} ${use}`, desc(el)]);
        };
        const fonts = design.fonts?.map((x) => x.toLowerCase());
        const among = (list: number[], v: number) => list.some((t) => Math.abs(t - v) < 0.5);
        for (const el of all) {
            if (el.closest('svg, img, canvas, video, iframe')) continue;
            const s = getComputedStyle(el), own = ownText(el);
            if (design.colors) { if (own) colour(s.color, 'text', el); colour(s.backgroundColor, 'background', el); if (parseFloat(s.borderTopWidth)) colour(s.borderTopColor, 'border', el); }
            const family = s.fontFamily.split(',')[0].replace(/["']/g, '').trim();
            if (fonts && own && !fonts.includes(family.toLowerCase())) off.push(['fonts', family, desc(el)]);
            const radius = parseFloat(s.borderTopLeftRadius) || 0;
            if (design.radii && radius > 0 && !s.borderTopLeftRadius.includes('%') && !among(design.radii, radius)) off.push(['radii', `${px(s.borderTopLeftRadius)} px`, desc(el)]);
            if (design.spacing) for (const p of ['paddingTop', 'paddingLeft', 'marginTop', 'marginBottom', 'rowGap', 'columnGap'] as const) { const v = parseFloat(s[p]) || 0; if (v > 0 && !among(design.spacing, v)) off.push(['spacing', `${px(s[p])} px`, desc(el)]); }
        }
    }
    return { problems, items, labels, off, capped };
}

/**
 * Tab through the page; returns the stops whose look doesn't change between focused and not. With a main element the
 * run starts at its first control, after a few stops from the top (skip links), so an app's long sidebar isn't all
 * that is tried; without one it is all from the top.
 */
async function noFocusRing(page: Page): Promise<string[]> {
    const main = await toMain(page, true);
    const stops = new Map<string, { ring: boolean; name: string }>(); // by place: two links may share a label
    for (const [fromMain, n] of [[false, main ? TOP : TABS], [true, main ? TABS : 0]] as const) {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        if (fromMain && n) await toMain(page);
        const round = new Set<string>();
        for (let i = 0; i < n; i++) {
            await page.keyboard.press('Tab');
            if (!i) await toMain(page, true);
            const f = await page.evaluate(() => {
                const el = document.activeElement as HTMLElement | null;
                if (!el || el === document.body) return null;
                const chain = [el, el.parentElement, el.parentElement?.parentElement].filter((e): e is HTMLElement => !!e);
                const look = (e: HTMLElement) => { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.backgroundColor, s.textDecorationLine].join('|'); };
                // A ring that eases in or out still shows right after blur: compare with transitions off.
                const saved = chain.map((e) => e.style.transition);
                chain.forEach((e) => { e.style.transition = 'none'; });
                const on = chain.map(look); el.blur(); const off = chain.map(look); el.focus({ preventScroll: true });
                chain.forEach((e, k) => { e.style.transition = saved[k]; });
                const b = el.getBoundingClientRect();
                return { ring: on.some((k, j) => k !== off[j]), at: `${Math.round(b.left + scrollX)},${Math.round(b.top + scrollY)}`,
                    name: `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.innerText || (el as HTMLInputElement).placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 30)}"` };
            });
            if (!f || round.has(f.at)) break; // left the page, or came round again
            round.add(f.at);
            stops.set(f.at, f);
        }
    }
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); scrollTo(0, 0); });
    return [...new Set([...stops.values()].filter((f) => !f.ring).map((f) => f.name))];
}

/** Marks the controls whose markup says they open a menu or dialog, and returns their labels (in order; '' is one to leave alone). */
const openers = (page: Page) => page.evaluate((unsafe) => {
    const no = new RegExp(unsafe, 'i');
    return [...document.querySelectorAll('[aria-haspopup]:not([aria-haspopup=false]), [aria-expanded=false], [popovertarget]')].slice(0, 8).map((el, i) => {
        const b = el as HTMLButtonElement;
        const label = (b.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const submit = el.matches('button[type=submit], input[type=submit]') || (el.matches('button:not([type])') && !!b.form);
        const leaves = el instanceof HTMLAnchorElement && !!el.getAttribute('href') && !el.getAttribute('href')!.startsWith('#'); // a link that goes somewhere
        if (!label || no.test(label) || submit || leaves || b.disabled || el.getClientRects().length === 0) return '';
        el.setAttribute('data-tapcheck-opener', String(i));
        return label;
    });
}, UNSAFE.source);

export async function run(r: Run) {
    mkdirSync(`${r.dir}/shots`, { recursive: true });
    // The full pass (axe, dark mode, Jev's look) is on the main viewport, a desktop unless `devices` leaves it out;
    // the tablet and phone sizes of the other chosen devices are measured after it.
    const desktop = mainViewport(r.cfg), narrow = NARROW.filter((v) => r.cfg.devices.includes(device(v)) && v.width !== desktop.width);
    const skip = r.cfg.audit.skip;
    const out = { screens: [] as { name: string; path: string; views: Record<string, Record<string, string[]>> }[], components: {} as Record<string, unknown>, labelCase: {} as Record<string, string[]>, tokens: {} as Record<string, unknown> };
    const looks = new Map<string, Map<string, { n: number; labels: Set<string>; paints: Set<string> }>>(); // kind → shape → where it is used
    // The first control seen of each look and colour scheme of a kind, and of each label: cut out of its screen, for the
    // consistency findings' evidence. ponytail: at most EXAMPLES of each, the rest are counted, not shown.
    const examples = new Map<string, { file: string; at: string }>();
    const example = async (page: Page, key: string, selector: string, at: string) => {
        if (examples.has(key) || examples.size >= EXAMPLES) return;
        const file = `${r.dir}/shots/look-${examples.size + 1}.png`;
        examples.set(key, { file, at });
        await page.locator(selector).first().screenshot({ path: file, timeout: 2000, animations: 'disabled' }).catch(() => examples.delete(key));
    };
    const labels = new Set<string>();
    const outside = new Map<string, Map<string, { n: number; at: string }>>(); // token list → value → uses

    let jevOff = whyOff();
    if (jevOff) r.record({ suite: S, where: 'Jev', check: "Jev's look at each screen, menu and dialog", status: 'info', detail: `skipped (${jevOff}); the measured checks ran` });
    /** Jev's look at `shots`. Reaching the budget ends the looks, not the audit. */
    const look = async (where: string, key: string, state: Record<string, unknown>, questions: Record<string, unknown>, shots: string[], crop = false, starts?: Awaited<ReturnType<typeof itemStarts>>) => {
        if (jevOff) return;
        try {
            await visual(r, S, where, await ask(key, { ...state, screenshots: shots.map(img) }, questions, shots), shots, { note: state.note as string | undefined, crop, questions, starts });
        } catch (e) {
            if (!(e instanceof BudgetReached)) throw e;
            jevOff = 'Jev budget reached';
            r.record({ suite: S, where: 'Jev', check: "Jev's look at each screen, menu and dialog", status: 'info', detail: `stopped at ${where}: ${e.message}` });
        }
    };
    /** One finding per measured check; the problems also go to audit.json. With marks on, a check that knows its
     * elements gets a marked screenshot of the page as it was measured (a menu still open, this viewport), put first. */
    const emit = async (page: Page, screen: (typeof out.screens)[number], view: string, where: string, problems: Record<string, string[]>, shots?: string[], capped?: string) => {
        if (capped) r.record({ suite: S, where, check: 'controls measured', status: 'info', detail: capped });
        const bad = Object.values(problems).some((l) => l.length);
        const shot = `${r.dir}/shots/audit-${slug(where)}.png`;
        if (bad && !shots) await page.screenshot({ path: shot });
        for (const [check, list] of Object.entries(problems)) {
            const status = !list.length ? 'pass' : WARN.has(check) ? 'warn' : 'fail', detail = list.length ? `${list.length}: ${list.slice(0, 5).join('; ')}` : undefined;
            const drawn = list.length && r.cfg.marks && MARKS[check] ? await marked(r, page, `audit ${where} ${check}`, { status, title: check, detail: `${where} · ${detail}`, of: { suite: S, where } }, [{ target: `[data-tapcheck-mark-${MARKS[check]}]` }]) : undefined;
            r.record({ suite: S, where, check, status, detail, evidence: list.length ? [...(drawn ? [drawn] : []), ...(shots ?? [shot])] : undefined });
        }
        screen.views[view] = Object.fromEntries(Object.entries(problems).filter(([, l]) => l.length));
    };

    const pending = new Set<unknown>(); // the desktop page's requests that haven't ended
    async function onDesktop(page: Page, t: (typeof out.screens)[number]) {
        const where = `${t.name} · ${desktop.name}`, key = `audit-${slug(t.name)}`;
        await open(r, page, t.path);
        // What a theme changes: the page's own background and text colour, and the background of every surface a quarter
        // of the window or more. Smaller things (a price that turned red, a row that came in) change between two loads anyway.
        const colours = () => page.evaluate(() => {
            const root = [document.documentElement, document.body].map((el) => { const s = getComputedStyle(el); return s.backgroundColor + s.color; });
            const big = [...document.querySelectorAll('body *')].filter((el) => { const b = el.getBoundingClientRect(); return Math.max(0, Math.min(b.right, innerWidth) - Math.max(b.left, 0)) * Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(b.top, 0)) >= innerWidth * innerHeight / 4; });
            return [...root, ...[...new Set(big.map((el) => getComputedStyle(el).backgroundColor))].sort()].join();
        });
        const light = await colours();
        const contrast = async () => {
            await page.addScriptTag({ content: AXE });
            const axe: any = await page.evaluate(() => (window as any).axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations'] }));
            return axe.violations.flatMap((v: any) => v.nodes.map((n: any) => n.target.join(' '))) as string[];
        };
        const dim = new Set(await contrast()); // failing in light mode already: the a11y suite's finding, not dark mode's
        const m = await page.evaluate(measure, { extras: true, design: r.cfg.design });
        for (const [i, it] of m.items.entries()) {
            await example(page, `${it.kind}|${it.shape}`, `[data-tapcheck-item="${i}"]`, t.name);
            await example(page, `${it.kind}|${it.paint}`, `[data-tapcheck-item="${i}"]`, t.name);
        }
        for (const [i, l] of m.labels.entries()) await example(page, `label|${l}`, `[data-tapcheck-say="${i}"]`, t.name);
        await page.evaluate(() => scrollTo(0, 0));
        for (const it of m.items) {
            const shapes = looks.get(it.kind) ?? looks.set(it.kind, new Map()).get(it.kind)!;
            const use = shapes.get(it.shape) ?? shapes.set(it.shape, { n: 0, labels: new Set(), paints: new Set() }).get(it.shape)!;
            use.n++; use.paints.add(it.paint);
            if (it.label && use.labels.size < 4) use.labels.add(it.label);
        }
        m.labels.forEach((l) => labels.add(l));
        for (const [list, value, at] of m.off) {
            const values = outside.get(list) ?? outside.set(list, new Map()).get(list)!;
            const use = values.get(value) ?? values.set(value, { n: 0, at: `${at} on ${t.name}` }).get(value)!;
            use.n++;
        }
        const shots = jevOff ? undefined : await slices(r, page, key, await page.evaluate(() => document.documentElement.scrollHeight), desktop.height);
        await emit(page, t, desktop.name, where, { ...m.problems, 'focus ring on every Tab stop': await noFocusRing(page) }, shots, m.capped);
        if (shots) {
            await look(where, key, { screen: t.name, viewport: `${desktop.name}, ${desktop.width} × ${desktop.height} px`, note: shots.length > 1 ? 'The screenshots are consecutive slices of one screen, top to bottom.' : undefined }, VISUAL, shots);
            if (!jevOff) looked.add(`${r.dir} ${t.name}`); // answered, not stopped by the budget
        }

        // Menus and dialogs: opened one at a time, measured, closed with Escape.
        let opened = 0;
        for (const [i, label] of (await openers(page)).entries()) {
            if (!label || opened >= MAX_POPUPS) continue;
            const at = (u: string) => (hashRoute(t.path) ? u : u.split('#')[0]); // on a hash-routed screen a new hash is another screen
            const home = at(page.url());
            pending.clear();
            await page.locator(`[data-tapcheck-opener="${i}"]`).click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(300);
            const found = at(page.url()) === home && await page.evaluate((POPUP) => {
                const p = [...document.querySelectorAll(POPUP)].filter((el) => el.getClientRects().length > 0).at(-1);
                p?.setAttribute('data-tapcheck-popup', '');
                return p ? p.getAttribute('role') ?? p.tagName.toLowerCase() : '';
            }, POPUP);
            if (found) {
                opened++;
                // What it opened may still be loading (placeholders, a spinner): judged once the requests the click set off
                // have ended (15 s at most) and the page is quiet. Still loading then, it is slow, not unloaded: a warning
                // says so, and Jev isn't asked whether it loaded.
                const t0 = Date.now();
                for (const until = t0 + timing.popupLoad; pending.size && Date.now() < until;) await page.waitForTimeout(100);
                const slow = pending.size;
                await Promise.race([settle(page), page.waitForTimeout(1000)]);
                const at = `${t.name} › ${label}`, shot = `${r.dir}/shots/${key}-popup-${opened}.png`;
                await page.screenshot({ path: shot });
                const p = await page.evaluate(measure, { root: '[data-tapcheck-popup]', extras: false });
                await emit(page, t, `${found} "${label}"`, at, p.problems, [shot], p.capped);
                // Asked about the menu or dialog alone. A dialog loads its content as a screen does; a menu or a list of options doesn't.
                const { loaded: _, ...rest } = POPUP_VISUAL;
                const questions = /dialog/.test(found) && !slow ? POPUP_VISUAL : rest;
                if (slow) r.record({ suite: S, where: at, check: 'visual: loaded', status: 'warn', evidence: [shot],
                    detail: `still loading ${Math.round((Date.now() - t0) / 1000)} s after the click: ${slow} request(s) it set off hadn't ended, so it was judged as it was then` });
                // Jev sees the menu or dialog alone: the page around it is covered on purpose, and isn't what is asked about.
                const crop = jevOff ? undefined : await popupShot(page, `${r.dir}/shots/${key}-popup-${opened}-alone.png`);
                await look(at, `${key}-popup-${opened}`, { screen: `${t.name}, after "${label}" was clicked`, viewport: `${desktop.name}, ${desktop.width} × ${desktop.height} px`,
                    note: crop ? `The screenshot shows only the ${found} that opened, cut out of the screen; any of the page at its edges is not part of the question.` : undefined }, questions, [crop ?? shot], !!crop, await itemStarts(page));
            }
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(150);
            // Still open, or the click went somewhere else: start again from the screen.
            if (at(page.url()) !== home || await page.evaluate((POPUP) => [...document.querySelectorAll(POPUP)].some((el) => el.getClientRects().length > 0), POPUP)) { await open(r, page, t.path); await openers(page); }
        }

        // Dark: the page is loaded again so a theme chosen by script at load time is seen too.
        await page.emulateMedia({ colorScheme: 'dark' });
        try {
            await open(r, page, t.path);
            if ((await colours()) === light) {
                r.record({ suite: S, where: `${t.name} · dark`, check: 'dark mode', status: 'info', detail: "skipped: the page looks the same with prefers-color-scheme: dark, so it has no dark mode to check" });
                return;
            }
            const dark = (await contrast()).filter((t) => !dim.has(t));
            // ponytail: reads rgb() colours only; a background written in another colour space (oklch, color()) is not seen.
            const white = await page.evaluate(() => {
                const hits: Element[] = [];
                for (const el of document.querySelectorAll('body, body *')) {
                    const b = el.getBoundingClientRect(), s = getComputedStyle(el), c = s.backgroundColor.match(/[\d.]+/g);
                    if (b.width < 40 || b.height < 16 || s.visibility === 'hidden' || !s.backgroundColor.startsWith('rgb') || !c || (c[3] !== undefined && +c[3] <= 0.5) || +c[0] <= 235 || +c[1] <= 235 || +c[2] <= 235) continue;
                    if (!el.closest('img, svg, canvas, video, iframe') && !hits.some((h) => h.contains(el))) hits.push(el);
                }
                return hits.slice(0, 5).map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''} (${getComputedStyle(el).backgroundColor})`);
            });
            await emit(page, t, 'dark', `${t.name} · dark`, { 'dark mode: text contrast (axe)': dark, 'dark mode: no background left white': white });
        } finally {
            await page.emulateMedia({ colorScheme: 'light' });
        }
    }

    for (const vp of [desktop, ...narrow]) {
        const first = vp === desktop;
        const ctx = await context(r, vp, true, first); // axe is injected on desktop, so the page's own CSP is set aside there
        const page = await ctx.newPage();
        try {
            if (first) {
                page.on('request', (q) => pending.add(q)).on('requestfinished', (q) => pending.delete(q)).on('requestfailed', (q) => pending.delete(q));
                // The screens to audit, then crawled pages up to audit.max; found once, used at every size.
                const left: string[] = [];
                const add = (name: string, path: string) => { if (skip?.test(path)) left.push(path); else if (!out.screens.some((x) => x.path === path)) out.screens.push({ name, path, views: {} }); };
                for (const s of r.side.screens.length ? r.side.screens : [{ name: 'Home', path: '/' }]) {
                    const path = await resolve(r, page, s).catch((e) => { if (e instanceof SessionExpired) throw e; return null; });
                    if (path) add(s.name, path); else r.record({ suite: S, where: s.name, check: 'screen reachable', status: 'warn', detail: 'no link to it found' });
                }
                const configured = out.screens.length;
                for (const p of r.cfg.audit.max ? r.crawl.pages : []) if (p.status >= 200 && p.status < 400 && out.screens.length < configured + r.cfg.audit.max) add(p.path, p.path);
                if (r.cfg.audit.max && !r.crawl.done) r.record({ suite: S, where: 'audit.max', check: 'crawled pages audited', status: 'info', detail: "none: the crawl didn't run in this run, so only the screens were audited (choose crawl too: ONLY=crawl,audit)" });
                if (left.length) r.record({ suite: S, where: 'audit.skip', check: 'pages left out', status: 'info', detail: [...new Set(left)].slice(0, 8).join(', ') });
            }
            for (const t of out.screens) {
                const where = `${t.name} · ${vp.name}`;
                try {
                    if (first) { await onDesktop(page, t); continue; }
                    await open(r, page, t.path);
                    const m = await page.evaluate(measure, { extras: false });
                    await emit(page, t, vp.name, where, m.problems, undefined, m.capped);
                } catch (e) {
                    if (e instanceof SessionExpired) throw e;
                    r.record({ suite: S, where, check: 'audit ran', status: 'fail', detail: (e as Error).message.slice(0, 200) });
                }
            }
        } finally {
            await ctx.close();
        }
    }

    // Across the screens: one look per kind of control.
    const across = 'all audited screens';
    for (const [kind, shapes] of looks) {
        const by = [...shapes].sort((a, b) => b[1].n - a[1].n);
        const paints = new Set(by.flatMap(([, u]) => [...u.paints]));
        const shapesOff = by.length > 1, paintsOff = paints.size > (PAINTS[kind] ?? 1);
        const ex = (key: string) => examples.get(`${kind}|${key}`);
        const shapeSheet = shapesOff ? await sheet(`${r.dir}/shots/consistency-${slug(kind)}-looks.png`, `${kind}: ${by.length} looks, most used first`,
            by.map(([shape, u]) => ({ file: ex(shape)?.file, at: ex(shape)?.at, text: `${shape} · ×${u.n}${u.labels.size ? ` · ${[...u.labels].join(', ')}` : ''}` }))) : undefined;
        const paintSheet = paintsOff ? await sheet(`${r.dir}/shots/consistency-${slug(kind)}-colours.png`, `${kind}: ${paints.size} colour schemes`,
            [...paints].map((p) => ({ file: ex(p)?.file, at: ex(p)?.at, text: p }))) : undefined;
        r.record({ suite: S, where: across, check: `consistency: one size and radius per ${kind}`, status: shapesOff ? 'warn' : 'pass',
            detail: `${by.length} look(s): ${by.slice(0, 4).map(([shape, u]) => `${shape} ×${u.n}${u.labels.size ? ` (${[...u.labels].join(', ')})` : ''}`).join('; ')}`, evidence: shapeSheet ? [shapeSheet] : undefined });
        r.record({ suite: S, where: across, check: `consistency: ${kind} colours`, status: paintsOff ? 'warn' : 'pass', detail: `${paints.size} colour scheme(s): ${[...paints].slice(0, 4).join('; ')}`, evidence: paintSheet ? [paintSheet] : undefined });
        out.components[kind] = by.map(([shape, u]) => ({ shape, uses: u.n, labels: [...u.labels], colours: [...u.paints] }));
    }
    // Label case: Title Case needs two capitalised words after the first, sentence case none; names and one-word labels count as neither.
    const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);
    const rest = (l: string) => l.split(/\s+/).slice(1).filter((w) => /^[A-Za-z]/.test(w) && !SMALL.has(w.toLowerCase()));
    const caps = (l: string) => rest(l).filter((w) => /^[A-Z][a-z]/.test(w)).length;
    const title = [...labels].filter((l) => rest(l).length >= 2 && caps(l) >= 2 && caps(l) / rest(l).length > 0.6), sentence = [...labels].filter((l) => rest(l).length >= 1 && caps(l) === 0);
    const odd = title.length && sentence.length ? (title.length <= sentence.length ? title : sentence) : [];
    // The labels in the less used case, and one of the other for comparison, each as it shows on its screen.
    const other = (odd === title ? sentence : title).slice(0, 1);
    const caseSheet = odd.length ? await sheet(`${r.dir}/shots/consistency-label-case.png`, `labels: ${title.length} in Title Case, ${sentence.length} in sentence case`,
        [...odd.map((l) => ({ l, how: odd === title ? 'Title Case (the fewer)' : 'sentence case (the fewer)' })), ...other.map((l) => ({ l, how: odd === title ? 'sentence case, as most are' : 'Title Case, as most are' }))]
            .map(({ l, how }) => ({ file: examples.get(`label|${l}`)?.file, at: examples.get(`label|${l}`)?.at, text: `"${l}" · ${how}` }))) : undefined;
    r.record({ suite: S, where: across, check: 'labels use one case', status: odd.length ? 'warn' : 'pass',
        detail: odd.length ? `${title.length} in Title Case, ${sentence.length} in sentence case; the fewer: ${odd.slice(0, 6).map((l) => `"${l}"`).join(', ')}` : undefined, evidence: caseSheet ? [caseSheet] : undefined });
    out.labelCase = { title, sentence };
    for (const [list, word] of [['colors', 'colours'], ['fonts', 'fonts'], ['radii', 'radii'], ['spacing', 'spacing']] as const) {
        if (!r.cfg.design?.[list]) continue;
        const worst = [...(outside.get(list) ?? [])].sort((a, b) => b[1].n - a[1].n);
        r.record({ suite: S, where: across, check: `design tokens: ${word}`, status: worst.length ? 'warn' : 'pass',
            detail: worst.length ? `${worst.length} value(s) outside design.${list}; most used: ${worst.slice(0, 6).map(([v, u]) => `${v} ×${u.n} (${u.at})`).join('; ')}` : undefined });
        out.tokens[list] = worst.map(([value, u]) => ({ value, uses: u.n, first: u.at }));
    }
    writeFileSync(`${r.dir}/audit.json`, JSON.stringify(out, null, 2));
}
