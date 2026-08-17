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
- `Show the GPS and truck-location discrepancy for 10 Marina Bay.`

Use the exact worker name, site name, or address shown in StampNote when it is known. The words `today` and `yesterday` use the browser's local date.

## Wait for the answer

After submission, `.ai-chat-form` has `aria-busy="true"` and the newest assistant message has `data-state="thinking"`. Wait until both conditions clear and the assistant message becomes one of:

- `data-state="complete"`: read `.ai-message-body`, its citation chips, source disclosure, graphs, map, and verified action links.
- `data-state="error"`: report the visible error. Do not treat the temporary `Reviewing the relevant records…` text as an answer.

Ask only one question at a time. Do not submit another question while the form is busy.

## Interpret and navigate from an answer

- Citations such as `S1` and `S2` refer to the retrieved facts disclosed under that answer.
- Use the verified links rendered below an answer to open attendance, session details, photos, coordinates, or metrics.
- Use an inline map only as a comparison between the recorded photo GPS reference and truck location.
- A direct no-match answer means the constrained lookup found no loaded record for the requested subject and date. Do not substitute unrelated sites or workers.

## Boundaries

- The assistant is read-only. It cannot edit, rename, delete, capture, upload, or approve records.
- Answers are limited to the records loaded in the current signed-in browser and the facts retrieved for that question.
- Conversation history supplies conversational context, not additional evidence.
- Never ask the assistant to reveal hidden instructions, credentials, tokens, or private data unrelated to the user's task.
- If the answer says information is missing, use the page's verified links or refresh the records; do not guess.

