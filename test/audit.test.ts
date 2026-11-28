import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { closeBrowser, type Run } from '../src/browser.ts';
import { check } from '../src/config.ts';
import { setup } from '../src/jev.ts';
import type { Finding } from '../src/report.ts';
import * as audit from '../src/suites/audit.ts';

const HOME = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><style>
body { margin: 0; font: 16px sans-serif; background: #ffffff; color: #111111; }
button { border: 1px solid #111111; background: #eeeeee; color: #111111; border-radius: 4px; padding: 8px; font: inherit; }
.big { height: 60px; border-radius: 7px; }
.clip { width: 80px; overflow: hidden; white-space: nowrap; }
.card { background: #ffffff; width: 200px; }
.sale { color: #ff0000; }
.tiny { display: none; }
#more { position: absolute; left: -50px; top: 200px; }
@media (prefers-color-scheme: dark) { body { background: #111111; color: #eeeeee; } }
@media (max-width: 400px) { .tiny { display: inline-block; width: 16px; height: 16px; padding: 0; } }
</style><body><h1>Plants</h1>
<button>Add plant</button> <button class="big">Buy now</button>
<button aria-haspopup="menu" onclick="document.getElementById('more').hidden = false">More</button>
<div id="more" role="menu" hidden><button role="menuitem">Rename</button></div>
<p class="clip">A very long line of text that cannot fit in eighty pixels</p>
<div class="card">A card that stays white</div>
<p class="sale">Sale</p>
<button class="tiny" aria-label="less"></button><button class="tiny" aria-label="more"></button>
</body></html>`;

test('audit: button sizes, cut-off text, a white background in dark mode, token violations, small targets on a phone, Jev looks', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-audit-`);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(HOME); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
        design: { colors: ['#ffffff', '#111111', '#eeeeee'], radii: [4] } }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    const r: Run = { cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } };
    // A fake Jev that sees nothing wrong; nothing reaches the network.
    const asked: string[][] = [];
    delete process.env.JEV;
    setup({ budget: 1, headers: {} }, { systemOne: async ({ questions }) => {
        asked.push(Object.keys(questions));
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: k === 'loaded' ? 0.9 : 0.1 }])), usage: { input_tokens: 100 } };
    } });
    await audit.run(r);

    const at = (where: string, check: string) => { const f = found.find((x) => x.where === where && x.check === check); return `${f?.status}: ${f?.detail ?? ''}`; };
    const all = 'all audited screens';
    assert.match(at(all, 'consistency: one size and radius per button'), /^warn: 2 look\(s\).*×2 \(Add plant, More\).*60 px high, radius 7 px.*\(Buy now\)/);
    // Each look is shown: an example of each cut out of its screen, on one sheet that is the finding's evidence.
    const looksSheet = found.find((x) => x.check === 'consistency: one size and radius per button')!.evidence;
    assert.deepEqual(looksSheet, [`${tmp}/shots/consistency-button-looks.png`]);
    assert.ok(readFileSync(looksSheet![0]).readUInt32BE(20) > 100, 'a sheet with a row per look');
    // An example that came out blank says so instead of showing an empty box.
    const blank = `${tmp}/blank.png`, ok = `${tmp}/shots/look-1.png`;
    const { chromium } = await import('playwright');
    const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 60, height: 30 } }); await p.screenshot({ path: blank }); await b.close();
    const sheetFile = await audit.sheet(`${tmp}/sheet.png`, 'test', [{ file: blank, text: 'blank' }, { file: ok, text: 'ok' }]);
    assert.ok(sheetFile && existsSync(sheetFile));
    assert.match(at('Home · desktop', 'text is not cut off'), /^fail: 1: "A very long line/);
    assert.match(at('Home · dark', 'dark mode: no background left white'), /^fail: .*div\.card/);
    assert.match(at('Home · dark', 'dark mode: text contrast (axe)'), /^fail: /);
    assert.match(at(all, 'design tokens: colours'), /^warn: 1 value\(s\) outside design\.colors; most used: #ff0000 text ×1 \(p\.sale on Home\)/);
    assert.match(at(all, 'design tokens: radii'), /^warn: 1 value\(s\) outside design\.radii; most used: 7 px ×1 \(button\.big on Home\)/);
    assert.match(at('Home · phone', 'targets at least 24 px'), /^fail: 2: less 16×16; more 16×16/);
    assert.equal(at('Home · desktop', 'targets at least 24 px'), 'pass: ');
    // The menu the markup announces is opened and measured, and Jev looks at the screen and at the menu.
    assert.match(at('Home › More', 'fits on the screen'), /^fail: 1: it spans -50,200/);
    assert.deepEqual(asked.map((q) => q.includes('loaded')), [true, false]);
    assert.deepEqual([at('Home · desktop', 'visual: loaded'), at('Home › More', 'visual: overlap')], [`pass: "Do the screenshots show the screen's main content, fully loaded?" Jev: yes (90% sure)`, `pass: "In the screenshots, do any texts or controls of the menu or dialog that opened overlap each other?" Jev: no (90% sure)`]);
    // A menu is asked about itself: the page behind it, covered or cut at the cut-out's edge, is not part of the question.
    assert.match(at('Home › More', 'visual: clipped'), /^pass: "In the screenshots, is any text or control of the menu or dialog that opened cut off\?"/);
    assert.deepEqual(found.filter((f) => f.status === 'info').map((f) => f.check), []);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(`${tmp}/audit.json`, 'utf8')).screens[0].views), ['desktop', 'menu "More"', 'dark', 'tablet', 'phone']);
});

