# Task 3 report

Status: DONE.

## Implementation

- Added `tests/e2e/documents.mjs`, exporting the documented `runDocumentChecks(harness)` injection interface. The existing zero-dependency CDP smoke harness invokes it in both the normal suite and `DOCUMENT_E2E_ONLY=1` focused mode.
- Browser acceptance assigns absolute synthetic paths to the actual file and directory inputs with `DOM.setFileInputFiles`, awaiting Chrome's asynchronous native change event before observing imports. Successful PDF and DOCX cases use the bundled PDF.js and Mammoth workers without parser replacement. Coverage includes Unicode MD/TXT, real PDF/DOCX markers, corrupt and unsupported isolation/reasons, 100,000-character extraction and 60,000-character request partials, 20 nested folder paths with duplicate basenames, selection, removal, hostile plaintext preview and Escape.
- The fake provider now retains the actual request body for assertions. Selected source sentinels are present in both the initial and tool-result round; removed/deselected sentinels are absent. Board JSON export, autosave/settings/thread storage, and the next request after reload exclude raw sentinels. Import alone causes zero requests.
- Lifecycle coverage exercises real-parser cancellation, New thread invalidation of stale work, individual drop, in-page example/store board replacement, reload, blocked localStorage, and unlocked composer recovery. The 20-file desktop and 430x820 narrow checks retain a bounded source scroller and use `elementFromPoint` to prove the composer remains reachable.
- Extended deterministic fixtures with `large.txt`, `unsupported.bin`, and a 20-file `collection/`. Updated README with file/folder use, endpoint disclosure, in-memory lifetime, persistence/history boundary, supported formats, OCR/password/legacy `.doc` limits, size/page/context limits, and locally bundled lazy parser behavior. `THIRD_PARTY_NOTICES.md` already contained matching pinned dependency and static-site details from Task 1.
- Increased the smoke watchdog from 120 to 180 seconds because real PDF/DOCX workers and directory enumeration bring the measured complete run close to the previous bound; assertion and CDP timeouts remain unchanged.

## Verification

- Focused browser: `DOCUMENT_E2E_ONLY=1 npm run e2e` — 21/21 passed, no console errors or exceptions. Log: `/tmp/task3-focused.log`.
- Unit suite: `npm test` — 375/375 passed, 0 failures/skips. Log: `/tmp/task3-npm-test.log`.
- Full browser: `npm run e2e` — 114/114 passed, no console errors or exceptions. Log: `/tmp/task3-e2e-final.log`.
- Syntax: `node --check tests/e2e/documents.mjs` and `node --check tests/e2e/smoke.mjs` passed. `git diff --check` passed.
- Screenshots: `/tmp/schematica-documents-preview.png`, `/tmp/schematica-documents-desktop.png`, `/tmp/schematica-documents-narrow.png`. Controller visual inspection identified native-looking controls and the 430px footer clipping; original Task 2 owner fixed these separately in `ed731c9` and `6f58644`. Fresh screenshots show themed controls/modal and a visible narrow composer (x 36–416, y 668–737, center hit `#ai-composer`).

## Self-review and concerns

Reviewed the full authored diff against the task brief. The acceptance module uses actual local synthetic bytes, native file and directory inputs, real browser readers, the real assistant controller, provider adapter, storage, export, thread and store-generation paths. It does not access a user Chrome profile, live board, user files, keys or provider credentials.

Password-protected PDF behavior and the forced 30-second extraction timeout are implemented in Task 1 but not forced here; constructing a deterministic encrypted PDF or waiting 30 seconds per browser run was not proportionate after real success/error/cancel worker coverage. Busy-control locking is exercised by cancellation and existing request smoke behavior but is not represented as a separate named assertion. Dropped directories are covered by controller logic but not synthesized because that would require replacing the browser's native directory entry boundary. No product concern remains from the covered behavior.

Files changed by this task: `README.md`, `tests/e2e/smoke.mjs`, `tests/e2e/documents.mjs`, `tests/fixtures/documents/README.md`, `tests/fixtures/documents/generate.py`, `tests/fixtures/documents/large.txt`, `tests/fixtures/documents/unsupported.bin`, and `tests/fixtures/documents/collection/*`.

## Review fixes

The Task 3 review found four assertion gaps. The c404e4e test source had no literal Chinese assertion, did not measure the serialized source block or reject the large fixture's tail marker, used a 300 ms sleep for stale work, and covered hostile content but not an HTML-significant filename.

Added an original fixture named `<img src=x onerror=SCHEMATICA_NAME_8>.md` and verifies its literal list/preview title with zero injected images. Provider-round assertions now require the real DOCX Chinese `电源` text, locate the actual source block on both rounds, prove each serialized block is at most 60,000 characters, and prove `SCHEMATICA_LARGE_END` is omitted. The stale-import case now holds the actual selected PDF's `File.arrayBuffer()` call, observes that read start, resets the thread, explicitly releases and settles the read, restores the native method in `finally`, and then proves no document reappears. Successful PDF/DOCX parsing remains unmodified.

Focused GREEN: `DOCUMENT_E2E_ONLY=1 npm run e2e` — 23/23 passed, no console errors or exceptions (`/tmp/task3-review-focused.log`). Final full GREEN: `npm run e2e` — 116/116 passed, no console errors or exceptions (`/tmp/task3-review-full.log`). No unit rerun because only browser acceptance code and generated fixtures changed.

### Stale-read review follow-up

The scoped review found that the release call's promise was discarded and the prior disabled-Cancel observation was already true after clearing. The test now awaits the native `arrayBuffer()` release promise directly, records both held-read start and settlement, crosses a `MessageChannel` task boundary so queued promise continuations drain, restores `File.prototype.arrayBuffer` in `finally`, and asserts the observed stale file-read completion leaves zero rows. Focused command `DOCUMENT_E2E_ONLY=1 npm run e2e`: 23/23 passed with no console errors or exceptions (`/tmp/task3-stale-read-focused.log`). The prior exact-tree full browser result remains 116/116; per review direction, the full suite was not repeated for this verification-only assertion correction.
