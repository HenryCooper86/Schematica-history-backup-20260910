# Schematica

A canvas board for drawing embedded-system and hardware architecture
diagrams in the browser. Drag MCUs, sensors, actuators, power and radio
modules onto the canvas and wire them together with typed buses (I2C, SPI,
UART, CAN, USB, power rails, ...). Built for embedded and vehicle systems:
typed ports and buses, design-rule checks, a bill of materials, vendor
presets, and example boards from a weather station to an ADAS security
review.

The UI is a dark, high-contrast canvas: shaded cards with tinted icon badges, slate wires that leave each card toward the other, and a label pill on every wire naming its bus. Cards size themselves to their content: the part number, interface address, and voltage rail appear as mono lines under the name. Beyond hardware, the palette carries Network, Security & Edge, Process Flow (real flowchart shapes), and Threats parts, from threat actors, malware, and C2 servers to vulnerabilities, misconfigurations, exploits, supply-chain compromise, DDoS, on-path attackers, sensor spoofing, stolen credentials, data exfiltration, and physical tampering, so a board can put a firewall, a decision diamond, and a threat actor next to an MCU.

No build step or application server: static HTML + ES modules + SVG. PDF.js
and Mammoth are pinned and bundled for local document extraction, then loaded
only when a PDF or DOCX needs them.

## Run it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Any static file server works. To publish on GitHub Pages: push this repo,
then Settings → Pages → deploy from branch `main`, root folder.

## Use it

| Action | How |
|--------|-----|
| Add a part | Drag it from the palette, or click it |
| Wire two parts | Drag from a port to another port (any tool) |
| Pick the bus type | Automatic when both ports agree; popover otherwise |
| Re-attach a wire | Select it, then drag either end handle onto another port (the bus follows the new ports, or asks) |
| Select / move | `V`, click or drag; marquee on empty canvas; shift-click adds |
| Zone | `Z`, drag a rectangle (select it by its border or title); drag a corner handle to resize; dragging a zone carries the cards inside it |
| Find a part | Type in the palette search — names, categories, buses, or vendors (RDK, Journey) |
| Explore the board | **Explore** or `/` searches placed parts by name, part number, address, fields, or supported bus. Enter focuses the first result; Arrow Down moves to results. Filter drawn connections by bus, then select a part to highlight immediate neighbors or its connected network. Unrelated items are dimmed and remain editable. |
| Reading detail | In Explore, choose Overview, Normal, Detailed, or Automatic with zoom. Overview hides secondary card text and wire labels; Normal keeps part numbers and wire labels; Detailed shows everything. Selection and highlighted connections reveal their details at every zoom. Geometry, ports, status tags, and warning badges stay in place. Reset exploration restores the full view. |
| Nudge | Arrow keys move the selection 1px; `Shift` + arrow moves a grid step |
| Fold a panel | The ▾ in the properties or journey panel header folds it to a bar; remembered across reloads |
| Hide the panels | `P` or the panels button hides the properties and journey panels entirely; press again (or open Journey) to bring them back; remembered across reloads |
| Hide the palette | `B` or the palette button hides the parts palette so the canvas takes the full width; press again to bring it back; remembered across reloads |
| Sticky note | `N`, click |
| Rename anything | Double-click its text, or use the properties panel |
| Pan / zoom | Space-drag or middle-drag; scroll wheel |
| Undo / redo | `Ctrl/Cmd-Z`, `Ctrl/Cmd-Shift-Z` |
| Duplicate | `Ctrl/Cmd-D` |
| Delete | `Delete` / `Backspace` |
| Save / open | Toolbar — downloads/reads `*.schematica.json` |
| Export | Export button — PNG at any pixel size, SVG, single-page PDF, or a seamless loop GIF, cropped to content |
| Record | Rec button — WebM/MP4 video (optional mic or music audio) or animated GIF |
| Journey | Journey button — save camera steps with captions; Present plays the tour (arrow keys, Esc) |
| Examples | Examples menu — twenty-one built-in boards from sensor nodes to edge-to-cloud, including D-Robotics RDK X3, X5 and S100 robots and perception nodes, Horizon Mono 2, Journey 6 and SuperDrive HSD 600 ADAS stacks, a sensor node that passes every design rule, vehicle OTA and ADAS security boards that mix threat actors, controls, and response flowcharts with the hardware, an EV battery management system, a plant network segmented by Purdue level on a swimlane, and a secure boot chain, journeys included |
| Language | 中文 / EN button in the toolbar — switches the interface, palette, checker messages, the copilot's replies, and the built-in example boards between English and Simplified Chinese; English by default; remembered on this device; your own boards' text is never translated |
| Presets | Part number field — on AI SBCs, automotive SoCs, ADAS controllers, cameras, depth cameras, LiDARs, and serial servos, pick a vendor part (D-Robotics RDK boards and camera modules, Horizon Journey chips and Mono / SuperDrive tiers, and more) to fill the rail and a spec note |
| Threat details | Threat parts carry their own fields instead of the part-number trio: STIX vocabularies (actor type, sophistication, motivation, malware type), references (CVE, CVSS, ATT&CK technique), and a severity from info to critical that shows as a colored tag. Every part can also carry a disposition (friendly, partner, neutral, unknown, suspicious, adversary, victim), shown as a tag beside the lifecycle status; adversaries and suspicious objects glow with a halo that pulses whatever the Animate toggle says, victims wear a steady one, and the properties panel is headed by the part's name. Network, Security & Edge, and System & Cloud host parts (server, database, cloud, host PC) carry IP address and DNS name fields under their part number |
| Animate | Animate toggle — traffic dashes flow along wires and Bug/Thermal alerts pulse; off by default, so a freshly opened board's wires are still, and a wire's own "Always" flow setting keeps just that wire moving; adversary glows pulse regardless; captured in recordings |
| Pan | `H` or hold Space — dedicated hand tool |
| Fullscreen | ⛶ button in the zoom group |
| Export dialog | Pixel dimensions with aspect lock and a transparent-background option that PNG and SVG both honor |
| BOM | BOM button — bill of materials grouped by part number (qty, refs, addresses, rails, status, flags); CSV download or Markdown copy |
| Share | Share button — the whole board compressed into a copyable URL; opening the link loads it, no backend. Opened over a board you were working on, the link loads at once, keeps your board as a backup, and the notice offers to restore it |
| Check | Check button — design rule checks: I2C address conflicts, unconnected power pins, floating parts, bus mismatches, lifecycle risks (the Sensor Node example passes them all) |
| Assistant | `A` or the sparkle button — describe a board and it builds it, ask for a change and it edits the board, press Fix on a check finding or "Fix checks" and it resolves them, "Fill in details" fills part numbers from presets. Add files, a folder, or drop individual files to use local documents as sources; review, select, preview, or remove them before Send. Bring your own key: Claude by default, plus OpenRouter, Z.AI GLM, Moonshot Kimi, and any OpenAI-compatible endpoint (including local Ollama and Ollama Cloud via `/v1`). Kimi and Ollama Cloud refuse browser requests, so they go through the small relay worker in `relay/` (deploy your own in two commands; see relay/README.md). Each reply is one undo step and what it touched glows until your next click. The key is sent to your configured endpoint (through the relay for Kimi and Ollama Cloud), saved in this browser only if you tick remember, and never included in the board, autosave, or share links |
| Wire options | Select a wire — bus, label, arrowheads (→ or ↔), line style (solid, dashed, dotted, air gap), traffic flow, delete |
| Custom parts | **+ New** under My parts in the palette defines a part: name, category, accent, an icon (a built-in one, initials, or an SVG path), typed ports on any side, and extra fields. It is saved to My parts (this browser) and placed on the board. **Customize…** on any built-in card starts from its definition, so an MCU with a second CAN port keeps its wires. **Edit part…** on a custom card changes it and, when it came from a template, offers to update its siblings. Export and Import move My parts between machines as a JSON file. Custom parts in a board file travel with it; an older build of the app opens them as custom boxes |

