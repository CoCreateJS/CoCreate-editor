# Editor tests

Run `npm test` with the Chromium installation expected by `playwright-core`.
To use another Chromium executable, set `CHROMIUM_PATH`:

```sh
CHROMIUM_PATH=/path/to/chromium npm test
```

The Node suites import parser and editor modules directly. `parseDOM()` returns
plain source records; `createDOMEditor()` and the detail factory attach the
editor API. These tests check source preservation, cumulative offsets, object
identity, edit plans, attributes, and style operations without importing CSS or
starting a browser.

The browser suites use real Chromium for native input, selection, composition,
DOM projection, and input binding. `positions.browser.cjs` builds the current
package into a temporary directory and loads its real dependencies, including
Observer and QueryElements. It exercises the loader, query projections, renderer
values, click switching, query changes, removal cleanup, mode changes, iframe
forwarding, and remote updates. This fixture reports JavaScript errors and failed
HTTP responses, and limits each scenario to 15 seconds. It deletes its temporary
build after the suite.

`input-binding.browser.cjs` is a smaller isolation suite with mocked query,
observer, event, and selection dependencies. Its passing results should be read
alongside the real-package tests in `positions.browser.cjs`.

DOM source comparisons exclude `data-cocreate-dom-break` caret placeholders.
Those nodes belong to the rendered projection. A separate regression checks that
their source offsets remain current after edits.

The active tests use `element`, `parentNode`, `liveNode`, and `detachedNode` on
editor objects. Source offsets are calculated with `getStart()` from preceding
segment lengths. Assertions about the removed absolute-position ledger and old
`updates.js`/node-data APIs have been replaced with checks of these contracts.

Behavior failures remain ordinary failing tests. They are not skipped or marked
as expected failures: parser parity, repeated-text deletion offsets, caret
placement, and mode-change editing still need implementation investigation.

The module-lifecycle checkpoint completes with 132 passing tests and these five
failing regressions:

- Incremental DOM parsing differs from a complete parse after malformed edits.
- Typing a completed div through an existing update callback misplaces the caret.
- The caret placeholder retains an old source offset after a text update.
- Editing after changing from DOM to text mode uses stale editor state.
- Deleting repeated text reports the wrong source offset.