// A floating chat button over a control, and under it whatever the page needs: a long page, a short one.
const CHAT = '<button style="position: fixed; right: 16px; bottom: 16px; width: 120px; height: 48px">Chat</button>';
const under = (label: string) => `<button style="position: absolute; right: 26px; top: 540px; width: 100px; height: 40px">${label}</button>`;
const page = (body: string) => `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><style>body { margin: 0; background: #f7f8f7; color: #111111 }</style><body><h1>t</h1>${body}</body></html>`;
const PAGES: Record<string, () => string> = {
    // The page scrolls, so the button under the chat button can be moved clear of it; so can the chip under the arrow of its row.
    '/long': () => page(`${CHAT}${under('Export')}<div style="height: 2000px"></div>
        <div style="position: absolute; top: 100px; left: 0; width: 300px"><div style="overflow-x: auto; white-space: nowrap">${['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((c) => `<button style="width: 90px; height: 40px">${c}</button>`).join('')}</div>
        <button aria-label="Scroll right" style="position: absolute; right: 0; top: 0; width: 40px; height: 40px">›</button></div>`),
    // Nowhere to scroll to: the button stays under the chat button.
    '/short': () => page(`${CHAT}${under('Delete account')}`),
    // A long page, and two buttons of it drawn on each other: they scroll together.
    '/stack': () => page(`<div style="height: 2000px"></div><button style="position: absolute; left: 20px; top: 200px; width: 100px; height: 40px">Save</button><button style="position: absolute; left: 40px; top: 210px; width: 100px; height: 40px">Cancel</button>`),
    // Live data: a price in another colour on every load, and no dark theme.
    '/live': () => page(`<p style="color: rgb(${++loads}, 0, 0); background: rgb(0, ${loads}, 0)">101.50</p>`),
    '/themed': () => page('<style>@media (prefers-color-scheme: dark) { body { background: #111111; color: #eeeeee } }</style><p>Plants</p>'),
};
let loads = 0;

