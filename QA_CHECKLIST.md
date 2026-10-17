# Practice Mark | Manual release smoke test

This is a **manual checklist**, not a record of a completed browser QA run. Run before claiming a particular revision is verified.

## Install and core workflow

- [ ] Run `node scripts/verify-package.mjs` with Node 18 or newer.
- [ ] Open `chrome://extensions`, enable Developer mode, and load the repository root unpacked.
- [ ] Confirm toolbar icon appears and opens/closes the Practice Mark panel on a YouTube video.
- [ ] On a non-YouTube page, the extension does not display its content script.
- [ ] Create marks M1 and M2 and confirm a loop is available.
- [ ] Play that loop and confirm playback returns to the starting mark.
- [ ] Confirm the capture area has Mark and Again but no top Loop button.
- [ ] Click a completed loop card's background or title; confirm selection, seeking to its start, and playback.
- [ ] Confirm the same action works with Enter or Space when the loop card is focused.
- [ ] Confirm clicking the loop name, mark dropdowns, delete, Again, and speed buttons does not inadvertently trigger the card click.
- [ ] Click an incomplete loop card; confirm it shows a warning instead of starting playback.
- [ ] Rename a loop, modify its boundaries, and change speed.
- [ ] Reload the same video and confirm marks and loops persist; open another video and confirm distinct state.

## Optional voice

- [ ] Confirm voice is off by default.
- [ ] Click Listen, grant microphone access, and try `mark that`, `play loop one`, `again`, `slower`, `pause`, and `play`.
- [ ] Deny microphone access and confirm manual controls remain usable.
- [ ] Confirm ending voice listening removes the active listening state.

## Release review

- [ ] Capture a real screenshot of the extension on a YouTube lesson, avoiding personal data and third-party private content.
- [ ] Confirm no errors in the extension service worker and page console.
- [ ] Verify current privacy disclosures against the implementation.
- [ ] Verify the Chrome Web Store listing, version, and direct URL before publishing that link.

## Known limits

Chrome speech recognition varies by environment, microphone, browser availability, and interfering lesson audio. This checklist does not establish that a packaged Web Store release behaves identically to the unpacked development build.
