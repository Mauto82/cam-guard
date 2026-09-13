# Giorgia

*`cam-guard` — codename Giorgia.*

Local, automatic moderation of webcams in video chats. Pluggable sources hand
it **still frames** (never video streams), local detectors score them, a
configurable policy decides, and your platform's adapters act. Nothing leaves
the machine: no cloud service, no image uploaded anywhere.

Platform-agnostic by design: cam-guard knows nothing about any chat. You give
it a way to grab frames and a set of functions to warn, close a camera, kick or
suspend; it gives you decisions, evidence and events.

> Status: early. `core`, `detector-nudenet` and the bot work end to end on a
> folder of images. The Playwright source, notifiers and the dashboard come
> next.

**Out of the box it detects explicit nudity only.** Child-presence detection
is optional: a separate package, off by default, because it is much heavier
(a person detector plus an age model on every person in the frame) and
won't fit on a modest server alongside the nudity detector.

## What it does NOT do — read this first

- **It does not detect child sexual abuse material.** Nothing here is built or
  suitable for that. Dedicated, vetted programs exist, and in most
  jurisdictions finding such material carries legal reporting obligations that
  no library can discharge for you.
- **Age estimation is unreliable above roughly 12–13 years.** The optional
  `detector-minor` can flag the likely presence of a young child; it cannot
  tell a 15-year-old from a 19-year-old, and it must not be used as if it could.
  It will miss children who are small, dark or half hidden in the background,
  and misfire on photos, posters and TV screens.
- **Final decisions stay human.** A permanent ban is never automatic — the
  policy loader refuses a config that asks for one. Automatic actions are
  temporary (close camera, kick, time-limited suspension) and every one of
  them leaves evidence a moderator can review and overturn.
- **Detectors make mistakes**, in both directions and not uniformly across
  people. Run in `report` mode first, review in the dashboard, tune thresholds,
  then enable `auto`.

## Privacy

- Frames are analysed in memory and discarded.
- Only frames that led to a decision are kept, as evidence, in a local
  directory you choose.
- Retention is configurable (default 30 days; cases a moderator confirmed are
  kept longer, 1 year by default, for appeals).

## Packages

| Package | What |
|---|---|
| `@cam-guard/core` | Types, `PolicyEngine`, `Scheduler`, `EvidenceStore`, the `CamGuard` pipeline and its typed events |
| `@cam-guard/detector-nudenet` | NudeNet v3 (YOLOv8) on ONNX Runtime, CPU |
| `@cam-guard/bot` | The `cam-guard` executable: `run` (the moderation loop, from a config file) and `detect` (one-off timings on images) |
| *planned, optional* `@cam-guard/detector-minor` | Presence of young children (person detector + MiVOLO v2 age estimation). Not installed by default |
| *planned* `@cam-guard/source-playwright` | Grab frames from `<video>` elements of a web chat |
| *planned* `@cam-guard/notify-telegram` | Reports to moderators with the frame attached |
| *planned* `apps/dashboard` | Local review UI over the evidence store |

## Quick start

Node 20+, pnpm.

```bash
pnpm install
pnpm build
pnpm cam-guard detect photo.jpg            # downloads the 320n model on first use
pnpm cam-guard detect photo.jpg --runs 50  # more timed runs
pnpm cam-guard detect photo.jpg --json
```

```
photo.jpg  (1024×600, nudenet-320n)
  FACE_FEMALE                0.848  box x=348 y=168 w=199 h=189
  timing over 50 run(s): preprocess 5.5 ms · inference 11.3 ms · postprocess 0.1 ms · total 17.0 ms (p50 15.4 ms, max 43.2 ms)
  model load 41.2 ms · first run 16.1 ms (warm-up, not counted)
  ✓ within the 100 ms budget
```

## Try it without a chat

The bot runs the whole loop — source, detector, policy, evidence, actions —
from a config file. With the built-in **folder source** every user folder is a
camera and its images are the frames it shows, in filename order:

```
examples/frames/
  lobby/            ← room
    alice/          ← user = one camera
      0001.jpg      ← frames
      0002.jpg
  adults-1/
    carol/
      …
```

```bash
pnpm cam-guard run --config examples/bot.yaml --fast --once
```

- `--fast` replays with a virtual clock: frames 10 s apart are processed back
  to back, and decisions are the same as in real time because the policy takes
  time from the frames.
- `--once` stops when every camera has run out of frames.
- `--mode auto` calls the platform adapters; `--dry-run` records what would
  have been done without doing it.

Output, one line per event (`log.format: json` for machine-readable lines):

