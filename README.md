# Practice Mark

**Hands-free practice loops for YouTube lessons**

**Status:** Shipped as an unlisted Chrome extension beta · **Built by:** Glyph Analytics

Practice Mark addresses a small but persistent problem: people learning an instrument, movement, or skill from a video need to replay precise segments, but their hands are often occupied. The extension brings timestamp marks, repeatable loops, playback-speed control, and optional voice commands into the YouTube viewing experience.

This is a **shipped user-facing product**, not a custom speech-model research project. Voice commands use Chrome's built-in speech recognition.

## The user workflow

1. Open a YouTube lesson and show the Practice Mark panel.
2. Click **Listen** if you want hands-free commands. Microphone access is optional and explicit.
3. Say **"mark that"** at useful moments, or use the keyboard shortcut.
4. Sequential pairs of marks become loops: M1 + M2 forms Loop 1, M3 + M4 forms Loop 2, and so on.
5. Choose a loop and replay it, slow it down, or rename it to something recognizable, such as **Chorus**.
6. Practice without interrupting the lesson or repeatedly scrubbing the timeline.

### Common controls

| Goal | Voice command |
| --- | --- |
| Add a mark | `mark that` |
| Play a specific loop | `play loop one` |
| Play a named loop | `play chorus` |
| Restart the active loop | `again` or `repeat that` |
| Pause or resume | `pause` or `play` |
| Change speed | `slower` or `faster` |
| Exit loop playback | `stop looping` |

The interface also supports direct mouse controls. Voice is an optional convenience, not a prerequisite.

## Why this product is a useful case study

- **Workflow design:** Convert a broad user need, "help me practice from video," into a repeatable mark-to-loop interaction.
- **Human-computer interaction:** Use optional speech commands when hands are occupied, while retaining manual controls.
- **State and persistence:** Keep video-specific practice markers and loops available in the same Chrome profile.
- **Privacy-aware defaults:** Start microphone listening only after an explicit user action and avoid transmitting saved practice data to the publisher.
- **Iteration:** Treat speech reliability and friction during real practice as product constraints, not merely technical details.

## Technical architecture

| File | Responsibility |
| --- | --- |
| `manifest.json` | Chrome Manifest V3 configuration, site scope, permissions, and keyboard commands |
| `content.js` and `content.css` | Practice interface and interaction with the YouTube page |
| `background.js` | Extension background service worker |
| `voice-log.js` | Supporting voice diagnostics |
| `PRIVACY.md` | Data handling and speech-recognition disclosure |

**Browser scope:** The content script is limited to YouTube pages. Practice marks and loop settings are stored in Chrome extension storage.

**Speech processing:** Practice Mark does not record or store audio. Chrome's speech-recognition implementation may use Google/Chrome services; see the [privacy policy](./PRIVACY.md) for the precise boundaries.

## Availability and source checkout

The published distribution is an **unlisted beta**. A public Chrome Web Store URL has not been added to this repository; access to the unlisted listing requires its direct link.

**Source packaging note:** The current repository snapshot does **not** include the `icons/` assets referenced by `manifest.json`. Therefore, cloning the repository alone is not yet a complete unpacked-extension installation path. The packaged beta is the appropriate way to evaluate the released extension until those assets are restored. This is a known source-distribution gap, not a claim of full build reproducibility.

## Limitations and next steps

- Voice-recognition accuracy varies with browser support, ambient sound, and overlap with lesson audio. Headphones can help.
- YouTube's page/player behavior may change, so continued browser regression testing matters.
- Public repository screenshots, a concise video walkthrough, and a verified Web Store link are still to be added.
- No automated test coverage claim is made for this repository.

## Privacy and support

Practice marks and loops are saved locally in Chrome. Voice is opt-in and no audio is recorded by Practice Mark. Read [PRIVACY.md](./PRIVACY.md) for full details. For questions, contact [Glyph Analytics](https://glyphanalytics.com/).

This project demonstrates product ownership, interface design, user-centered iteration, and responsible browser integration. It does not claim to train or deploy a proprietary AI model.
