# Changelog

## Unreleased

- **Plain or marked, and large, in report.html.** A finding with a marked or Jev-boxed screenshot shows it first with a
  "plain ↔ marked" button that swaps it with the plain screenshot and back, and a screenshot opens large in the page
  (Esc or a click closes it). Without JavaScript the images and links work as before; REPORT.md is unchanged.
- **A slow dialog is slow, not unloaded.** A menu or dialog is judged once the requests its click set off have ended,
  up to 15 s (was 3 s). One still loading then is a warning that says how long it took, and Jev isn't asked whether it
  loaded, so a section that fills in after 9 s no longer fails as "not fully loaded".
- **Jev's overlap and cut boxes checked against the page.** Each slice now measures where text or controls are drawn
  on each other (visible, as far as their scrolling parents show them, and not one scrolling past the other) and where
  text is cut off by its box or the side of the window. An overlap or a cut Jev boxes where nothing is measured is a
  warning that says so, not a failure; a measured cut in the box fails even beside a "…" label or a row's end.

## 0.1.5 (2026-11-27)

A report you can find your way in and findings that say what is wrong, checked against a real app: suite cards
that filter the report, Jev's answers in words with the fault boxed, examples of each look for the consistency
checks, and fewer false results on menus, sideways rows, help buttons and accepted findings.

- **Consistency findings show the looks.** Each of `audit`'s findings across the screens (one size and radius per
  kind of control, its colours, label case) has an image as its evidence: a row per look with an example cut out of
  the screen it was first seen on, the look in words, swatches for its colours and how often it is used, most used
  first. A crop that came out blank says so.
- **Jump to a suite in report.html.** Each suite card shows only that suite's rows (click again, or the chip, for all),
  and the address gets `#suite=<name>` so a link opens the report there; the filters stay at the top while scrolling.
- **Search and totals in report.html.** A search box in the filter bar keeps the rows with all its words (screen,
  check, detail), passes and info included; the run's failing, warning, passing and info totals sit under the title.
- **Details that say what is wrong.** A Jev finding gives the question it answered and its answer in words, and on a
  warning or failure what that answer means (for a score, the description of the nearest level), not `p=0.75` or
  `5.6/10`. A failing visual check (cut off, overlap, out of line, an error, a raw key) is boxed on the screenshot
  where Jev places it, first in the evidence; with several slices, each is asked first whether it shows it. This
  costs a few Jev calls per failing screen, within the budget.
- **usability** says why a click failed (what covered the control, or that it was hidden or moving), at which step and
  where, and adds the screen it stopped on; a dead click names its step, place and screen; hesitation and "not
  reached" say in words what Jev judged. Clicking the control that brought the user to this screen again, or the one
  marked as selected, isn't a dead click.
- **Unsure answers say what to look for.** A Jev warning between "no" and "yes" reads "Jev is unsure (yes 55%). Look
  for: …" with the defect it may be, rather than the description of the answer it leaned to.
- **A menu or dialog is asked about itself.** `audit` asks an opened menu or dialog whether its own items overlap,
  are cut off or out of line; the page behind it, covered on purpose and cut at the edges of tapcheck's cut-out of it,
  isn't part of the question, and Jev boxes a fault in the menu, not the page.
- **What the question excludes is measured.** As each slice is taken, tapcheck records the rows that scroll sideways (a
  rail of chips with a › button, a wide table), text shortened with "…", and small controls fixed over the page (a chat
  button). A cut Jev boxes at the end of such a row or on shortened text passes and says so; one under a fixed control
  is a warning, covered only until the page scrolls; anything else still fails.
- **A menu's items, measured in line.** When Jev is unsure whether an opened menu's items line up and their text is
  measured starting within 2 px of each other, the check passes and says so; a clear "out of line" still fails.
- **A help button is help.** The help heuristic counts a chat or assistant bubble, a "?" icon and a link to a guide;
  and when Jev still says no, a visible control named as help ("Ask …", "Help", "FAQ", "Learn", "… guide") passes it,
  measured, naming the control.
