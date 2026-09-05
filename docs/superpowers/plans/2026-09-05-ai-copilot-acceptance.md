# AI Copilot manual acceptance (needs a real key)

Run once against Claude Opus 5 before calling the feature done. Tick each
line with the observed result.

1. Blank board, prompt: "Build a solar weather station on an ESP32-S3 with a
   BME280 and a LoRa uplink." Expect: parts, typed wires, at least one zone,
   no overlapping cards, Check reports zero errors, done within eight rounds.
   Observed: __
2. On the Sensor Node example: "Swap the ESP32 for an STM32H7." Expect: one
   node's part number and notes change, nothing else; one undo step reverts.
   Observed: __
3. On the Weather Station example (which has findings): press Check, press
   Fix on the first finding. Expect: the panel opens, the finding is sent, the
   assistant resolves it without touching unrelated items. Observed: __
4. On the RDK X5 Rover example after blanking two part numbers: "Fill in
   details." Expect: blank part numbers filled from presets, nothing else
   changed. Observed: __
5. Open the Journey panel and the properties panel while the assistant is
   open. Expect: no overlap that hides controls at 1400 px width. Observed: __
6. Press Stop mid-request. Expect: the reply says it was stopped, edits so far
   remain as one undo step. Observed: __
7. Reload. Expect: the thread comes back; loading an example clears it.
   Observed: __
8. With "remember" unticked, reload. Expect: the key must be entered again and
   `localStorage` holds no `schematica.ai.key.*`. Observed: __
9. Settings → Ollama with a local model, Test. Expect: either "calls tools" or
   the single-shot notice; a build works in the mode reported. Observed: __
10. Ask for something the model declines (a request outside what it will help
    with). Expect: no silent empty reply — an error bubble in the thread
    carrying the model's own explanation. Observed: __
11. Settings → model `claude-haiku-4-5`, save, send a build. Expect: the
    request runs (no 400 from the API) and the reply arrives without thinking.
    Observed: __
12. Open the app with site data blocked. Expect: it boots and every
    non-assistant feature works; a key entered in the panel is kept for the
    session only and the thread does not persist across reload. Observed: __
13. Ollama: watch the server log while a build runs. Expect: no `truncating
    input prompt` line — the request asks for num_ctx 16384. Observed: __
