# Burrow & Co.

## Making critter pictures

Use `app/gemini.py`, which calls the Gemini API directly. The Gemini website fails from automated Chrome tabs ("Something went wrong (1155)").

- `python3 app/gemini.py <mood> [critter ...]`: no critters means all 16 hireable ones. Moods and their prompts are in the `MOODS` dict at the top; per-critter rules (Clover's three-legged pose, the red panda's empty paws) are in `EXTRA`.
- "relaxed" is the snack-break face: the critter puts its work prop away and holds a snack, so it is sized by height instead of by the width of its lower body.
- `python3 app/gemini.py fix <critter> <normal|mood> "<change>"` edits one existing picture (e.g. removing the kitten's pencil). `normal` edits the critter's main picture.
- Existing pictures are skipped; add `--redo` to replace them. More than 2 pictures stops with the count and cost until you add `--yes`.
- The key comes from `GEMINI_API_KEY` or `~/.config/agent-office/gemini-key`, and is only sent in the `x-goog-api-key` header. Never print, log or commit it.
- Raw results and the contact sheet (original | new, all 16 rows) go to `.gemini-raw/` (git-ignored). Check `.gemini-raw/sheet-<mood>.png` for new objects, extra legs, eye whites and floating props, then `--redo` the bad ones.
- Run it outside the sandbox: inside it, the network filter cuts off the roughly 2 MB reply (`IncompleteRead`), and that failed call may still be billed.
- The model is the `MODEL` constant (Nano Banana 2 Lite, about $0.034 a picture). Before changing it, list the models with GET `/v1beta/models` instead of guessing.

## Making critter pictures on the Gemini website (old way)

- The first click on "Upload & tools" after Gemini loads often doesn't open the menu. Click again and take a screenshot to confirm "Upload files" shows. Then use the Chrome file_upload tool on the first file input, with the real picture path in `assets/critters`.
- Wait about 4 seconds after uploading before typing the prompt, or Enter won't send.
- If a generated image shows as a blank grey box, or "Downloading full size…" never finishes, reload the chat and click download again. If it's still blank, start a fresh chat.
- The prompt must say "keep the eyes exactly like the original, solid dark round eyes with small white shine dots, no whites of the eyes."
- Count the legs on four-legged critters holding things; Gemini adds extra legs.
- Run `python3 app/mood.py <download> <critter> <mood>` on each download to cut away the background and match the size.
