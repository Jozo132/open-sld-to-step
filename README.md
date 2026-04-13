# open-sld-to-step
A clean-room, open-source Node.js and WASM library for parsing Microsoft OLE Structured Storage in .SLDPRT files, extracting the internal Parasolid geometry streams, and translating them into standard ISO 10303 STEP files for web and backend interoperability.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Prefer Bun for the test suite when available, otherwise fall back to Jest; refreshes `performance-results.md` afterward |
| `npm run test:bun` | Run the full suite explicitly with Bun |
| `npm run test:jest` | Run the full suite explicitly with Jest |
| `npm run test:integration` | Run only `brep-extraction.test.ts` with the preferred runner |
| `npm run compare-all` | Compare generated STEP files against the NIST references, print the full report, and rewrite `performance-results.md` |

## Performance Tracking

`performance-results.md` is a tracked artifact generated from the compare-all summary table. It is intentionally committed so benchmark changes show up in normal git diffs.

## Test Runner

The default `npm test` path now prefers Bun when it is installed and falls back to the existing Jest setup otherwise. On this Windows workspace, the current suite completes in about 5.6s under Bun versus roughly 33s under Jest.
