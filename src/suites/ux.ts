/*
 * Deep UI/UX audit, per screen and viewport:
 * - visual QA (loaded, errors, overlap, clipping, alignment; left to the audit suite for a desktop screen it already
 *   asked about in this run) and measured facts (status, sideways scroll, broken images, off-screen controls, a single
 *   h1, JS errors; target size is the audit suite's, which knows the spacing exception);
 * - visual design: CTA clarity and label (not judged on a screen Jev says has no main call to action), negative space (Jev's judgment plus measured text coverage), density, hierarchy,
 *   legibility, spacing rhythm;
 * - heuristic evaluation: the usability heuristics a screenshot can show;
 * - guerrilla five-second test on the first screen: does a passer-by get the screen's job, and pick it among the others;
 * - predicted attention (desktop): the first three places the eye goes and the main CTA as Jev boxes, drawn as a heatmap,
 *   with code checking that the CTA is among the first three looks. These are predictions, not eye-tracking data, so a
 *   miss is a warning at most;
 * - raw translation keys, measured: visible text that is exactly one of the keys the i18n.keys command prints, or an
 *   unfilled :placeholder.
 * Jev judges, code decides: an unsure answer is a warning for a person to look at, never a pass.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { box as locateQ } from '@typesafe-ai/sdk';
import type { Page } from 'playwright';
import { mainViewport, type Screen } from '../config.ts';
import { abs, context, facts, helpControls, launch, open, resolve, SessionExpired, shotLayout, slices, slug, watch, type Run } from '../browser.ts';
import { ask, bad, BudgetReached, FAIL_SCORE, good, img, looked, MIN_SCORE, NO, sayChoice, sayNoul, sayScore, scoreStatus, status, to10 } from '../jev.ts';
import { ATTENTION, ATTENTION_CHECK, ATTENTION_MODEL, DESIGN, guerrilla, HEURISTICS, purposeKey, VISUAL } from '../questions.ts';

const S = 'ux';
// Negative space by measurement: text covering more than this share of the first screen reads as crowded.
const MAX_TEXT_COVERAGE = 0.32;

// A low score Jev was split on is a question for a person, not a defect: it is marked "needs review" (a warning).
const REVIEW_BELOW = 0.3;
// Level 2 of the trust and h8_minimalist scales ("acceptable but plain", "some parts could go without loss") describes a
// screen with nothing wrong, and a working product's screens sit there, so for those two it passes: 5.5, where to10 puts
// level 2. Level 1 ("rough", "several parts add nothing") is the defect and still fails at 3.3: the fail mark is 4.4,
// halfway between the two levels, so a score nearer level 1 fails and one just short of level 2 is a warning.
const PLAIN_PASSES = { pass: 5.5, fail: 4.4 };
function scored(r: Run, where: string, check: string, q: any, a: { score: number; confidence: number }, ev: string[], marks = { pass: MIN_SCORE, fail: FAIL_SCORE }) {
    const v = to10(a.score), st = scoreStatus(v, a.confidence, REVIEW_BELOW, marks.pass, marks.fail);
    const review = v < marks.pass && a.confidence < REVIEW_BELOW;
    r.record({ suite: S, where, check, status: st,
        detail: `${sayScore(q, a, st !== 'pass')}${marks.pass === MIN_SCORE ? '' : ` · passes from ${marks.pass}`}${review ? ' · needs review: Jev was split' : ''}`, evidence: ev });
}

/**
 * The app's translation keys, from the i18n.keys command (one per line). Only dotted identifiers count as keys.
 * ponytail: catalogues keyed by the English sentence itself can't be told from real text, so they are ignored here.
 */
function translationKeys(r: Run): Set<string> {
    if (!r.cfg.i18n.keys) return new Set();
    const out = execSync(r.cfg.i18n.keys, { encoding: 'utf8', shell: '/bin/sh', maxBuffer: 64 * 1024 * 1024 });
    return new Set(out.split('\n').map((k) => k.trim()).filter((k) => /^[\w-]+(\.[\w-]+)+$/.test(k)));
}

