# Known limitations — M5.2-TX (Transitions + Animations)

Ye release Codex ki M5.1.1 base ke UPAR ek naya, **poori tarah alag layer**
jodti hai — transitions + animations — bina purane editor/render ko chhue.

**Ab SACH mein chalta hai (real ffmpeg + pixel se proven):**
- **8 style packs** (None, Auto, Cinematic, Energetic, Soft, Clean cuts, Motion
  only, Transitions only) + 8 animations + 7 transitions ke building blocks.
- **Do jagah se chuno**: New Video page (video se pehle) ya Editor -> "Transitions"
  (clips + lock ke baad). Explicit **"None"** = koi transition/motion nahi.
- **DURATION INVARIANT**: style ON ho ya OFF, video ki lambai bilkul same,
  voiceover kabhi chhoti nahi. Har effect duration-exact. (style-parity S-3)
- **Asli pixel proof**: dip_black par frame KAALA, flash/white par SAFED, blur
  par abhi bhi HARA (media zinda). (style-parity S-4, S-5)
- **Non-repetitive + reproducible**: seeded rotation se adjacent shots alag; same
  seed = same result; "Shuffle" naya combo. (style-parity S-7, S-8)
- **Fail-safe**: kisi shot par filter fail ho to us shot ka original use hota hai,
  manifest me sach likha jata hai. None par render byte-for-byte purana.
- **render_sig me style shaamil**: style badlo to sirf timeline/render dobara
  bane — downloads/cuts/QA cache safe.
- Guide: `TRANSITIONS_AND_ANIMATIONS_GUIDE.md`.

**Abhi bhi seemayein (aage):**
- **True cross-dissolve (A-over-B overlap)** abhi nahi — wo narration ko drift
  karta (handles chahiye). Isliye dip/blur/flash + motion se variety (drift-free,
  modern doc/AI-video ka standard clean look). Overlap-crossfade baad me.
- **Live styled preview editor ke andar** abhi nahi — style FINAL export me lagti
  hai; dekhne ke liye export ke baad `final.mp4` player me chalao.
- **Per-boundary manual transition override** abhi nahi — abhi pack-level (poori
  video par ek varied scheme). Per-shot control aage.
- Transitions production final par lagti hain; draft (diagnostic) saaf rehta hai.

---

# Known limitations — M5.0-B.2

## Production foundation that is complete

- In-UI fresh project input flow
- Single-instance/busy-port-safe launcher
- Pack/audio/SRT preflight and honest build status
- Automatic draft, missing-range plan and human media fill
- Voiceover-synced preview, play/pause/scrub and shot selection
- Persistent per-shot trim/crop/scale/fit edits
- EDL edits applied to final FFmpeg output
- Critical/HARD EVIDENCE human approval
- Fresh start with recoverable project archive

## Not yet a CapCut/Filmora replacement

- No freeform split, ripple trim, magnetic timeline or arbitrary shot reorder
- No multi-select/group editing or full undo/redo UI
- No keyframe animation editor
- Style templates, transitions, effects and music automation are not active yet
- Queue and Library screens are placeholders, not production multi-project tools

## Input and research limits

- Auto-SRT estimates timing from script and audio; it does not transcribe speech.
- Exact-clip accuracy cannot exceed the evidence in the research pack and the
  footage actually available online.
- Dead/private/blocked sources and unavailable episodes must be filled through
  Missing Media. This is intentional human-in-the-loop behavior, not hidden by
  generic cards.
- Cross-niche engine logic supports series, anime, film and documentary scopes,
  but every new niche still needs one real acceptance pilot before claiming the
  same sourcing accuracy.

## Scale limits

- One active project at a time in the UI.
- Large file uploads currently pass through the local Node process; very large
  source uploads would benefit from a streaming worker in a future release.
- YouTube downloads remain subject to YouTube availability, throttling and
  yt-dlp compatibility.

These limits are product milestones, not reasons to return to the removed
old-folder/update workflow.
