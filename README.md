# ReleaseTCG Card Generator — Photopea Demo v2

## CSV columns

Name, Power, Bulk, Color1, Color2, Color3, Color4, Trait, Effect1, Effect2, Clarify1, Clarify2, Clarify3, CardNumber, SetName, Artist, Art, Flavor, Inspiration

Flavor and Inspiration are currently read but not placed into the PSD because the current template does not have corresponding layers.

## Art

Select an artwork folder once. The `Art` CSV column only needs the filename, for example:

Art
sandy-dues.png

The browser indexes the selected folder by filename.

## Run

Python 3:

    python server.py

Then visit:

    http://127.0.0.1:8765

Select:
1. CSV
2. SandyDues.psd
3. artwork folder

Wait for the Photopea status to say Ready, then Load cards.

## Important fixes in v3

- Individual Generate buttons are disabled until Photopea is actually ready, so clicks cannot silently fail while Photopea is loading.
- Individual generation errors are caught and shown on the card instead of becoming unhandled browser promise errors.
- Batch generation shows a progress bar and per-card success/failure.
- Photopea commands are serialized so opening, scripting, and exporting one card cannot race the next card.
- Export uses the documented `saveToOE("psd")` and `saveToOE("png")` forms.
- Binary export messages are detected by `byteLength` rather than relying on `instanceof ArrayBuffer` across iframe realms.
- CSV is the only spreadsheet format.

## Photopea API

Photopea Live Messaging accepts strings as scripts and ArrayBuffers as binary files, and sends `done` after processing. `saveToOE("psd")` and `saveToOE("png")` return binary data to the embedding page.

Official docs:
https://www.photopea.com/api/live


## v3 note

The template and artwork documents are explicitly tagged using `Document.source` after each file is opened. This is important because artwork can have the same canvas dimensions as the 750x1050 card template. The generator no longer tries to identify the two documents by width/height.

Photopea script errors are now returned to the app using `app.echoToOE()` and shown on the affected card instead of silently leaving the template unchanged.

An Inspect template button is included for debugging. It prints the current Photopea layer tree to the browser console.
