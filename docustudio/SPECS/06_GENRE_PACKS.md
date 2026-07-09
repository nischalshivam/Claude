# SPEC 06 — Genre grammar packs

One engine, per-genre JSON packs. A pack sets RANGES (not fixed values)
on ~12 editing dimensions; the planner samples inside the ranges per
video so no two outputs look templated. New genre = new JSON, no code.

## The 12 dimensions every pack defines

1. shot dwell range (median seconds, hold length)
2. canvas (full-bleed / paper-texture frames / light editorial cutouts)
3. caption + typography style (font, case, position, accent color)
4. credibility props (which cards this genre leans on)
5. photo/archival treatment (grain, B&W, sepia, vignette, censor)
6. transitions allowed (and their max frequency)
7. color grade
8. music mood mapping (script MOOD → library folders)
9. ambience defaults
10. SFX vocabulary (which stings/ui sounds fit)
11. graphics set (maps, timelines, evidence board, stat panels…)
12. curiosity devices allowed (silhouette, blur-reveal, black-screen text)

## The 9 target genres (owner's list) — starting values

| Genre | Dwell | Canvas | Signature elements |
|-------|-------|--------|--------------------|
| **history** | 6–10 s | paper texture + framed footage | date cards, old maps w/ routes, sepia archival, serif lower-thirds, page-turn/film-burn (sparingly) |
| **war** | 5–9 s | full-bleed dark | troop-movement maps, operation timelines, archival flicker, distant-artillery ambience, hard cuts |
| **machinery** | 3–6 s | blueprint/grid canvas | technical callout arrows, spec panels, macro shots, workshop ambience, precise clean wipes |
| **farming** | 7–12 s | full-bleed natural | wide holds, seasonal timeline, yield stat cards, natural dissolves, farm ambience |
| **sports** | 3–6 s | light editorial + cutouts | kinetic word-sync text, stat/record panels, silhouette reveals, crowd swells, speed ramps |
| **science** | 5–8 s | clean dark or light | diagram callouts, number panels, subtle glow accents, space_hum beds |
| **nature/wildlife** | 8–14 s | full-bleed | longest holds, minimal text, species/location labels, ambience-first sound (music secondary) |
| **crime** | 5–9 s (long holds) | full-bleed dark | evidence board, missing-poster/document zooms, censor blur, night_crickets + drone, camera-flash cuts |
| **lore (1–2 hr)** | 7–12 s | full-bleed dark | chapter cards every 8–15 min, mystery moods, slow reveals, retention via structure not cut-speed |

## Substyles

Packs support inheritance: `crime_youtube.json` extends `crime.json`
overriding captions + pacing. Planned substyles live inside each pack
folder. Build order (phase 1): **history, war, crime** — lore reuses
history/crime DNA with chapter logic; sports/machinery next.
