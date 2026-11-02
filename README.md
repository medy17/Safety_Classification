# Safety_Classification

> [!WARNING]
> **This is an experiment.** It is a research prototype for working out how to rate adult content, not a finished or validated moderation system.
> - The ratings have not been checked against labelled ground truth beyond a 10-video pilot.
> - It depends on an **alpha** API (OpenRouter Decisions) whose request format, models and refusal behaviour may change without notice.
> - Don't use it as the only safeguard for anything real.
> - The repository contains code and scale definitions only. It has no media, transcripts or classification results.

Safety_Classification rates how SFW–NSFW a piece of content is on an invented **S0–S5 scale** (the "Silk" scale). It works on videos (sampled frames and transcripts), single images and text prompts, and uses OpenRouter's Decisions API with `openai/gpt-6-luna-decisions`.

It started as a way to test a rating approach on a hard input type, long videos, before using the same questions to classify prompts and images in a chat app.

## The idea

The model never picks a rating. It answers narrow factual questions about each image or piece of text and returns a probability for each:

- Is a nipple visible?
- Is the person nude underneath, with only cups, hands or patches covering them?
- Is an act being performed, simulated or mimed?
- Is the camera framing the crotch?

A rules file then turns those answers into a level, locally. This has three benefits:

- **Factual questions are easier to answer reliably** than "is this a 3 or a 4?".
- **The scale is cheap to change.** Answers are cached, so you can edit rules or thresholds and re-score everything without new API calls.
- **The same question sets work on any input.** A video frame and a user-uploaded image are classified the same way.

```
frame / image ──► 26 visual questions ──► answers (probabilities) ──┐
                                                                    ├──► rules.json ──► S-level + flags
transcript / prompt ──► 17 text questions ──► answers ──────────────┘
                                   (optional heuristics run across the sequence of frames)
```

## The Silk scale

| Level | Meaning |
|---|---|
| S0 Safe | No people, or people clothed and neutral. No romantic or sexual content. |
| S1 Romantic | Clothed; affectionate, romantic or flirtatious. |
| S2 Suggestive | Revealing clothing, sexualized body focus, innuendo or teasing. |
| S3 Mature | Underwear or swimwear, sexualized posing, groping, sexualized saliva or oil, overt but non-explicit intent. |
| S4 Explicit | Covered or partial nudity, sex acts simulated, mimed or narrated with euphemism, semen-like fluids. |
| S5 Graphic | Visible nudity, sex acts while undressed, or graphic sexual description. |

Flags are reported separately from the level, so a product's policy can act on them independently:

- **Image flags:** `minor_appearance`, `minor_sexualized`, `drawn_or_rendered`.
- **Text flags:** `non_consent`, `minor_coded`, `family_roleplay`.

**Minor-related questions are never inferred from refusals.** A refused minor-appearance question should go to a human, not be scored either way.

The scale lives in `scales/silk-v1/`:

| File | Contents |
|---|---|
| `visual.json` | Image questions: people type, clothing level, covered nudity, exposed breasts/genitals, pose, seven acts, five fluids, six body-focus areas, minor appearance, setting. |
| `verbal.json` | Text questions: sexual content level, explicit language, the same seven acts and five fluids, consent, minor-coding, family roleplay. |
| `rules.json` | Threshold, levels, rules, flags and heuristics. The header documents the condition syntax. |

The `questions` objects are literal Decisions API payloads.

## Heuristics

Anything that looks across frames, rather than at one answer, is an optional module in `src/heuristics/`. You turn each one on per scale in `rules.json`:

| Module | Stage | What it does |
|---|---|---|
| `refusal-runs` | items | A refused question counts as "yes" only when an adjacent frame also refused it or answered yes. |
| `refusal-constant` | items | Every refused question counts as a fixed probability. The blunt alternative; off by default. |
| `confirmed-peak` | summary | Adds `confirmedPeak`, the highest level held by at least N frames in a row, so a single flickering frame can't set the peak. |

`video.ratingFrom` chooses which metric becomes the rating: `peak`, `sustained` or `confirmedPeak`.

## Findings from the pilot

A 10-video pilot (5.2 hours of ASMR roleplay, mostly adult-themed) produced these observations. They're notes from an experiment, not conclusions:

