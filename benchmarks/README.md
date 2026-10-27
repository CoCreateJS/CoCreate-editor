# Full DOM-source parsing

Run the generated fixture benchmark from the repository root:

```sh
CHROMIUM_PATH=/path/to/chrome node benchmarks/dom-full-parse.cjs > benchmarks/dom-full-parse.results.json
```

Pass a real HTML file to benchmark that source with content and attribute
edits:

```sh
CHROMIUM_PATH=/path/to/chrome node benchmarks/dom-full-parse.cjs test/builder.html > benchmarks/builder-parse.results.json
```

This measures the existing prototype `parseDOM` and its real editor-detail
constructor, with fresh objects after every source edit. It does not change the
editor, parser, or build entry point.

The generated ASCII fixture contains nested sections, headings, inline elements,
attributes with double spaces, entities, comments, void elements, and a broken
opening tag in the middle. Six successive source states cycle through a text
insertion/deletion, an attribute insertion/deletion, and completing/breaking the
unfinished tag. Source strings are prepared before measurement.

Each document size gets a separate browser page, one first parse, six warm-up
parses, and 60 measured parses (24 for sizes of 1 MB and above). Every source
variant is checked before the timed loop, and the final result afterward:
joined values must equal its input source, cached
lengths must equal value lengths, and parent references must belong to that
result. Validation allocations are kept out of the timed loop. No nodes are
rendered. Only the previous details list is kept alive
while the next parse returns; garbage collection is left to the browser.
The timed loop runs synchronously without idle gaps between edits, so this is
a sustained parsing workload rather than a simulation of human typing cadence.

Results include individual samples, median, p95, maximum, first-parse time, and
counts above 16.7 ms and 50 ms. These thresholds indicate a 60 Hz frame interval
and a substantial main-thread pause; they are comparison points, not pass/fail
requirements. Hardware, browser, record count, and source size are recorded.

The benchmark excludes source-string edits, validation, DOM construction,
reconciliation, layout, selection, and CRDT work. It measures the current
tokenizer's object-construction cost, not a future complete-element matcher or
end-to-end typing latency. Source round-trip checks do not prove that the
parser's interpretation of incomplete markup is the desired one.

## Recorded run

Chromium 153, Linux x64, AMD EPYC 7571 (2 logical CPUs available).
Full samples and environment metadata are in `dom-full-parse.results.json`.
Sizes below use decimal KB/MB and all timings are per full parse.

| Source size | Details | Median | p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| 10 KB | 1,398 | 4.0 ms | 17.5 ms | 20.7 ms |
| 50 KB | 6,851 | 16.3 ms | 62.2 ms | 97.1 ms |
| 100 KB | 13,657 | 29.7 ms | 89.9 ms | 879.3 ms |
| 250 KB | 33,993 | 76.0 ms | 166.0 ms | 1,800.6 ms |
| 500 KB | 67,695 | 196.4 ms | 305.5 ms | 2,466.6 ms |
| 1 MB | 134,894 | 405.7 ms | 556.9 ms | 2,720.9 ms |
| 2 MB | 269,333 | 814.8 ms | 866.4 ms | 6,529.2 ms |

For this fixture and machine, 100 KB already exceeds a frame interval at the
median; 250 KB and above introduce substantial pauses before any DOM work.
Large outliers are included rather than discarded. This run does not profile
their causes. Record density and hardware matter, so these are not universal
document-size limits. A preliminary run with validation between measured
samples gave similar medians; the retained results exclude that extra workload.

## Builder document

The repository's `test/builder.html` source is 376,347 UTF-8 bytes and 376,324
JavaScript characters. It parses into 28,486 details, including 2,763 elements.
In Chromium 153 on the same machine, 60 full parses after text and quoted
attribute edits measured 74.0 ms median, 153.6 ms p95, and 1,545.9 ms maximum.
The first parse measured 141.7 ms. The detailed samples are in
`builder-parse.results.json`. The parser reconstructed the original source
exactly, and the benchmark checked the edited source variants before timing.