- **Banners say what the finding says.** A marked screenshot's banner goes through the `expect` rules too, so an
  accepted finding reads "EXPECTED: …" with its reason, in blue, not "FAIL"; and it names the check as the check
  ("FAILED CHECK: text is not cut off"), so a name that says what should be true doesn't read as the opposite of
  its boxes. The page's animations (a sidebar closing after the Tab checks) settle before it is taken.
- **Banners cut their text at a word,** ending with "…".
- **A menu's cut-out isn't the app's cut.** When the only text Jev boxes as cut off on a menu or dialog sits at the
  edge of tapcheck's cut-out of it, the finding is a warning that says the cut may be the crop's; the boxing questions
  carry the same note the first question did.

## 0.1.4 (2026-11-27)

Test only the devices an app is built for, and fixes from reviewing a long run on a real app, for false alarms and
for what the run didn't see.

- **Only the devices the app is for.** `devices` in `tapcheck.yml` (or `DEVICES=desktop,tablet` for one run) picks
  `desktop`, `tablet` and `mobile`, default all. The viewports of the others and `audit`'s 768 px tablet or 375 px phone
  are left out, so an app not built for a phone gets no phone findings. Without a desktop, `audit`'s full pass (dark
  mode, Jev's look, menus and dialogs) runs on the first chosen size.
- **The app's API on another subdomain is the app's.** `contract` checks calls to every host of the app's site
  (`api.example.com` for an app at `app.example.com`), each named with its host, and `interact`'s "no 5xx" check
  counts them too; `security` doesn't call them third-party. A name on a shared host (`my-app.vercel.app`) stands alone.
- **Screens that scroll a panel, not the page.** Where the document doesn't scroll but a panel filling the screen does
  (an app shell), Jev's slices scroll that panel, so what is below the first screen is seen.
- **A menu or dialog is judged on its own.** `audit` gives Jev the opened menu or dialog cut out of the screen, so the
  page it covers on purpose no longer reads as clipped, overlapping or out of line.
- **Near misses warn.** A Jev score from 5.5 to just under 7 is a warning; under 5.5 still fails.
- **Jev's questions.** "Cut off" no longer counts a row that scrolls sideways, text shortened with "…", a decorative
  picture or content past the bottom of the window or a panel; "out of line" counts edges and baselines, not columns
  of different text lengths or cards of unequal height; an empty state that asks to pick or search counts as loaded;
  the language heuristic judges terms against the screen's own users (`audience`, `context`).
- **ux.** A screen with clearly no main call to action records `design: cta`, `cta label` and the attention check as
  info. Its own target-size check is gone (`audit`'s has the WCAG spacing exception), it leaves the desktop `visual:`
  questions to `audit` when audit looked at that screen, and "controls on screen" names them and leaves out chips in a
  row that scrolls sideways.
- **audit.** Controls that scrolling moves apart (a floating chat button over a long page) no longer overlap; dark mode
  is told by the page's own colours and its large surfaces, so live data changing between two loads isn't a theme.
- **interact.** A selected tab, segment or the current page isn't a control that does nothing; a dead control is
  reported once per run with the screens it is on; console errors on another site's page (a sign-in provider) aren't
  the app's.
- **usability** never offers a control something covers, moves the pointer away after each step so a hover menu
  closes, and names the control a failed click was on.
- **security.** A side whose session isn't in a cookie gets an info, not a cookie-flag warning.
- **contract.** Latency is 800 ms p95 on the app's host and 2000 ms on its other hosts, and info under 20 calls; the
  baseline fills itself with endpoints seen for the first time; an endpoint's keys are those of all its responses,
  read from the whole body; capital-letter path segments (`/strikes/SPY`) are an `{id}`.
- **crawl.** Load time runs to the load event, not to the network going quiet, so live-data apps measure their load.
  Two screens that are one page get a "screens are distinct" warning. Hash screens and calls to the site's other
  hosts count for coverage.
- **a11y and audit keyboard checks** Tab from the main content as well as the top, so an app shell's menu isn't all
  they see; a11y's focus-ring check is gone (audit's is stricter).
