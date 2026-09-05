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
