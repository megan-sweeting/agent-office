# Burrow & Co.

## Making critter pictures in Gemini

- The first click on "Upload & tools" after Gemini loads often doesn't open the menu. Click again and take a screenshot to confirm "Upload files" shows. Then use the Chrome file_upload tool on the first file input, with the real picture path in `assets/critters`.
- Wait about 4 seconds after uploading before typing the prompt, or Enter won't send.
- If a generated image shows as a blank grey box, or "Downloading full size…" never finishes, reload the chat and click download again. If it's still blank, start a fresh chat.
- The prompt must say "keep the eyes exactly like the original, solid dark round eyes with small white shine dots, no whites of the eyes."
- Count the legs on four-legged critters holding things; Gemini adds extra legs.
- Run `python3 app/mood.py <download> <critter> <mood>` on each download to cut away the background and match the size.