- **audit.** Controls in the window are measured first, with an info row past 300; the consistency checks leave out
  bare fields inside a styled box (the box is measured), card buttons, page numbers and data shown as labels; dialogs
  are measured once loaded, and Jev asks whether they loaded; dark-mode contrast lists only what fails in dark.
- **interact.** A 5xx fails "clicks set off no 5xx" only, not the console check as well.
- **security.** With `signedIn` set, "pages need sign-in" opens the screens without the session and fails a page that
  still shows it; "API data needs sign-in" (info) lists the app's calls that answer with data signed out; new-tab
  links are read from the rendered pages.
- **ux and usability.** Trust and minimalism pass from 5.5; density, legibility, minimalism and the main-action
  question allow packed data screens, empty states, decorative pictures and one action repeated per card; the
  attention check warns at most and is info where the first screen has no main action; heatmap labels don't cover
  each other. usability describes icon-only controls as icons, and a side with no tasks is a skipped part.
- **Report.** `REPORT.md` lists the `expect:` matches and counts the other info rows; a part that checked nothing says
  so; what Jev judged gets its banner on each of its first three screenshots. `site()` keeps `api.abc.io` and
  `app.abc.io` one site (the three-label rule is for `co.uk`-style names only).
- **The saved session keeps only the sign-in.** Saving the session as each part ends keeps the cookies and the sign-in
  entries of local storage; the rest stays as it was at sign-in, so a filter or tab `interact` changed isn't carried
  into the next part or run.

## 0.1.3 (2026-11-26)

- **Hash-routed apps.** A screen at `/#scanner` or `/#/orders` is its own page: it is loaded afresh (so it has an
  HTTP status, not 0), the crawl keeps it apart from `/` and follows `#/route` links, and `interact` and `audit` treat
  a new hash as another screen.
- **Sign-in through Google, Discord and the like.** `login: manual` waits until the browser is back on the app's own
  site, so a provider's consent page no longer counts as signed in.
- **Sessions that end without a redirect.** `sides.<name>.signedIn` is a selector on every signed-in page; a page
  without it stops the side as "session expired", for apps that show their sign-in form at the same address. The saved
  session is written again as each part ends, so sign-ins whose tokens change on every refresh stay good across parts
  and runs.
- **interact** never clicks a dark mode, light mode or theme control, which would change the account's settings.
- **context and expect.** `context:` says what kind of product it is (a dense trading tool, a clinical system) and goes
  to Jev with every question, so screens are judged against what its users expect. `expect:` lists findings that are
  right for the product, as `{ match, why }` on `<suite>: <check> @ <where>`: a matching fail or warn is recorded as
  info with the reason, so it stays in the report without failing the run.
- **Marked screenshots.** `MARK=1` (or `marks: true`) puts a marked screenshot first in a failing or warning finding's
  evidence: the screen as it was measured, a banner above it saying the check, and a box, a number and a note on each
  element, placed so that none covers another. `audit`, `a11y`, `crawl` and `interact` mark the elements they found;
  what Jev judged, and a failed flow step, get the banner alone. Off by default, and nothing changes without it.
- **t.mark.** `t.mark(check, status, marks, detail?)` records a finding a flow decided, with a marked screenshot of
  the current page: red for a bug, green for a pass, blue for a setting, amber for a question. It needs no Jev.
- **Verify a release or a pull request.** The new `tapcheck-verify` skill splits a release note, a pull request or a
  range of commits into items and writes a flow for each. A flow says which item it checks with `item:`, or
  `t.untested(why)` when it can't be checked now; `ONLY=verify` runs just those flows, and the report opens with
  "Release verification": the count, the failed items with their steps and screenshots, the passed table, the
  questions and what wasn't tested. `verify` is a tag now, so no side can be called that.

## 0.1.2 (2026-11-25)

- **GitHub Marketplace.** The Action is named "tapcheck audit", since the Marketplace needs a name no GitHub account
  uses. It is still used as `ashishjain15491/tapcheck@<tag>`.
- **Escaping fixes** (from CodeQL). A backslash in a coverage row no longer breaks its `COVERAGE.md` table cell, and a
  `login.form` field name with a backslash in it finds its field.