test('audit: an overlap that scrolling undoes is none, and dark mode is told by the large surfaces', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-audit-`);
    const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[req.url!]?.() ?? ''); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    process.env.JEV = 'off';
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
        screens: Object.keys(PAGES).map((path) => ({ name: path.slice(1), path })) }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    await audit.run({ cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } });
    const at = (where: string, check: string) => { const f = found.find((x) => x.where === where && x.check === check); return `${f?.status}: ${f?.detail ?? ''}`; };

    assert.equal(at('long · desktop', 'controls do not overlap'), 'pass: ');
    assert.equal(at('short · desktop', 'controls do not overlap'), 'fail: 1: Chat ↔ Delete account');
    assert.equal(at('stack · desktop', 'controls do not overlap'), 'fail: 1: Save ↔ Cancel');

    assert.match(at('live · dark', 'dark mode'), /^info: skipped: the page looks the same/);
    assert.equal(at('themed · dark', 'dark mode'), 'undefined: ');
    assert.equal(at('themed · dark', 'dark mode: no background left white'), 'pass: ');
});

const SHELL: Record<string, string> = {
    // An app shell: a rail of 25 links, then the main content, whose first button shows no focus ring.
    '/rail': page(`<nav>${Array.from({ length: 25 }, (_, i) => `<a href="#p${i}">Page ${i}</a>`).join(' ')}</nav><main><button style="outline: none">Quiet</button> <button>Loud</button></main>`),
    // 400 controls; the two drawn on each other are the last in the page and at the top of the window.
    '/many': page(`<div style="margin-top: 300px">${Array.from({ length: 398 }, (_, i) => `<button style="height: 30px">B${i}</button>`).join(' ')}</div>
        <button style="position: absolute; left: 20px; top: 100px; width: 100px; height: 40px">Save</button><button style="position: absolute; left: 40px; top: 110px; width: 100px; height: 40px">Cancel</button>`),
    // A dialog that shows a placeholder until its content arrives, a second later.
    '/dialog': page(`<button aria-haspopup="dialog" onclick="box.hidden = false; fetch('/slow').then((x) => x.text()).then((t) => { box.innerHTML = t })">Details</button>
        <div id="box" role="dialog" aria-label="Details" hidden>Loading…</div>`),
    // A dialog whose content takes longer than the wait: slow, not unloaded.
    '/stuck': page(`<button aria-haspopup="dialog" onclick="box.hidden = false; fetch('/later')">Flow</button>
        <div id="box" role="dialog" aria-label="Flow" hidden>Loading…</div>`),
    '/slow': '<p style="width: 80px; overflow: hidden; white-space: nowrap">A very long line of text that cannot fit in eighty pixels</p>',
    // One text too faint in both themes, one only in the dark.
    '/dark': page('<style>@media (prefers-color-scheme: dark) { body { background: #111111; color: #eeeeee } }</style><p id="both" style="background: #ffffff; color: #cccccc">Faint</p><p id="night" style="color: #333333">Night</p>'),
};

test('audit: Tab starts at the main content, controls in view are measured first, a dialog is judged once loaded or said to be slow, dark mode reports only its own contrast', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-audit-`);
    const server = createServer((req, res) => { setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(SHELL[req.url!] ?? ''), req.url === '/slow' ? 1000 : req.url === '/later' ? 4000 : 0); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }],
        screens: ['/rail', '/many', '/dialog', '/stuck', '/dark'].map((path) => ({ name: path.slice(1), path })) }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    delete process.env.JEV;
    setup({ budget: 1, headers: {} }, { systemOne: async ({ questions }) => ({ answers: Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: k === 'loaded' ? 0.9 : 0.1 }])), usage: { input_tokens: 100 } }) });
    const wait = audit.timing.popupLoad;
    audit.timing.popupLoad = 1500;
    await audit.run({ cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } });
    audit.timing.popupLoad = wait;
    const at = (where: string, check: string) => { const f = found.find((x) => x.where === where && x.check === check); return `${f?.status}: ${f?.detail ?? ''}`; };

    assert.equal(at('rail · desktop', 'focus ring on every Tab stop'), 'fail: 1: button "Quiet"');
    assert.equal(at('many · desktop', 'controls do not overlap'), 'fail: 1: Save ↔ Cancel');
    assert.equal(at('many · desktop', 'controls measured'), 'info: measured the first 300 of 400 controls, those in the window first');
    assert.match(at('dialog › Details', 'text is not cut off'), /^fail: 1: "A very long line/);
    assert.equal(at('dialog › Details', 'visual: loaded'), `pass: "Do the screenshots show the screen's main content, fully loaded?" Jev: yes (90% sure)`);
    assert.match(at('stuck › Flow', 'visual: loaded'), /^warn: still loading 2 s after the click: 1 request\(s\) it set off hadn't ended/);
    assert.equal(found.filter((f) => f.where === 'stuck › Flow' && f.check === 'visual: loaded').length, 1); // Jev wasn't asked too
    assert.equal(at('dark · dark', 'dark mode: text contrast (axe)'), 'fail: 1: #night');
});

