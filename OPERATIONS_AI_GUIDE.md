# StampNote Operations AI page guide

This guide explains how a person or browser-based AI agent should use the StampNote Operations AI page.

## Open and prepare the page

1. Open [Operations AI](ai-dashboard.html).
2. Sign in with the authorized Google account if the private-workspace gate is shown.
3. Wait until `#ai-workspace` is visible, `#ai-prompt` is enabled, and `#ai-scope-label` says the records are ready.
4. Use the refresh button `#ai-refresh` before a question when newly captured records must be included.

The page loads private operational records into the signed-in browser. Do not copy record details outside the user's requested destination.

## Ask a question

Enter one question in `#ai-prompt`, then submit `#ai-send` or the containing form `.ai-chat-form`.

Good questions identify the subject and time range clearly:

- `Were there any attendance check-ins at Airport today?`
- `When did Jane Tan check in?`
- `Show the flagged sessions and explain each flag.`
- `Graph attendance for the last 30 days.`
- `Compare the intended site, staff GPS, and truck location for 10 Marina Bay.`

Use the exact worker name, site name, or address shown in StampNote when it is known. The words `today` and `yesterday` use the browser's local date. A short confirmation such as `yes that one` keeps the previous subject; do not treat it as a new lookup.

## Wait for the answer

After submission, `.ai-chat-form` has `aria-busy="true"` and the newest assistant message has `data-state="thinking"`. Wait until both conditions clear and the assistant message becomes one of:

- `data-state="complete"`: read `.ai-message-body`, its citation chips, source disclosure, graphs, map, and verified action links. The chat smoothly auto-scrolls down to reveal the arrival of the response, and an auditory chime signals completion. A floating jump-to-bottom button (`#ai-scroll-bottom`) allows instant return to the latest message whenever history is browsed.
- `data-state="error"`: report the visible error. Do not treat the temporary `Reviewing the relevant records…` text as an answer.

Use the answer's `Listen` button to generate a spoken version with Gemini 3.1 Flash TTS. Playback begins as Gemini streams the first audio chunks instead of waiting for the entire answer, and the button changes to `Stop`. The voice request requires the same signed-in administrator and sends only the answer text; citation codes are removed before speech generation.

Ask only one question at a time. Do not submit another question while the form is busy.

## Interpret and navigate from an answer

- Citations such as `S1` and `S2` refer to the retrieved facts disclosed under that answer.
- `G1` refers to public geography verified separately with Google Maps. It can identify an intended public site and assess whether an anonymous staff/session GPS or truck coordinate matches that place. Its visible Maps links appear immediately below the answer; it cannot establish who was present, when a session occurred, or any other operational claim without an `S` fact.
- Use the verified links rendered below an answer to open attendance, session details, photos, coordinates, or metrics.
- Manual attendance is indexed as a review flag. Operations AI can identify the worker, check-in time, session, and the fact that the entry was added manually and needs review; use the verified attendance link to inspect it in Photos & attendance.
- For a location-discrepancy question, expect three separate checks when evidence is available: intended site versus staff/session GPS, intended site versus truck, and staff/session GPS versus truck. Attendance alone does not supply staff GPS; the staff/session position comes from the best recorded session-start or photo GPS reading.
- Use the inline map as the local comparison between the recorded photo/session GPS reference and truck location. The intended-site checks are described in the answer and grounded by the visible Google Maps evidence.
- A weather answer draws the recorded sky as `figure.ai-weather-scene`, whose `data-scene` is the recorded condition (`storm`, `rain`, `drizzle`, `snow`, `fog`, `overcast`, `partly`, `clear`). It is a drawing of one session's stored reading, not a forecast; the figures beside it are the measured ones. A session with no reading draws nothing.
- A direct no-match answer means the constrained lookup found no loaded record for the requested subject and date. Do not substitute unrelated sites or workers.

## Boundaries

- The assistant is read-only. It cannot edit, rename, delete, capture, upload, or approve records.
- Answers are limited to the records loaded in the current signed-in browser and the facts retrieved for that question.
- When public geography must be resolved, only address-like site labels selected from the retrieved session facts are sent to Google Maps. For an explicitly requested intended-site discrepancy check, the associated anonymous staff/session GPS and truck coordinates are also sent. Worker names, attendance details, photo contents or IDs, dates, weather, and the user's full question are not included in that Maps lookup.
- Conversation history supplies conversational context, not additional evidence.
- Never ask the assistant to reveal hidden instructions, credentials, tokens, or private data unrelated to the user's task.
- If the answer says information is missing, use the page's verified links or refresh the records; do not guess.

