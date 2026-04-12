# open-sld-to-step
A clean-room, open-source Node.js and WASM library for parsing Microsoft OLE Structured Storage in .SLDPRT files, extracting the internal Parasolid geometry streams, and translating them into standard ISO 10303 STEP files for web and backend interoperability.

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run the Jest suite and refresh `performance-results.md` when generated STEP/reference pairs are available |
| `npm run compare-all` | Compare generated STEP files against the NIST references, print the full report, and rewrite `performance-results.md` |

## Performance Tracking

`performance-results.md` is a tracked artifact generated from the compare-all summary table. It is intentionally committed so benchmark changes show up in normal git diffs.
