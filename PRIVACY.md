# Practice Mark Privacy Policy

_Last updated: September 15, 2026_

Practice Mark for YouTube is built by Glyph Analytics to provide timestamp marking, practice loops, playback-speed control, and optional voice control while using YouTube.

## Data Practice Mark stores locally

Practice Mark uses Chrome local storage to save information needed for the product to work, including:

- YouTube video IDs associated with your saved practice data.
- Marks, loop boundaries, loop names, selected loop, and per-loop playback speed.
- A small local engagement counter used only to ensure the optional Chrome Web Store review request is shown at most once after meaningful use.

This information stays in your Chrome profile unless you remove the extension or clear its extension data. Practice Mark does not send this stored practice data to Glyph Analytics servers.

## Voice control

Voice control is off until you click **Listen**. Practice Mark invokes Chrome’s built-in `SpeechRecognition` service and receives text recognition results from Chrome. Depending on Chrome and your system configuration, Chrome may process speech using Google/Chrome speech-recognition services under Google’s applicable terms and privacy policies.

Practice Mark itself does not record audio, does not store audio, and does not transmit audio to Glyph Analytics.

While voice control is active, Practice Mark keeps recognition text and diagnostic timing events in temporary page memory so the extension can operate and troubleshoot recognition behavior. These diagnostics are not automatically uploaded anywhere. They leave your browser only if you explicitly choose **Diagnostics → Export voice diagnostics** and then choose to share that exported file.

## Sharing and sale of data

Glyph Analytics does not sell Practice Mark user data and does not use Practice Mark data for personalized advertising. Practice Mark does not automatically share saved marks, loops, or diagnostics with Glyph Analytics or other third parties.

## Permissions

Practice Mark requests only the permissions needed for its single purpose:

- **Storage** — save marks, loops, settings, and the one-time review-prompt state locally.
- **YouTube site access** — the packaged content script runs only on `youtube.com` so it can display the Practice Mark panel and control the video you are practicing with.

## Contact

For privacy questions, contact Glyph Analytics through https://glyphanalytics.com/.
