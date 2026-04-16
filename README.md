# open-sld-to-step
A clean-room, open-source Node.js and WASM library for parsing Microsoft OLE Structured Storage in .SLDPRT files, extracting the internal Parasolid geometry streams, and translating them into standard ISO 10303 STEP files for web and backend interoperability.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Prefer Bun for the test suite when available, otherwise fall back to Jest; refreshes `performance-results.md` afterward |
| `npm run test:bun` | Run the full suite explicitly with Bun |
| `npm run test:watch` | Run the suite in watch mode with Bun first, then Jest only if Bun is unavailable |
| `npm run test:integration` | Run only `brep-extraction.test.ts` with the preferred runner |
| `npm run compare-all` | Compare generated STEP files against the NIST references, print only the summary and match-count tables, and rewrite `performance-results.md` |
| `npm run compare-all:verbose` | Compare generated STEP files against the NIST references, print the tables plus the full per-file report, and rewrite `performance-results.md` |

## Performance Tracking

`performance-results.md` is a tracked artifact generated from the compare-all summary table. It is intentionally committed so benchmark changes show up in normal git diffs.

## Test Runner

The npm test scripts are Bun-first. Jest remains wired in only as the internal fallback used by `scripts/run-tests.mjs` when Bun is not installed. The wrapper also keeps Bun output compact for non-watch runs: success prints only a final OK summary, while failures drop pass/skip noise and keep the error details. `npm run test:bun` still gives you raw Bun output. On this Windows workspace, the current suite completes in about 5.6s under Bun versus roughly 33s under Jest.