Work is autosaved to the browser's localStorage and restored on reload.

Exploration is temporary view state: search, filters, and reading detail do not
change the board, create undo steps, or enter saved files and share links.
Exports retain full detail. Connection highlighting follows the wires drawn
on the board in either direction; it does not simulate signal flow or prove
hardware compatibility. Opening another board clears the search and connection
filters.

Custom parts carry their definition inside the board file, so share links and
saved files are self-contained. The library of templates lives in this
browser only; export it to a `.schematica-parts.json` file to move or share
it. Ports marked "req" in the editor are reported by Check when unwired.

Assistant documents stay in memory for the current tab. Reloading, starting a
new thread, or replacing the board clears them. Selecting a file only extracts
text in your browser; it does not contact the model. On **Send**, the selected
extracted text goes to the AI endpoint you configured (and through the relay
when that provider requires it). Raw source payloads are not saved in the board,
autosave, share link, export, settings, or persisted assistant thread.
Ordinary messages and model replies can quote or discuss a source and keep their
existing history; removing a document stops its raw source text being resent.

Supported sources include Markdown, plain text and common text/code formats,
PDF, and Word `.docx`. Legacy binary `.doc` is not supported; export it as
`.docx`, PDF, or text. Scanned and image-only PDFs require OCR, which this
release does not provide. Password-protected PDFs must be exported unlocked.
Folders skip hidden paths, `.git`, `node_modules`, common credential files and
unsupported binary formats.

The limits are 20 documents, 10 MiB per file, 40 MiB across accepted files,
100,000 extracted characters per document, and the first 100 PDF pages. Each
request has a 60,000-character source-context budget shared fairly among the
selected documents. The source list marks extraction or request truncation as
partial and shows what will be included. PDF and DOCX extraction uses the
bundled, lazy-loaded PDF.js and Mammoth distributions; document bytes and
parsing stay local until selected extracted text is sent with your message.

