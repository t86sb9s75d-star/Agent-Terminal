# Visual Reference Audit

Reference set: 13 screenshots (Apple iPhone 17 Pro product pages; an Awwwards
showcase of a Unitree Go2 robot landing page, including its color/type
element breakdown). `visualidentity.studio` was **not inspected** — this
environment's outbound network policy blocks it (proxy returns 403 on
connect). Its interaction behavior is not claimed as verified evidence
anywhere below. Everything here is derived from the 13 images only.

This file exists so later work on Rucker Park has something to check itself
against, instead of drifting back toward generic dashboard defaults.

## Structural findings

**One dominant element per screen.** Every section has a single focal point
— a headline, or a product shot — never several same-weight blocks
competing for attention. Supporting text and specs are visibly secondary:
smaller, muted, positioned after the dominant element, not beside it as an
equal.

**Plain label/value structure over card chrome.** The camera-spec comparison
(48MP Fusion Main / Ultra Wide / Telephoto) separates columns with a heading,
a thin rule, then bare `label` / `value` lines. No boxes, no shadows, no
per-field borders. Separation comes from whitespace and one hairline rule,
not containers.

**Bold, tight-tracking display type + a muted support tier.** Headlines are
large, bold, negative letter-spacing. A small-caps colored "eyebrow" label
(e.g. "Cameras", "Pro video") sits above the headline. Body copy is
noticeably smaller and muted-gray. There are exactly two typographic
registers in play at once, never a gradient of five.

**Numbers get their own treatment.** Big bold colored numerals ("8x",
"48MP", "40% faster") paired with a small muted label underneath. This
pattern already existed in Rucker Park's stat tiles and is confirmed by the
references — kept and extended (see `.metric` primitive).

**Segmented controls change content in place.** The zoom-length selector
(200mm/100mm/48mm/...) and the feature selector (Colors/Aluminum
unibody/Vapor chamber/...) are real mutually-exclusive toggles: one
selection swaps the visible content without navigating away. They are not
decorative — every pill is a functioning control.

**Near-flat surfaces.** Backgrounds are dark, close to black but not pure
black. Panels, where they exist, are separated by spacing and a hairline
border, not shadow/elevation. Depth comes from layering large imagery
behind text, not from raised cards.

## Hierarchy rules (applied to Rucker Park)

1. System condition / anything requiring attention — dominant.
2. Active runs right now.
3. Failures, cancellations, integrity warnings.
4. Recent completions.
5. Usage and cost (quieter, numeric).
6. Recent activity feed (quietest — a record, not the headline).

Sections with no real data collapse to a strong, explicit empty state
("Nothing running right now.") rather than rendering an empty card. A
6-section page every time, whether or not there's anything to say, would
recreate the "wall of equal cards" problem the references avoid.

## Typography

- Display headline (Command condition statement): large, bold, tight
  tracking (`--text-display`, `-0.025em`).
- Section label: small, uppercase, wide tracking, muted (`.section-title`).
- Body / metadata: regular weight, muted or faint color tier — never more
  than two muted tiers active in the same block.
- Numerals: tabular-nums always, bold weight, own color when it's a status
  number (green/red/amber), default text color otherwise.

## Surfaces & spacing

- `--bg` / `--bg-elevated` / `--bg-inset` — three flat tiers, no shadows.
- One hairline `--border` for separation; `--border-strong` only for
  interactive edges (inputs, active nav).
- Spacing scale (`--space-1` … `--space-12`) — sections separate by
  whitespace multiples, not by wrapping everything in a bordered box.

## Segmented controls — where they are and are not allowed

**Allowed** (real, in-place, mutually-exclusive choice):
- Provider selection in the agent form.
- Activity event-type filter.

**Not allowed** — these stay as plain text / integrated rows / icon+text,
never pills or badges:
- Agent status (dot + text via `.status`, not a pill).
- Provider name and model name in ordinary rows.
- Run outcomes, token counts, costs, timestamps.
- Any decorative category label.

The distinction: a segmented control changes what's displayed. A pill that
just labels a fixed fact is chrome, and Rucker Park doesn't use it for that.

## Motion