## 0.1.1 (2026-11-25)

No change to what tapcheck checks or how it runs.

- **README and logo.** A shorter README in the usual layout, with the tapcheck logo (light and dark), a report
  screenshot and badges, and setup steps for each way to run it: writing `tapcheck.yml`, the Jev key, sign-in
  variables, then the plugin, npm, the Action and Docker. The logo kit and the social preview are in `assets/`; the
  Codex plugin and the Action use the brand colour.
- **GitHub Marketplace.** The Action's description fits the Marketplace's 125 characters.
- **Action.** It runs on the current `actions/setup-node` and `actions/upload-artifact` (v7).
- **Releases from GitHub.** `.github/workflows/publish.yml` publishes to npm when a release is published, through npm
  trusted publishing with provenance; the release steps are in `CONTRIBUTING.md`.
- **Repository.** Dependabot updates, a security policy, issue forms, a pull request template and a code of conduct.

## 0.1.0 (2026-11-25)

The first release: on npm as `@ashishjain15491/tapcheck` (the CLI is still `tapcheck`), and as the GitHub Action
`ashishjain15491/tapcheck@v0.1.0`.

- **Core harness.** One `tapcheck.yml` describes the app: how to start, stop and reset it, its sides and how each
  signs in (`none`, `manual`, `form` with optional TOTP, `command`), screens, tasks and viewports. `$NAME` values come
  from the environment. One run writes `report.html`, `REPORT.md`, `findings.json` and the evidence. Parts that were
  skipped or couldn't run (no Jev key, budget reached, sign-in failed, session expired) get a "part ran" finding each,
  so the report says which and why.
- **Measured suites.** `crawl` (page status, load time, console errors, broken images and links, unlabelled fields),
  `contract` (API status, JSON that parses, latency, response shape against a saved baseline), `security` (headers,
  cookie flags, pages that need sign-in, CSRF, served secrets, third-party requests) and `a11y` (axe-core WCAG 2.2
  A/AA, keyboard focus, page language).
- **Interaction and UI audit suites.** `interact` clicks every safe control on the crawled
  screens and reports page errors, 5xx answers, native dialogs and controls that do nothing; checks each dialog it
  opens (accessible name, focus, Escape, an error state for invalid input) and each table's sorting, search, paging
  and row menu; and writes `interact.json`. `audit` is the full UI audit per screen: desktop light and dark, tablet
  and phone, opened menus and dialogs, component and label-case consistency across screens, optional design-token
  adherence, and Jev's look when Jev is on; it writes `audit.json`. New keys: `interact: {max, submit}`,
  `audit: {max, skip}`, `design: {colors, fonts, radii, spacing}`. `interact.submit: true` changes data and is for a
  throwaway database only.