type Box = { top: number; bottom: number; left: number; right: number };
/** Two boxes are the same element when they share more than half of the smaller one. */
function same(a: Box, b: Box) {
    const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)), h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    const area = (x: Box) => (x.right - x.left) * (x.bottom - x.top);
    return (w * h) / Math.max(1e-6, Math.min(area(a), area(b))) > 0.5;
}

/**
 * Where each look's label goes, in pixels: above its box's top left corner, and a row lower at a time while it would
 * cover a label already placed (looks often land on the same element).
 * ponytail: the width is estimated at 7 px a letter; measure in the page if labels grow past a few words.
 */
export function labelSpots(looks: { label: string; box: Box }[], width: number, height: number) {
    const placed: { x: number; y: number; w: number }[] = [];
    for (const [i, l] of looks.entries()) {
        const w = `${i + 1}. ${l.label}`.length * 7 + 12;
        const x = Math.max(0, Math.min(l.box.left * width - 2, width - w));
        let y = Math.max(0, l.box.top * height - 22);
        while (placed.some((p) => Math.abs(p.y - y) < 22 && x < p.x + p.w && p.x < x + w)) y += 22;
        placed.push({ x, y, w });
    }
    return placed;
}

/** The screenshot with the predicted looks as a heat overlay and numbered boxes, rendered by the browser itself. */
async function heatmap(page: Page, shot: string, looks: { label: string; box: Box; weight: number; colour: string }[], out: string) {
    const { width, height } = page.viewportSize()!;
    const src = `data:image/png;base64,${readFileSync(shot).toString('base64')}`;
    const blobs = looks.map((l) => {
        const cx = ((l.box.left + l.box.right) / 2) * 100, cy = ((l.box.top + l.box.bottom) / 2) * 100;
        const r = Math.max(8, ((l.box.right - l.box.left + l.box.bottom - l.box.top) / 2) * 100);
        return `radial-gradient(circle at ${cx}% ${cy}%, rgba(255,0,0,${0.55 * l.weight}) 0, rgba(255,140,0,${0.3 * l.weight}) ${r * 0.6}%, transparent ${r}%)`;
    }).join(',');
    const spots = labelSpots(looks, width, height);
    const frames = looks.map((l, i) => `<div style="position:absolute;left:${l.box.left * 100}%;top:${l.box.top * 100}%;width:${(l.box.right - l.box.left) * 100}%;`
        + `height:${(l.box.bottom - l.box.top) * 100}%;border:2px solid ${l.colour};border-radius:4px"></div><b style="position:absolute;left:${spots[i].x}px;top:${spots[i].y}px;`
        + `background:${l.colour};color:#fff;font:12px system-ui;padding:2px 6px;border-radius:4px;white-space:nowrap">${i + 1}. ${l.label}</b>`).join('');
    const p = await page.context().newPage();
    await p.setViewportSize({ width, height });
    await p.setContent(`<body style="margin:0"><div style="position:relative;width:${width}px;height:${height}px;background:url(${src}) 0 0/100% 100%">`
        + `<div style="position:absolute;inset:0;background:${blobs};mix-blend-mode:multiply"></div>${frames}</div></body>`);
    await p.screenshot({ path: out });
    await p.close();
}