```
… START  mode=report detectors=nudenet-320n source=folder:frames clock=virtual
… WATCH  alice@lobby explicit-nudity top=0.52 → sampling faster for 120 s
… REPORT alice@lobby explicit-nudity act offence=1 top=0.95 (FEMALE_BREAST_EXPOSED) hits=3/3 evidence=1757790000000-3f2a9c1e
… ACTION alice@lobby close_cam → report_only
… ACTION alice@lobby warn → report_only
```

See [`examples/bot.yaml`](examples/bot.yaml) for every option. Two extension
points take a module path instead of built-in code:

- `adapters:` — your platform's `warn`, `closeCam`, `kick`, `suspend`
  (named or default exports); needed only in `auto` mode. Template:
  [`examples/adapters.example.mjs`](examples/adapters.example.mjs).
- `source: { module: ./my-source.mjs, options: {…} }` — a module whose
  default export `(options) => Source` grabs frames from wherever you like.

## The pipeline in code

```ts
import { CamGuard, EvidenceStore, loadPolicyConfig, PolicyEngine, Scheduler } from "@cam-guard/core";
import { NudeNetDetector } from "@cam-guard/detector-nudenet";

const guard = new CamGuard({
  detectors: [new NudeNetDetector({ model: "320n" })],
  policy: new PolicyEngine(await loadPolicyConfig("policy.yaml")),
  evidence: new EvidenceStore({ dir: "./evidence", retentionMs: 30 * 86_400_000 }),
  mode: "report", // "auto" calls the adapters below
  actions: {
    warn: (user, text) => chat.sendPrivate(user.userId, text),
    closeCam: (user) => chat.closeCamera(user.userId),
    kick: (user, reason) => chat.kick(user.userId, reason),
    suspend: (user, hours, reason) => chat.suspend(user.userId, hours, reason),
  },
});

const scheduler = new Scheduler({
  sources: [mySource],        // implements Source: listActive() + capture()
  intervalMs: 10_000,         // one frame per camera every 10 s
  priorityIntervalMs: 2_000,  // …every 2 s for someone being watched
  onFrame: (frame) => guard.process(frame).then(() => {}),
});

guard.on("report", ({ decision, evidence }) => notifyModerators(decision, evidence));
guard.on("action", ({ action, result }) => log(action.type, result.outcome));
// A first weak hint: sample that camera faster, so a real case is confirmed in
// seconds instead of waiting for the next round.
guard.on("watch", ({ decision, forMs }) => scheduler.prioritize(decision.subject.userId, forMs));

await scheduler.start();
```

### Core concepts

- **Detector** — `detect(image) → Detection[]`, each `{ label, score 0..1, box }`.
  Boxes are **normalised** (0..1 of the frame), so "minimum area" means the
  same thing at any resolution.
- **PolicyEngine** — per-room profiles; per rule: labels that count, a
  threshold to *report* and one to *act* (optionally per label), a lower
  *watch* threshold, minimum box area, N consecutive frames or N of the last M,
  actions, and an escalation window. Keeps a memory per user. Deterministic:
  time comes from the frame, not the clock, so replaying frames replays
  decisions.
- **Scheduler** — round-robin over every active camera, one frame per
  interval; prioritised users go first and more often. Sequential on purpose:
  detection is CPU-bound.
- **EvidenceStore** — `<dir>/YYYY-MM-DD/<id>/event.json` plus the frames of the
  streak that triggered the decision; review status; retention.
- **Events** — `detection`, `watch`, `report`, `action`, `error`.
- **Modes** — `report` records what *would* have been done; `auto` calls your
  adapters; `dryRun` resolves everything as a dry run.

## Default policy

This is [`policy.example.yaml`](policy.example.yaml), validated by the test
suite:

- **Explicit nudity** (`*_GENITALIA_EXPOSED`, `ANUS_EXPOSED`,
  `FEMALE_BREAST_EXPOSED`, `BUTTOCKS_EXPOSED`) where it is not allowed: a first
  hint ≥ 0.4 → sample that camera faster for 2 minutes; score ≥ 0.6 on 3
  consecutive frames → report; ≥ 0.85 → close the camera and warn; a second
  time within 24 h → kick and suspend for 24 h. Never an automatic permanent
  ban.
- **Per-room profiles**: in `adults-*` rooms nudity is only reported (at 0.85);
  `test-room` is not moderated.

