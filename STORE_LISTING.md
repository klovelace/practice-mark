# Chrome Web Store submission draft

## Product name
Practice Mark for YouTube

## Summary
Mark moments, build practice loops, slow them down, and control YouTube hands-free with voice.

## Single purpose
Turn YouTube practice and lesson videos into an interactive practice workspace with timestamp marks, reusable A/B loops, playback-speed control, and optional voice commands.

## Detailed description
Practice Mark helps musicians, athletes, students, and anyone learning from YouTube practice the exact sections that matter without constantly reaching for the mouse.

Watch a lesson normally and say “mark that” whenever something is worth practicing. Pairs of marks automatically become loops. Replay a loop, change its start and end points, rename it, slow it down, or control it by voice while your hands stay on your instrument or task.

Main features:
- Capture timestamp marks without interrupting playback.
- Automatically turn sequential marks into reusable practice loops.
- Rename loops and address them by name with voice commands.
- Adjust loop playback speed with controls or voice.
- Pause, resume, repeat, and switch loops hands-free.
- Save practice marks and loops locally for each YouTube video.
- Export optional voice diagnostics when troubleshooting; no audio is recorded by Practice Mark.

Voice recognition works best when your voice is clearer than the video audio. Headphones can improve results during voice-heavy lessons.

## Permission justification

### storage
Required to save marks, loops, loop names, playback rates, settings, and the one-time review-prompt state locally in Chrome.

### Site access: YouTube only
The packaged content script is limited to `https://www.youtube.com/*` because Practice Mark must display its practice panel and control the YouTube video element. It does not run on unrelated websites.

## Privacy practices notes
- Saved marks/loops remain in Chrome local storage and are not automatically transmitted to Glyph Analytics.
- Voice is opt-in each session by clicking Listen.
- Practice Mark does not record or store audio.
- Voice uses Chrome's built-in SpeechRecognition service; Chrome/Google may process speech according to their applicable policies.
- Recognition transcripts/diagnostic events are temporary page-memory data and are exported only when the user explicitly clicks Export voice diagnostics.

## Listing assets still needed
- At least one real 1280×800 or 640×400 screenshot showing Practice Mark on YouTube.
- Optional additional screenshots showing loop creation, named loops, and voice controls.
- Verify support URL and privacy-policy URL before publishing.
- After the Web Store assigns the permanent extension ID, verify the in-app “Rate us on Chrome” link.