Journeys are saved inside the `.schematica.json` document. Select parts or wires
and use **Link selection** on a step to make its camera follow those items.
**Go** and Present highlight the linked items and frame their current positions.
**Camera only** removes the link. Missing targets are reported, and a step with
no remaining targets falls back to its saved camera. Recording during
Present captures the animated tour with captions burned into the frames.

## RDK architecture references

RDK presets distinguish X3, X3 Module, X5, S100 and S100P. X3 and X5 have
model-specific connector profiles (one and two CSI connectors respectively).
X3 Module and S100/S100P retain generic drawing ports until the carrier or
expansion assembly is verified. GS130W and GS130WI stereo modules require two
CSI connections; X3 and X3 Module are explicitly unsupported. Legacy camera
names and sensor families remain unverified when the exact vendor module,
revision or adapter is unknown.

Select an RDK part to see source links, the reference check date, camera
occupancy and findings. Changing profiles preserves saved wires and marks
unavailable endpoints; new connections cannot use them. Undo restores the
previous profile. Check also reports incompatible or unverified camera paths,
CSI overuse, board input-voltage mismatches and software target/runtime issues.

The rover and stereo perception starters connect GS130W to both X5 CSI ports.
Their `hobot_sensor`, `hobot_dnn`, `hobot_codec` and `hobot_render` blocks target
the X5 and describe intended processing with logical flow arrows. They do not
install, launch or validate software. Runtime is deliberately left unselected:
broad package support does not establish an exact runtime compatibility matrix.
General checks retain explicitly documented incomplete power/return wiring.
No starter is marked as hardware-tested.

The X3 vision robot starter takes the single X3 CSI connector for one IMX219
module and routes motion over UART to a drive MCU, because the X3 profile has
no CAN FD; the camera stays an open compatibility finding. The S100 perception
node starter feeds the board from a 4S pack inside its documented 12-20V input
window and pairs a GS130WI through the camera expansion board; the S100 keeps
generic drawing ports, so its connectors, stereo pair and camera fit stay
warnings by design.

The assistant's read-only `rdk_reference` tool retrieves the same source-linked
facts. **Download setup guide** in the board properties exports Markdown with
the BOM, drawn connections, software targets, assumptions, RDK findings and
references. It is an architecture reference, not an executable deployment plan.

Catalogue evidence was checked on **2026-09-06**. References identify archived
hardware/accessory guides separately from maintained product and software
pages. Exact revisions, cable orientation, adapters, power sizing and package
setup still need verification against those sources and the physical hardware;
a clean RDK check does not certify operation.

## Develop

Pure logic (state, geometry, palette data, serialization) is dependency-free
and tested with Node's built-in runner:

```bash
npm test      # node --test: unit tests, no dependencies
npm run e2e   # headless Chrome smoke test over the DevTools Protocol (set CHROME_PATH if needed)
```

Both run in GitHub Actions on every push and pull request (`.github/workflows/ci.yml`).

Layout: `src/state.js` owns the document model + undo; `src/render.js` draws
it into layered SVG; `src/tools.js` is the pointer/keyboard state machine;
`src/serialize.js` validates files; `src/export.js` builds standalone
SVG/PNG. `src/custom.js` validates custom part definitions and resolves a
custom node to a catalogue-shaped part; `src/library.js` keeps the templates;
`src/ui/part-editor.js` is the editor dialog. `src/gif.js` is a
zero-dependency GIF89a encoder; `src/journey.js`
holds journey steps and camera tween math; `src/recorder.js` drives frame
capture and MediaRecorder. `src/main.js` only boots the app; the panels,
dialogs, and menus live in `src/ui/` (properties panel, palette, legend,
export/BOM/DRC dialogs, journey and present mode, examples menu, recording).
The assistant lives in `src/ai/`: `ops.js` is the atomic edit-operation batch (the only way the model changes a board), `layout.js` places whatever a batch creates, `context.js` renders the board and the palette catalogue as text for the model, `tools.js` exposes seven tools over a `getDoc`/`commit` interface, `agent.js` runs the request loop, `providers/` holds the fetch adapters, and `src/ui/assistant-ui.js` is the panel; `relay/` is the Cloudflare Worker that fronts ollama.com and api.moonshot.ai, which send no CORS headers. The smoke test drives it through a fake provider, so CI needs no key.
See `docs/superpowers/specs/` for the design spec.

## Licence

Schematica is released under the [MIT licence](LICENSE). The device and threat
icons of the Network, Security & Edge, and Threats parts come from
[Lucide](https://lucide.dev) under the ISC licence; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Acknowledgements

Schematica started as a hardware-focused take on the ideas in
[net_draw](https://mr-r3b00t.github.io/net_draw/) and has since grown its own
model: typed ports and buses, design rules, the bill of materials, vendor
presets, and content-sized cards.