// What to box when a VISUAL defect is found, so the finding shows where it is.
const LOCATE: Record<string, string> = {
    error_shown: 'The error message.',
    overlap: 'The texts or controls drawn on top of each other.',
    clipped: 'The text or control that is cut off.',
    raw_key: 'The raw translation key or unfilled placeholder shown instead of words.',
    misaligned: 'The item that is out of line with its neighbours.',
};
const PNG = (file: string) => { const b = readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

/** `shot` with each box drawn and labelled, rendered by the browser. */
export async function drawBoxes(shot: string, boxes: { label: string; box: Box }[], out: string) {
    const { width, height } = PNG(shot);
    const page = await (await launch()).newPage({ viewport: { width, height } });
    try {
        const src = `data:image/png;base64,${readFileSync(shot).toString('base64')}`, spots = labelSpots(boxes, width, height);
        const frames = boxes.map((l, i) => `<div style="position:absolute;left:${l.box.left * 100}%;top:${l.box.top * 100}%;width:${(l.box.right - l.box.left) * 100}%;height:${(l.box.bottom - l.box.top) * 100}%;`
            + `border:3px solid #dc2626;border-radius:4px;box-shadow:0 0 0 9999px rgba(0,0,0,.25)"></div><b style="position:absolute;left:${spots[i].x}px;top:${spots[i].y}px;`
            + `background:#dc2626;color:#fff;font:13px system-ui;padding:2px 6px;border-radius:4px;white-space:nowrap">${i + 1}. ${l.label}</b>`).join('');
        await page.setContent(`<body style="margin:0"><div style="position:relative;width:${width}px;height:${height}px;background:url(${src}) 0 0/100% 100%;overflow:hidden">${frames}</div></body>`);
        await page.screenshot({ path: out });
    } finally {
        await page.close();
    }
}

/**
 * Where on the screenshots each failing VISUAL defect is: with several slices, the slices that show it (asked of each
 * on its own), then Jev's box around it on each of those, drawn. A box over most of a slice points at nothing, so it
 * is left out. Locating costs Jev calls, so a budget reached or Jev unavailable leaves the rest unlocated.
 */
async function locate(file: string, keys: string[], shots: string[], note?: string, questions: Record<string, unknown> = VISUAL) {
    const found: Record<string, { file: string; box: Box; slice: number }[]> = {};
    try {
        for (const [i, shot] of shots.slice(0, 4).entries()) {
            let here = keys;
            if (shots.length > 1) {
                const a = await ask(`${file}-slice-${i + 1}`, { screenshots: [img(shot)], note }, Object.fromEntries(keys.map((k) => [k, (questions as any)[k]])), [shot]);
                here = keys.filter((k) => a[k].noul > 0.5);
            }
            if (!here.length) continue;
            const at = await ask(`${file}-where-${i + 1}`, img(shot), Object.fromEntries(here.map((k) => [k, locateQ(questions === VISUAL ? LOCATE[k] : `In the menu or dialog that opened, not the page behind it: ${LOCATE[k].toLowerCase()}`)])), [shot], ATTENTION_MODEL);
            for (const k of here) {
                const b: Box | undefined = at[k]?.box;
                if (!b || (b.right - b.left) * (b.bottom - b.top) > 0.6) continue;
                const out = `${file}-where-${k}-${i + 1}.png`;
                await drawBoxes(shot, [{ label: `${k.replace('_', ' ')} (Jev's box)`, box: b }], out);
                (found[k] ??= []).push({ file: out, box: b, slice: i });
            }
        }
    } catch {
        // ponytail: a failed locate only loses the box; the finding is still recorded with the whole screenshots.
    }
    return found;
}

/** One finding per VISUAL question in `a` (the audit suite asks them too, of screens and of opened dialogs and menus).
 * The detail says what was asked and what the answer means; a failing defect is boxed where Jev places it. `note` is
 * what Jev was told about the screenshots; `crop`: they are tapcheck's cut-out of an opened menu or dialog, so a cut
 * Jev boxes at their edge may be the crop's, and is a warning that says so. */
export async function visual(r: Run, suite: string, where: string, a: Record<string, { noul: number }>, shots: string[], o: { note?: string; crop?: boolean; questions?: Record<string, unknown>; starts?: { n: number; spread: number } | null } = {}) {
    const asked = o.questions ?? VISUAL; // the questions `a` answers, worded for a screen or for an opened menu or dialog
    const all = [['loaded', false], ['error_shown', true], ['overlap', true], ['clipped', true], ['raw_key', true], ['misaligned', true]] as const;
    const failing = all.filter(([k, defect]) => a[k] && defect && bad(a[k].noul) === 'FAIL').map(([k]) => k);
    const boxed = failing.length ? await locate(`${r.dir}/shots/${slug(`${suite} ${where}`)}`, failing, shots, o.note, asked) : {};
    // Read against what was measured on the slice when it was taken: a cut at the end of a row that scrolls sideways is
    // what the question says is not cut off; content under a small
    // control fixed over the page (a chat button) is covered only until the page scrolls.
    const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
    const shared = (a: Box, b: Box) => area({ left: Math.max(a.left, b.left), right: Math.min(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.min(a.bottom, b.bottom) });
    const kind = (s: { box: Box; slice: number }) => {
        const l = shotLayout.get(shots[s.slice]);
        // Text measured cut off in the box is a cut, whatever else the box takes in (a "…" label beside it, a row's end).
        if (l?.cuts.some((q) => shared(s.box, q) > 0)) return 'cut';
        // On a row: the box's middle within the row's height (Jev's box is often taller than a 24 px row of chips), half
        // its width on the row, and at one of the row's ends.
        const mid = (s.box.top + s.box.bottom) / 2, wide = (q: Box) => Math.max(0, Math.min(s.box.right, q.right) - Math.max(s.box.left, q.left)) >= (s.box.right - s.box.left) / 2;
        if (l?.rails.some((q) => mid >= q.top - 0.01 && mid <= q.bottom + 0.01 && wide(q) && (Math.abs(s.box.right - q.right) < 0.04 || Math.abs(s.box.left - q.left) < 0.04))) return 'rail';
        // Text shortened on purpose ("…") inside the box: what the question says is not cut off.
        if (l?.shortened.some((q) => { const x = (q.left + q.right) / 2, y = (q.top + q.bottom) / 2; return x >= s.box.left && x <= s.box.right && y >= s.box.top && y <= s.box.bottom; })) return 'rail';
        if (l?.floaters.some((q) => shared(s.box, q) > Math.min(area(s.box), area(q)) * 0.3)) return 'floater';
        // Nothing in the box measured cut off: Jev likely pointing at nothing.
        return l ? 'apart' : 'cut';
    };
    // Jev's overlap box with nothing measured drawn on each other in it, on every slice it boxed: likely pointing at nothing.
    const unmeasured = (seen: { box: Box; slice: number }[] | undefined) => !!seen?.length && seen.every((s) => {
        const l = shotLayout.get(shots[s.slice]);
        return !!l && !l.overlaps.some((q) => shared(s.box, q) > 0);
    });
    const edge = (b: Box) => b.left < 0.05 || b.top < 0.05 || b.right > 0.95 || b.bottom > 0.95; // within 5% of a side
    for (const [k, defect] of all) {
        if (!a[k]) continue;
        const v = defect ? bad(a[k].noul) : good(a[k].noul), seen = boxed[k];
        const cropped = o.crop && k === 'clipped' && seen?.every((s) => edge(s.box));
        const kinds = !cropped && k === 'clipped' && seen?.length ? seen.map(kind) : [];
        const scrolls = kinds.length > 0 && kinds.every((x) => x === 'rail'), uncut = !scrolls && kinds.length > 0 && kinds.every((x) => x !== 'cut');
        const floats = uncut && kinds.includes('floater');
        const apart = (k === 'overlap' && failing.includes(k) && unmeasured(seen)) || (uncut && !floats);
        const at = failing.includes(k as any) ? (apart ? ` · boxed where no text${k === 'overlap' ? ' or control is measured drawn on another' : ' is measured cut off by its box or the side of the window'} (an image or a canvas isn't measured): check it`
            : scrolls ? ' · boxed at the end of a row that scrolls sideways or on text shortened with "…" (measured), which the question does not count as cut off: check it'
            : floats ? ' · boxed under a small control fixed over the page (measured, such as a chat button) or at the end of a row that scrolls sideways: covered only until the page scrolls, check what is behind it can be scrolled into view'
            : cropped ? " · boxed at the edge of tapcheck's cut-out of the menu or dialog, so the cut may be the crop's, not the app's: check it on the full screen"
            : seen ? ' · boxed where Jev places it (a prediction, check it)' : " · Jev couldn't point to one place: look through the screenshots") : '';
        // Jev unsure whether a menu's items line up, and their text measured starting together: in line.
        const inLine = k === 'misaligned' && v === 'unsure' && !!o.starts && o.starts.spread <= 2;
        const lined = inLine ? ` · passes: the ${o.starts!.n} items' text starts within ${o.starts!.spread} px of each other (measured)` : '';
        r.record({ suite, where, check: `visual: ${k.replace('_', ' ')}`, status: scrolls || inLine ? 'pass' : cropped || floats || apart ? 'warn' : status(v), detail: `${sayNoul((asked as any)[k], a[k].noul, v !== 'pass', defect)}${at}${lined}`, evidence: [...(seen ?? []).map((s) => s.file), ...shots] });
    }
}

export async function run(r: Run) {
    const screens: Screen[] = r.side.screens.length ? r.side.screens : [{ name: 'Home', path: '/' }];
    const known = translationKeys(r);
    for (const vp of r.cfg.viewports) {
        const ctx = await context(r, vp);
        const page = await ctx.newPage();
        const errors = watch(page);
        try {
            for (const s of screens) {
                const where = `${s.name} · ${vp.name}`;
                try {
                    const path = await resolve(r, page, s);
                    if (!path) { r.record({ suite: S, where, check: 'screen reachable', status: 'warn', detail: 'no link to it found' }); continue; }
                    errors.length = 0;
                    const res = await open(r, page, path);
                    const f = await facts(page);
                    const key = `ux-${slug(s.name)}-${vp.name}`;
                    const shots = await slices(r, page, key, f.height, vp.height);

                    // Measured, not asked.
                    const http = res?.status() ?? 0;
                    r.record({ suite: S, where, check: 'HTTP status', status: http && http < 400 ? 'pass' : 'fail', detail: `${http} ${abs(r, path)}` });
                    r.record({ suite: S, where, check: 'no sideways scroll', status: f.overflowX ? 'fail' : 'pass' });
                    r.record({ suite: S, where, check: 'images load', status: f.brokenImages.length ? 'fail' : 'pass', detail: f.brokenImages.slice(0, 5).join(', ') || undefined });
                    r.record({ suite: S, where, check: 'controls on screen', status: f.offscreen ? 'fail' : 'pass', detail: f.offscreen ? `${f.offscreen} off-screen: ${f.offscreenLabels.join(', ')}` : undefined });
                    r.record({ suite: S, where, check: 'one h1', status: f.h1 === 1 ? 'pass' : 'warn', detail: `${f.h1} h1 element(s)` });
                    r.record({ suite: S, where, check: 'no JS errors', status: errors.length ? 'fail' : 'pass', detail: errors.slice(0, 3).join(' | ') || undefined });
                    r.record({ suite: S, where, check: 'negative space (measured)', status: f.textCoverage > MAX_TEXT_COVERAGE ? 'warn' : 'pass',
                        detail: `text covers ${(f.textCoverage * 100).toFixed(1)}% of the first screen (limit ${MAX_TEXT_COVERAGE * 100}%)`, evidence: [shots[0]] });
                    const texts: string[] = await page.evaluate(() => {
                        const out: string[] = [];
                        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                        for (let n = w.nextNode(); n; n = w.nextNode()) {
                            const t = n.textContent?.trim(); const el = n.parentElement;
                            if (t && el && el.offsetParent !== null && !el.closest('script,style,code,pre,[aria-hidden=true]')) out.push(t);
                        }
                        for (const el of document.querySelectorAll('[placeholder],[aria-label],[title]')) for (const a of ['placeholder', 'aria-label', 'title']) { const v = el.getAttribute(a); if (v) out.push(v.trim()); }
                        return out;
                    });
                    const raw = [...new Set(texts.filter((t) => known.has(t) || /(^|\s):[a-z_]{2,}\b/.test(t)))];
                    r.record({ suite: S, where, check: 'no raw translation keys (measured)', status: raw.length ? 'fail' : 'pass', detail: raw.slice(0, 6).join(', ') || undefined, evidence: raw.length ? [shots[0]] : undefined });

                    // One request for every judgment over the same screenshots. The VISUAL questions are left out when the
                    // audit suite asked them of this screen at this viewport earlier in the run.
                    const audited = vp === mainViewport(r.cfg) && looked.has(`${r.dir} ${s.name}`);
                    const a = await ask(key, { screen: s.name, viewport: `${vp.name}, ${vp.width} × ${vp.height} px`, screenshots: shots.map(img),
                        note: shots.length > 1 ? 'The screenshots are consecutive slices of one screen, top to bottom.' : undefined },
                    { ...(audited ? {} : VISUAL), ...DESIGN, ...HEURISTICS(r.cfg.audience, r.cfg.context), ...ATTENTION_CHECK }, shots);
                    await visual(r, S, where, a, shots);
                    // A screen Jev is clear has no main call to action isn't judged on one: the best it could score is a filter chip.
                    const design = DESIGN as any, heur = HEURISTICS(r.cfg.audience, r.cfg.context) as any;
                    const noCta = a.has_cta.noul < NO ? `no main call to action on this screen (p=${a.has_cta.noul.toFixed(2)})` : '';
                    for (const k of ['cta', 'cta_label', 'negative_space', 'hierarchy', 'legibility', 'spacing'] as const) {
                        if (noCta && k.startsWith('cta')) r.record({ suite: S, where, check: `design: ${k.replace('_', ' ')}`, status: 'info', detail: noCta });
                        else scored(r, where, `design: ${k.replace('_', ' ')}`, design[k], a[k], shots);
                    }
                    const probs = Object.entries(a.density.probabilities ?? {}).map(([k, p]) => `${k} ${(p as number).toFixed(2)}`).join(', ');
                    r.record({ suite: S, where, check: 'design: density', status: a.density.choice === 'balanced' ? 'pass' : 'warn', detail: `${sayChoice(DESIGN.density, a.density)} (${probs})`, evidence: [shots[0]] });
                    for (const k of ['h1_status', 'h2_language', 'h4_consistency', 'h6_recognition', 'h8_minimalist'] as const) scored(r, where, `heuristic: ${k}`, heur[k], a[k], shots, k === 'h8_minimalist' ? PLAIN_PASSES : undefined);
                    // A control named as help on the first screen is help, whatever its look: measured, it passes and says which.
                    const helps = good(a.h10_help.noul) === 'pass' ? [] : await helpControls(page);
                    r.record({ suite: S, where, check: 'heuristic: h10_help', status: helps.length ? 'pass' : status(good(a.h10_help.noul)),
                        detail: `${sayNoul(heur.h10_help, a.h10_help.noul, !helps.length && good(a.h10_help.noul) !== 'pass', false)}${helps.length ? ` · passes: help is on the screen (measured): ${helps.slice(0, 4).map((h) => `"${h}"`).join(', ')}` : ''}`, evidence: shots });

                    // Guerrilla five-second test, on the first screen only. It needs the screen's purpose; picking the job
                    // among the others needs at least one other screen with a purpose.
                    if (s.purpose) {
                        const others = [...new Set(screens.filter((x) => x.name !== s.name && x.purpose && x.purpose !== s.purpose).map((x) => x.purpose!))].slice(0, 6);
                        const gq = guerrilla(s.purpose, others), { purpose_pick, ...rest } = gq;
                        const g = await ask(`${key}-guerrilla`, { screenshot: img(shots[0]) }, others.length ? { ...rest, purpose_pick } : rest, [shots[0]]);
                        r.record({ suite: S, where, check: 'guerrilla: purpose clear in 5s', status: status(good(g.purpose_clear.noul)), detail: sayNoul(gq.purpose_clear, g.purpose_clear.noul, good(g.purpose_clear.noul) !== 'pass', false), evidence: [shots[0]] });
                        if (others.length) {
                            const picked = g.purpose_pick.choice === purposeKey(s.purpose);
                            r.record({ suite: S, where, check: 'guerrilla: right job picked', status: picked ? 'pass' : 'fail', detail: picked ? undefined : `${sayChoice(purpose_pick, g.purpose_pick)}; its purpose is: ${s.purpose}`, evidence: [shots[0]] });
                        }
                        scored(r, where, 'guerrilla: trust', gq.trust, g.trust, [shots[0]], PLAIN_PASSES);
                    } else {
                        r.record({ suite: S, where, check: 'guerrilla five-second test', status: 'info', detail: 'skipped: give the screen a purpose in tapcheck.yml to run it' });
                    }

                    // Predicted attention, desktop only.
                    if (!vp.mobile) {
                        // The first screen is asked on its own only when there is more below it: of one slice, `a` already said.
                        const c = shots.length > 1 ? await ask(`${key}-cta-check`, { screenshot: img(shots[0]) }, ATTENTION_CHECK, [shots[0]]) : a;
                        const at = await ask(`${key}-attention`, img(shots[0]), ATTENTION, [shots[0]], ATTENTION_MODEL);
                        const hasCta = good(c.has_cta.noul);
                        const looks = [
                            { label: 'first look', box: at.look_1.box, weight: 1, colour: '#dc2626' },
                            { label: 'second look', box: at.look_2.box, weight: 0.75, colour: '#ea580c' },
                            { label: 'third look', box: at.look_3.box, weight: 0.5, colour: '#ca8a04' },
                            ...(hasCta === 'pass' ? [{ label: 'main CTA', box: at.main_cta.box, weight: 0.4, colour: '#2563eb' }] : []),
                        ];
                        const map = `${r.dir}/shots/${key}-heatmap.png`;
                        await heatmap(page, shots[0], looks, map);
                        const seen = hasCta === 'pass' && looks.slice(0, 3).some((l) => same(l.box, at.main_cta.box));
                        // No main call to action on the whole screen or on its first one is nothing to find. A miss is a
                        // warning at most: the looks and the CTA's box are Jev's predictions, and a box drawn loosely or
                        // a look on another way to do the same thing would otherwise fail a screen that works.
                        const none = noCta || (c.has_cta.noul < NO ? `no main call to action on the first screen (p=${c.has_cta.noul.toFixed(2)})` : '');
                        r.record({ suite: S, where, check: 'attention: main CTA among first three looks', status: none ? 'info' : seen ? 'pass' : 'warn',
                            detail: none || (hasCta !== 'pass' ? `no clear main CTA on the first screen (p=${c.has_cta.noul.toFixed(2)})`
                                : seen ? undefined : 'the eye is predicted to land elsewhere first (a prediction from the screenshot, not a measurement: see the heatmap)'),
                            evidence: [map] });
                    }
                } catch (e) {
                    if (e instanceof BudgetReached || e instanceof SessionExpired) throw e;
                    r.record({ suite: S, where, check: 'audit ran', status: 'fail', detail: (e as Error).message.slice(0, 200) });
                }
            }
        } finally {
            await ctx.close();
        }
    }
}