Tied to real state changes only:
- View switch: brief fade/rise (`view-enter`).
- Status changes on an open detail panel: one-shot `flash`, not a loop.
- New activity event arriving live: brief highlight wash, once.
- Activity row expand/collapse: height/opacity transition.
- Modal/dialog open: fade + slight scale-in.

Rejected: ambient/looping animation, particle or flow effects, pulsing every
"running" indicator continuously, cinematic page transitions. All
transitions respect `prefers-reduced-motion` (durations collapse to ~0).

## Patterns intentionally rejected

- Card grids of equal-weight tiles as a default layout (Command, Agents).
- Rounded pill/badge chrome for status, metadata, or counts.
- Isometric/game-like visualization of agents (explicitly rejected earlier
  in this project against a different reference set).
- Fabricated metrics (a single "reliability" score, fake activity, sample
  data) — every number shown must trace to real backend state.

## Mapping to the three real views

| View | What changed |
|---|---|
| Command | Replaced 5 equal stat tiles with a dominant condition headline, conditional "Active now" / "Needs attention" / "Recently completed" sections (empty-stated when there's nothing), then quieter metrics, then the activity feed. |
| Agents | Replaced the card grid with an index list (compact, scannable rows: status, name, role, cost) + a detail panel (identity fields as plain rows, live output, run history). List context is preserved when a detail is open. |
| Activity | Two-level rows: a human-readable summary line always visible, a technical detail block (run id, provider, tokens, cost, error, flag reason) that expands in place. Filtering uses a segmented control over real event categories only. |

---

## Addendum: Phase 2 — Workstreams (organization-centered iteration)

Phase 1 (baseline commit `f096bf0`) is unchanged by this addendum — it established the visual system above. This section records what Phase 2 added and, more importantly, how it stayed inside those rules rather than starting a new visual language.

**What changed conceptually, not visually.** Workstreams introduces a hierarchy (`Workstream → Agents → Runs → Events`) so Command and Activity can talk about objectives ("Authentication — Reviewer's run failed. Builder completed a run.") instead of only disconnected agent events. This is a data-model and information-architecture change. It reuses every visual rule above without exception:

- **No new chrome.** Workstream status (Planning/Active/Blocked/Review/Completed/Archived) uses the same `.status` primitive (shape + color + text) as run/agent status — never a pill. Three new shapes were added (square=Planning, ring=Blocked, plain dot=Review) following the existing rule that shape, not color alone, carries meaning.
- **Segmented controls stayed disciplined.** The only two new segmented controls are a status *override* picker (a real mutually-exclusive choice that changes the workstream's stored state) and an Activity Flat/Grouped toggle (changes what's displayed, in place). Provider labels, agent rows, cost, and timestamps inside Workstreams are still plain text rows — the same restraint audited above, not relaxed for the new feature.
- **List/detail language reused, not shared.** The Workstreams view is visually identical to the Agents split view (same spacing, same row treatment, same detail-panel classes), implemented as parallel CSS rules under new class names (`.workstream-row`, not a repurposed `.agent-row`) specifically so nothing about Agents could regress by touching shared classes.
- **Synthesis is factual, not interpretive.** The Command "Workstreams" section composes its one-line summary from the same `humanizeEvent()` phrasing already used in Activity ("Reviewer's run failed. Builder completed a run."), not invented narrative language ("waiting for fixes," "on track"). The system doesn't understand intent or blockers; the copy doesn't claim it does.
- **Progress is honestly absent.** A workstream detail panel always shows "Progress unavailable" with a footnote explaining why (no planned-work baseline is tracked). This was a deliberate choice over deriving a run-success ratio and calling it "progress" — those answer different questions, and conflating them would repeat the exact mistake the Phase 1 cost-aggregation fix corrected.
- **History is permanent by construction, not by convention.** Each run snapshots the workstream it belonged to *at the moment it started* (`runsStore.startRun`). Reassigning an agent later changes where its *future* runs land, never where its past runs are counted — enforced by tests, not just documentation.

Nothing in Missions/Approvals/Decision Rooms/System Map territory was started. Workstreams is the organizational layer; those remain deferred.
