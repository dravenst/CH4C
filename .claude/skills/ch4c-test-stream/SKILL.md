---
name: ch4c-test-stream
description: Run a test stream on the CH4C test machine and report what happened: tune its encoder to a URL (no Channels DVR recording), with optional CC and From Start settings, wait for setup to finish, summarize the log, and stop the stream. Use when the user asks to test a stream, a site or a change on the test machine. Test machine only, never prod.
---

# Run a test stream on the test machine

**Test machine only.** Never run this against prod or any machine other than the `test` row of the Machines table in `CLAUDE.local.md`. Tuning takes over an encoder and stops whatever it was showing. If `CLAUDE.local.md` or the test row is missing, ask for the test machine's CH4C address.

This uses the instant page's **Tune** action, which streams the URL to the encoder **without** creating a Channels DVR recording. Anything that needs to be seen, like a menu left open, the picture being fullscreen, or sound, still needs the user to check the screen or the encoder's channel. Say so in the report.

## Inputs

- **URL** (required): the service's watch/play URL. If the user names a show rather than a URL, ask for the URL, or have them use Show Search on the instant page.
- **CC**: `Default` (leave as is), `English` or `Off`. Default unless the user says otherwise.
- **From Start**: on or off. On unless the user says otherwise.
- **Duration**: auto-stop in minutes, as a backstop in case the stream isn't stopped below. Default 10.

## Steps

1. **Check the machine** (`<host>` = the test CH4C host):
   - `curl -s -m 10 <host>/health`. If it doesn't answer, CH4C is down; tell the user and stop.
   - Look at `activeStreams`. If something is already streaming, say what it is, and that tuning will take over an encoder. Continue unless it looks like something the user wouldn't want interrupted (anything with a long uptime); then ask.

2. **Start the stream** with the same form fields the instant page sends:
   ```sh
   curl -s -m 30 -X POST <host>/instant \
     -H 'Accept: application/json' \
     --data-urlencode "recording_url=<URL>" \
     --data-urlencode "recording_duration=<minutes>" \
     --data-urlencode "closed_captions=<'' | English | Off>" \
     --data-urlencode "from_beginning=<1 | 0>" \
     --data-urlencode "button_tune=Tune"
   ```
   The JSON response has `success`, `channel` and `encoderIndex`. Note the time. If `success` is false, report the error and stop.

3. **Wait for setup to finish.** Every 5 seconds, for up to 3 minutes, fetch `<host>/api/logs` (see the `ch4c-logs` skill for converting it to text) and look only at the lines after the last `Tuning encoder ... to <URL>` line:
   - **Done:** a line containing `fullscreen setup complete` or `finished fullscreen setup` (the wording varies by service).
   - **Failed:** `Stream setup failed`, or `Stream operation failed` on the final attempt.
   - Captions, fullscreen retries and dialog dismissal keep running in the background after that. Keep polling the log every 5 seconds for up to 30 more seconds, stopping early once a `fullscreen confirmed` line appears. If CC was set, also poll until a `CC:` line says `Selected`, `already set` or `Could not`, up to about 3 minutes. Do the waiting inside the polling loop (e.g. a small Python script); a bare `sleep` in the shell is blocked.

4. **Stop the stream:** `curl -s -m 30 -H 'Accept: application/json' <host>/stop/<encoderIndex>`. If the user asked to leave it running, skip this, and say when the duration will stop it.

5. **Summarize** the run from the log lines after the `Tuning encoder` line:
   - How long setup took, and how it ended (done, failed, or still running after 3 minutes).
   - The service-specific steps and their results: live/on-demand detection and the From Start choice, the seek and the time after it, CC selection, fullscreen (including any retries), unmute and volume, dialogs dismissed, audio device re-applied.
   - Any warnings or errors, quoted exactly.
   - What the user should check on screen, since the log can't show it.

Keep the raw log in the scratchpad, and quote only the lines that matter.