- **Refusals.** OpenAI sometimes declines to answer individual image questions. These come back as `502 "OpenAI refused to answer question \"act_fellatio\""` with no reason given.
  - This happened on 50 of 349 frames and on no text, even graphic transcripts.
  - Refusals tend to mean "yes", but they flicker. Similar frames a minute apart often got a plain "no". Runs of refusals lined up with real acts; isolated ones mostly didn't. That's why `refusal-runs` exists.
- **Wording matters a lot.**
  - Licking an ear-shaped binaural microphone was read as fellatio at 0.97 until the act questions excluded microphones.
  - "Covered nudity" fired on low-cut costumes until it required no fabric over the area. It then missed a shirt pulled up over bare breasts, which is still open.
- **Sampling.** One frame per minute, sent one frame per request, was the best trade-off.
  - Scene-cut frames added almost nothing.
  - One frame every 2 minutes missed brief peaks in 3 of 10 videos.
  - Multi-frame grids are about 8× cheaper, but give one answer per batch, so there's no per-frame timeline.
- **Blind spots.** Acts hidden by framing aren't visible in single frames. Videos with little speech give the transcript side nothing to work with; transcripts don't include non-verbal audio.
- **No caching observed.** Repeated identical question sets were billed in full each time, so the question set (about 5,100 of the roughly 5,500 tokens in an image request) dominates cost.

## Getting started

**Requirements:**
- Node.js 22.9 or newer, with no dependencies.
- FFmpeg and FFprobe.
- An OpenRouter key with access to `openai/gpt-6-luna-decisions`.

```bash
cp config.example.json config.json    # set mediaDir, stateDir and the ffmpeg paths
echo "OPENROUTER_API_KEY=sk-or-..." > .env.local

npm run cli -- scale                  # validate the scale files
npm run cli -- plan                   # frame/window counts and a cost estimate; no API calls
npm run cli -- classify --limit 5     # start small; --ids a,b and --match "text" also select videos
npm run cli -- classify               # the rest; cached answers make it resumable
npm run cli -- rescore                # re-apply rules.json and heuristics; no API calls
npm run cli -- try --text "..."       # classify one prompt
npm run cli -- try --image file.jpg   # classify one image
npm run review                        # http://127.0.0.1:4317, label frames and see calibration
npm test
```

**How videos are found.** Videos are read from the top level of `mediaDir`. Transcripts are optional `<video name>.ko.srt` / `.en.srt` sidecars. Filenames like `YYYY-MM-DD - English Title — Korean Title [ID].mp4` are parsed for a date, titles and an ID; anything else is used as-is.

**What gets written.** The run writes only to `stateDir`; the media folder is only read.

| Output | Contents |
|---|---|
| `state/report/results.csv` and `results.json` | One row per video: rating, confirmed peak, sustained level, flags, refusals and cost. |
| `state/videos/<id>/` | Extracted frames, raw answers and the scored timeline. |
| `state/review/labels.json` | Your labels from the review page. |

**The review page** binds to localhost only. It shows each frame with its level, the rules that fired, refused questions and the heuristics that changed it. You can set the correct level, mark individual rules as wrong, and compare against the model in a calibration view.

## Cost

Pricing is $0.10 per million input tokens; output tokens aren't billed. One frame request with the full silk-v1 question set averaged about 5,500 tokens in the pilot, roughly $0.00055. That's about $0.033 per hour of video at one frame per minute, plus a little for transcripts.

- **With a BYOK key,** OpenRouter reports `usage.cost` as 0. The run therefore tracks cost from `usage.input_tokens` and stops at `maxRunCostUsd`.
- **I/O logging** is an OpenRouter account setting, not a request field. Requests carry `X-Title`, a per-video `session_id` and `trace` names, so they group on the dashboard.

## Layout

```
scales/silk-v1/          question sets and rules
src/cli.mjs              commands
src/classify.mjs         per-video pipeline and reports
src/decisions.mjs        Decisions client: cache, retries, cost ceiling, refusal handling
src/scale.mjs            rule evaluation, aggregation, heuristics runner
src/heuristics/          optional cross-frame modules
src/frames.mjs           frame sampling, scene detection, extraction
src/corpus.mjs           library scan, SRT parsing, transcript windows
src/review.mjs, review/  local review server and page
scripts/                 experiments (sampling comparison)
test/                    node:test suite
```

## Status

Experimental and paused mid-calibration. Open items:
- Fix the covered-nudity wording for clothing that's pulled aside.
- Decide whether `confirmed-peak` should apply to 5-minute transcript windows.
- Tune thresholds against labelled frames.
- Run a full-corpus pass.

No license has been chosen yet.