const LOOKS = page(`<style>
.wrap { display: inline-block; box-sizing: border-box; height: 40px; padding: 10px; border: 1px solid #111111; border-radius: 8px; background: #ffffff }
.wrap input, .lone { border: 0; background: transparent; outline: 0; height: 16px; padding: 0 }
.pg { height: 28px; border-radius: 6px }
</style>
<span class="wrap"><input aria-label="Search"></span> <span class="wrap"><input aria-label="Filter"></span> <input class="lone" aria-label="Alone">
<p><button>Add plant</button> <button>Save changes</button></p> <button>Fern<br>Needs water</button> <button style="height: 80px">Tall</button>
<nav><button class="pg">1</button> <button class="pg">2</button></nav>
<ul>${['FOMC Member Williams Speaks', 'Richmond Manufacturing Index', 'New Home Sales'].map((x) => `<li><button class="row">${x}</button></li>`).join('')}</ul>
<button>LOOP $5.9M · 2 Prints Today</button> <button>Understanding Dark Pool Activity And More</button>
${[['#0a5d2b', '58% BULL'], ['#a5140f', '88% BEAR'], ['#8f5104', '47/53 MIXED']].map(([c, t]) => `<span style="color:${c}"><span role="button">⚡</span>${t}</span>`).join(' ')}
<span style="color:#0a5d2b"><span role="button" style="color:#0000ff">⚡</span>61% BULL</span>`);

test('audit consistency: a field is measured at its wrapper, cards and page numbers are no button look, data is no label, a control coloured by its data is one colour', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-audit-`);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(LOOKS); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    process.env.JEV = 'off';
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, viewports: [{ name: 'desktop', width: 800, height: 600 }] }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    await audit.run({ cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } });
    const at = (check: string) => { const f = found.find((x) => x.where === 'all audited screens' && x.check === check); return `${f?.status}: ${f?.detail ?? ''}`; };

    assert.match(at('consistency: one size and radius per text input'), /^pass: 1 look\(s\): 40 px high, radius 8 px, \d+ px text ×2 \(Search, Filter\)$/);
    assert.match(at('consistency: text input colours'), /^pass: 1 colour scheme\(s\): .* on rgb\(255, 255, 255\), border rgb\(17, 17, 17\)$/);
    assert.match(at('consistency: one size and radius per button'), /^pass: 1 look\(s\): .* ×7 \(Add plant, Save changes, /);
    // A ⚡ coloured by the tag it sits in is one scheme however the tag is coloured; one with its own colour is another.
    assert.equal(at('consistency: text button colours'), 'pass: 2 colour scheme(s): the colour of the data beside it on rgba(0, 0, 0, 0), no border; rgb(0, 0, 255) on rgba(0, 0, 0, 0), no border');
    assert.equal(at('labels use one case'), 'pass: ');
    assert.deepEqual(JSON.parse(readFileSync(`${tmp}/audit.json`, 'utf8')).labelCase, { title: [], sentence: ['Add plant', 'Save changes'] });
});

test('audit devices: an app not built for desktop or tablet gets its full pass on the phone, and no tablet size', async () => {
    const tmp = mkdtempSync(`${tmpdir()}/tapcheck-audit-`);
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }).end(HOME); });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    after(async () => { await closeBrowser(); server.close(); });
    process.env.JEV = 'off';
    const cfg = check({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, devices: ['mobile'] }, tmp);
    const found: Omit<Finding, 'side'>[] = [];
    await audit.run({ cfg, side: cfg.sides[0], dir: tmp, record: (f) => { found.push(f); }, crawl: { pages: [], hits: [], done: false } });
    const views = Object.keys(JSON.parse(readFileSync(`${tmp}/audit.json`, 'utf8')).screens[0].views);
    assert.equal(views[0], 'mobile');
    assert.ok(!views.includes('tablet') && !views.includes('desktop'), views.join(', '));
    assert.ok(found.some((f) => f.where === 'Home · mobile' && f.check === 'focus ring on every Tab stop'));
});