- **Run-level additions.** `HEADED=1`, `SLOWMO=<ms>` and `START_DELAY=<s>` for watching a run;
  `RECORD=1` for a video and a Playwright trace of every browser context, linked from the report. Flows get
  `t.jev(label, questions?)` (Jev's look at the current page) and `t.mail.judge(mail, questions?)` (at an email), both
  skipped cleanly with `JEV=off`. Every run writes `hits.json` per side, and `COVERAGE=1` merges all runs into
  `COVERAGE.md`: each route with the part that reached it or GAP (`coverage: {file, reasons}`). `app.resetWhen` runs
  `app.reset` by itself when matching files changed since the last reset. `stub.dns` answers DNS over UDP
  (`TAPCHECK_DNS`), with overrides through the control API and `t.stub.dns()`.
- **Jev suites.** `ux` (visual QA, design, heuristics, a five-second test, predicted attention) and `usability` (a
  simulated first-time user attempting each task, with a clickstream), with a per-run budget, a memo, and a log of
  every request. Unsure answers are warnings.
- **Parts.** Every suite on every side is a part; `ONLY` and `SKIP` pick them by name or tag, `LIST=1` prints them,
  `CHANGED=1` runs only the parts whose files changed since each last passed. `CHANGED=<git ref>` (the Action's
  `changed: base`) is QA for a pull request: the parts whose files changed since the branch point with that ref, with
  no state needed. `changes:` also keys on a part name, so each flow can depend on its own files. `parallel: <n>`
  (or `PARALLEL=<n>`) runs that many of a side's flows at once; a flow with `serial: true` runs alone.
- **Your own checks.** `gates` (the project's linters and audits, as the part `code`), `routes` (route coverage and
  writing routes without sign-in), `stub` (a stand-in for outside services, with a control API) and `flows` (custom
  journeys with `t.step`, `t.stub`, `t.mail`).
- **Plugin.** A Claude Code and Codex plugin with three skills: `tapcheck-setup`, `tapcheck-run`, `tapcheck-fix`,
  and recipes for Laravel, Django, Rails, Express and Next.js, Go and static sites.
- **Shipping.** A compiled npm package (`dist/`, Node.js 22.18 or newer) with types for flows; a JSON Schema for
  `tapcheck.yml`; a Docker image on the official Playwright image; a GitHub Action that runs tapcheck, writes the
  job summary and uploads the run folder; CI with a type check. A missing Chromium is now one line naming the
  command that installs it, and `CHANGED=1` works where git has no author configured (containers, CI runners).
- **Fixes from the first real project.** The crawl follows the links it finds before the route list, and
  only pages it actually crawled count toward `crawl.max` (a long route list used to crowd the links out). The
  signed-out check follows redirects, so `/` → `/admin` → `/login` counts as refused. A CSRF token cookie
  (`XSRF-TOKEN`, `csrftoken`) may be readable by script. The CSRF probe goes to the sides that sign in (every side
  when none does), and a side can have its own `csrf`. Flows get `t.note(name, detail, 'warn' | 'info')` and a
  `timeout` (default 3600 s), so a flow that hangs fails instead of stalling the run. A step that returns
  `{ warn: '…' }` is recorded as a warning, and `t.mail` has `count()` and `all()`, with each message's `id` and
  `headers` (for checks such as List-Unsubscribe on every email of a send).
  `t.jev()` waits for the page to settle and looks again when the page reloads under it. The crawl takes a link to a
  file (a PDF download) for what it is, not a page that answered 0, and a signed-out side skips the routes the list
  marks `auth`. Stopping the app stops what `app.start` left running in the background too, and `app.stop` runs only
  when tapcheck started the app. The setup skill has a step for what the app needs around it: outside services,
  background work, build and seed. A page load that fails (a timeout on a busy app, an aborted
  navigation) is tried once more before it counts. Flows: a flow past its timeout records nothing more, `t.signal` is
  aborted and `t.cleanup(fn)` callbacks run; each step prints a line as it ends; `t.ask` (Jev about text, on the
  budget), `t.reach`, `t.page({ fresh: true })`, `t.dir` and a failing `t.note`; `t.goto` notices an ended session;
  `VISUAL` and `EMAIL` are exported; a Jev request is capped at 120 s and retried once, and an outage is a warning;
  with a dialog open `t.jev` looks at the screen only; failure screenshots are numbered so long names can't overwrite
  each other. The visual "error shown" question no longer counts a notice about the data as an error.
  Past its timeout a flow's pages are closed before its cleanups run, and only the cleanups' own `t.*` calls still
  work (the abandoned run() stops at its next one); `t.use(page)` makes a page current again; `t.reach` takes the
  answer's status and skips refused ones; Mailpit and stub calls give up after 30 s or at the timeout;
  `t.mail.all({ limit })`; a form POST with `_method` is reached as that method.
  `browser.args` passes extra switches to the run's Chromium (an app on localhost whose sandboxed preview frames load
  its own files needs `--disable-features=LocalNetworkAccessChecks`). A side whose sign-in fails says so in the
  terminal, not only in the report.
  Waiting for a page to settle is capped outside the page, so a page whose own timers never fire (one
  sandboxed by its CSP without `allow-scripts`, such as an email preview) can't hang the run.
  `t.page({ viewport: 'mobile' })` hands a flow a page at any of the config's viewports (the first one by default), so
  a flow can check a journey at a phone's width and have Jev look at it.
