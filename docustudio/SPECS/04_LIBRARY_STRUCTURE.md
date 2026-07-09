# SPEC 04 — Music / Ambience / SFX Library structure

One folder on your PC (e.g. `D:\DocuStudio\library\`). The tool's GUI
has a "Library folder" setting pointing at it and scans it on every run
— **adding music = dropping files into the right folder. Nothing else.**

Formats: `.wav` (best) or `.mp3` 320 kbps. Any filenames work; the
folder decides the meaning. The tool normalizes loudness itself, so
don't pre-mix levels.

```
library/
├── music/                  ← one folder per MOOD (matches script MOOD tags)
│   ├── neutral/            calm narration beds, low presence
│   ├── curious/            light pulse, question-mark energy
│   ├── tension/            investigative pulse, suspense build
│   ├── dark/               drones, heavy low end (crime/war)
│   ├── tragic/             sparse piano, strings, loss
│   ├── emotional/          warm, human, intimate
│   ├── hopeful/            rising, open, gentle optimism
│   ├── triumphant/         victory, resolution, big finish
│   ├── action/             drums, momentum (sports/war peaks)
│   ├── epic/               large orchestral/cinematic scale
│   ├── calm/               ambient beds (nature/farming/science)
│   ├── nostalgic/          old-time feel, memory scenes
│   └── mystery/            unresolved, eerie, lore/conspiracy
│
├── ambience/               ← background atmosphere loops (30 s+)
│   ├── room_tone/          neutral indoor silence-filler
│   ├── night_crickets/     rural night (crime scenes)
│   ├── wind/               open fields, battlefields, mountains
│   ├── rain/
│   ├── city/               traffic, distant sirens
│   ├── crowd_stadium/      sports roar, chants
│   ├── war_distant/        far artillery, radio crackle
│   ├── farm/               birds, tractor hum, cattle
│   ├── forest_birds/       nature/wildlife beds
│   ├── ocean/
│   ├── machinery/          factory hum, engines, workshop
│   └── space_hum/          low sci-fi bed (science/space)
│
└── sfx/                    ← short one-shot hits (0.2–4 s)
    ├── stings/
    │   ├── riser/          tension build before a reveal
    │   ├── sub_drop/       bass hit ON the reveal
    │   ├── boom/           impact hit (chapter cards, big dates)
    │   └── reveal/         soft "answer" chimes/hits
    ├── whoosh/             card/map/text entries and exits
    ├── ui/                 camera_shutter, typewriter, paper_rustle,
    │                       file_open, pin_drop, page_turn, stamp
    ├── heartbeat/          slow dread build (crime)
    ├── clock/              ticking — time pressure moments
    └── misc/               anything else; tool treats as generic
```

## Minimum counts (so output never repeats)

| Folder | Minimum | Comfortable |
|--------|---------|-------------|
| each `music/<mood>/` you actually use | 5 tracks | 10–15 |
| each `ambience/<type>/` | 2 loops | 4–6 |
| each `sfx/<type>/` | 3 sounds | 6–10 |

Priority moods to fill first (for history/war/crime/lore):
`tension, dark, tragic, neutral, mystery, epic, nostalgic` + ambience
`room_tone, wind, war_distant, night_crickets` + all four `stings/`.

## Rules
1. Only royalty-free / licensed audio. Keep a `licenses.txt` inside any
   folder if you want to track where files came from (tool ignores it).
2. Don't put songs with vocals in `music/` (they fight the VO). If a
   track has vocals, it will be QC-flagged.
3. Longer music tracks (2 min+) are better — the tool cuts and loops.
4. A genre pack maps to these folders automatically (e.g. crime scenes
   with MOOD tension pull from `music/tension/` + `ambience/night_crickets/`
   or `room_tone/`), so the SAME library serves every genre.