With the optional child detector,
[`examples/policy.with-children.yaml`](examples/policy.with-children.yaml) adds
**`CHILD_PRESENT`**, tuned for the typical case — a parent on camera, children
walking in and out of shot or visible in the background: 2 hits in the last 5
frames (a child crossing the room must not reset the count), reported to
moderators only. Add an `act` step (e.g. warn, then kick 5 s later) once the
thresholds are tuned on your own traffic.

```yaml
version: 1
x-rules:
  explicit-nudity: &explicit-nudity
    id: explicit-nudity
    labels: [FEMALE_GENITALIA_EXPOSED, MALE_GENITALIA_EXPOSED, ANUS_EXPOSED, FEMALE_BREAST_EXPOSED, BUTTOCKS_EXPOSED]
    minArea: 0.002
    consecutiveFrames: 3
    rearmAfter: 60s
    watch: { threshold: 0.4, for: 2m }
    report: { threshold: 0.6, actions: [report] }
    act:
      threshold: 0.85
      window: 24h
      steps:
        - [report, close_cam, { type: warn, message: "…" }]
        - [report, { type: kick, message: "…" }, { type: suspend, hours: 24, message: "…" }]
profiles:
  strict: { rules: [*explicit-nudity] }
  adults:
    rules:
      - <<: *explicit-nudity
        report: { threshold: 0.85, actions: [report] }
        act: null
rooms:
  default: strict
  overrides: { "adults-*": adults, "test-room": "off" }
```

Rule semantics worth knowing:

- `consecutiveFrames: 3` is shorthand for `frames: { hits: 3, of: 3 }`.
  `frames: { hits: 2, of: 5 }` fires when 2 of the last 5 frames hit,
  tolerating gaps.
- An episode fires **once**, not on every following frame. It is over after
  `of - hits + 1` clean frames in a row (a single one for consecutive frames).
  If it never ends, it re-arms after `rearmAfter` — so a user who ignores a
  warning does escalate.
- `watch` is a hint, not a verdict: no evidence is saved and nothing happens
  to the user; the `watch` event only asks the scheduler to look again soon.
- The *n*-th act within `window` runs `steps[n-1]`; the last step repeats.
  Without `window` there is no escalation, only a counter.
- An act does not also produce a separate report for the same streak.

## NudeNet models

Weights belong to the [NudeNet](https://github.com/notAI-tech/NudeNet)
project and are not in this repository. They are fetched on first use into
`~/.cache/cam-guard/models` (or `$CAM_GUARD_MODELS_DIR`) and **verified by
sha256** — a mismatched or truncated file is refused.

| Model | Size | Source | p50 on an Apple-silicon laptop |
|---|---|---|---|
| `320n` (default) | 12 MB | PyPI wheel `nudenet==3.4.2`, anonymous | ~15 ms |
| `640m` | 104 MB | GitHub release, **needs `GITHUB_TOKEN`** | ~300 ms |

NudeNet's GitHub release assets require a signed-in account, so an anonymous
download gets a sign-in page (which cam-guard detects and refuses). `320n` is
therefore taken from the PyPI wheel, where upstream bundles the same file
(identical hash). For `640m`, set `GITHUB_TOKEN` (any token, no scopes), or
download it yourself and place it at
`~/.cache/cam-guard/models/nudenet-640m.onnx`.

### Channel order: a deliberate difference from upstream

Upstream NudeNet 3.4.2 feeds the model **BGR**: its OpenCV preprocessing swaps
channels twice (`cvtColor(RGBA2BGR)` on an already-BGR image, then
`swapRB=True`). The model was trained with ultralytics, which uses RGB.
cam-guard feeds RGB by default. Boxes are the same; scores are higher (on a
test portrait 0.82 instead of 0.73). If you have thresholds tuned against the
Python package, use `channelOrder: "bgr"` (CLI: `--channels bgr`).

`tools/verify_nudenet.py` checks parity with upstream in BGR mode
(`uv run tools/verify_nudenet.py image.jpg …`): same labels, box IoU ≥ 0.85,
scores within 0.06 — the residual difference comes from resampling
(antialiased in cam-guard, plain `INTER_LINEAR` upstream).

## Development

```bash
pnpm test        # vitest, synthetic fixtures only — never real imagery
pnpm typecheck   # strict TypeScript over sources and tests
pnpm build
```

The detector integration tests run only when the 320n model is already
cached, so CI without network skips them.

Python is used only in `tools/`, never at run time.

## Acknowledgements

- [NudeNet](https://github.com/notAI-tech/NudeNet) by notAI-tech, whose
  model does the detection.
- Written with the help of [Claude](https://claude.ai) (Anthropic) as a
  coding assistant.

## License

MIT. The NudeNet weights are distributed by their authors under their own
terms.
