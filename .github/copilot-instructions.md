# Agent Instructions — open-sld-to-step

## What This Project Is

A **clean-room** Node.js / TypeScript library that:
1. Parses SolidWorks `.SLDPRT` files (OLE2/CFB or SW 3D Storage v4 containers)
2. Extracts the embedded Parasolid BRep geometry stream
3. Translates it into an ISO 10303-21 STEP (AP214) file

## Hard Rules

1. **No proprietary APIs.** All code must rely on standard stream parsing and public ISO specifications. Do not hallucinate or reference Dassault Systèmes or Siemens proprietary SDKs, headers, or documentation.
2. **Clean-room only.** See `LEGAL.md` for the full legal notice. All parsing is based on [MS-CFB], ISO 10303, public Parasolid schema references, and observable byte-level structure of public-domain NIST test files.
3. **Investigation scripts** go into `./scripts/investigate#.mjs` where `#` is the next serial number (currently 1–5 exist). These are disposable `.mjs` files for binary exploration — run with `node scripts/investigate#.mjs`.
4. **Memory budget.** Tests run with `--max-old-space-size=1024`. Jest is configured with `maxWorkers: 1` and `workerIdleMemoryLimit: '256MB'`. Do not cache large buffers across test suites — use `afterAll()` to clear caches.
5. **Windows host.** The dev machine is Windows. Use `./node_modules/jest/bin/jest.js` (not `node_modules/.bin/jest` which is a bash shim). All npm scripts already handle this.

## Project Layout

```
src/
  index.ts                          # Public API re-exports
  parser/
    OleContainerParser.ts           # OLE2/CFB parser (SolidWorks < 2015)
    Sw3DStorageParser.ts            # SW 3D Storage v4 parser (SolidWorks 2015+)
    SldprtContainerParser.ts        # High-level: detects format, extracts Parasolid
    ParasolidParser.ts              # Parasolid binary transmit (.x_b) parser ← NEEDS WORK
  step/
    ParasolidToStepMapper.ts        # PsModel → STEP entity graph (AP214)
    convertSldprtToStep.ts          # End-to-end: Buffer in → STEP string out
tests/
  ole-container-parser.test.ts      # ✅ passing
  sw3d-storage-parser.test.ts       # ✅ passing
  sldprt-container-parser.test.ts   # ✅ passing
  brep-extraction.test.ts           # ✅ passing (77 tests, needs NIST samples)
  parasolid-to-step-mapper.test.ts  # ✅ passing
  step-conversion.test.ts           # ❌ 47 failing — vertex extraction returns 0
scripts/
  download-nist-samples.mjs         # Downloads NIST MBE PMI test models
  investigate[1-5].mjs              # Disposable binary exploration scripts
wasm/assembly/
  geometry.ts                       # AssemblyScript stub (dot product, normalize, etc.)
downloads/nist/                     # NIST sample files (not in git)
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (Jest, ESM, ts-jest) |
| `npm run test:integration` | Run only `brep-extraction.test.ts` |
| `npm run build` | TypeScript → `dist/` |
| `npm run lint` | Type-check without emit |
| `npm run download-samples` | Fetch NIST SolidWorks MBD 2018 test files |

## Current Test Status

- **195 passing, 47 failing** (all failures in `step-conversion.test.ts`)
- All 5 other suites pass (242 total tests)

## Data Pipeline

```
.SLDPRT buffer
  → SldprtContainerParser.extractParasolid()
    → OLE2 path: OleContainerParser → extractStream("Contents")
    → SW3D path: Sw3DStorageParser → extractParasolidSections()
      → inflateRawSync (outer)
      → tryNestedDecompress at byte 28 (inner zlib)
  → Parasolid binary transmit buffer (.x_b)
  → ParasolidParser.parse() → PsModel
  → ParasolidToStepMapper.mapModel() → StepEntity[]
  → ParasolidToStepMapper.toStepFile() → ISO 10303-21 string
```

## Where We Left Off — The Blocking Problem

**The `ParasolidParser.extractCoordinates()` method returns 0 vertices for all 11 NIST files.** This causes 47 test failures in `step-conversion.test.ts`.

### Root cause

The current `extractCoordinates()` scans for `=p` (0x3D 0x70) and `=q` (0x3D 0x71) record markers, then brute-force reads IEEE 754 float64 triplets nearby. This heuristic finds nothing in the NIST files because:

- The Parasolid binary transmit format uses a **structured schema** with typed fields. Coordinate data is interleaved with entity reference IDs, type tags, and array-length prefixes. Blind triplet scanning misses them because the floats are not at predictable byte offsets after the `=p`/`=q` markers.
- The `=p`/`=q` markers may not even be the correct record boundaries for the binary transmit version used by SolidWorks MBD 2018.

### What needs to happen

The `ParasolidParser` needs to be rewritten to actually parse the binary transmit format structurally:

1. **Parse the schema section** — it defines entity class names and their field types (I=int32, d=float64, R=array, C=class-ref, etc.). The schema is near the top of the file, after the header.
2. **Parse entity class definitions** — map class IDs to their field layouts.
3. **Parse entity instance records** — use the schema to decode each record's fields in order, extracting float64 coordinate values from POINT/VERTEX entities specifically.

### Key observations from investigation scripts

- The Parasolid buffer starts with: `PS\x00\x00\x00?: TRANSMIT FILE (partition) created by modeller version NNNNNNN`
- Schema ID follows: `SCH_<version>_<major>_<minor>`
- Entity class names are present in the binary: BODY, SHELL, FACE, LOOP, EDGE, VERTEX, POINT, SURFACE, CURVE, etc.
- Entity records have markers but their internal layout depends on the schema
- All 11 NIST files are SW 3D Storage v4 format with the Parasolid data double-compressed (outer deflate → 28-byte header → inner zlib)

### Files to change

- `src/parser/ParasolidParser.ts` — rewrite `extractCoordinates()` and `parse()` to use schema-driven field decoding instead of brute-force float scanning
- `tests/step-conversion.test.ts` — tests are correct as-is; they should pass once the parser works

### Files that are solid (do not need changes)

- `OleContainerParser.ts` — complete, tested
- `Sw3DStorageParser.ts` — complete, tested, double-decompression works
- `SldprtContainerParser.ts` — complete, tested
- `ParasolidToStepMapper.ts` — complete, maps PsModel → STEP correctly
- `convertSldprtToStep.ts` — complete, orchestrates the pipeline
- `brep-extraction.test.ts` — 77/77 passing

## Parasolid Binary Transmit Format Notes

These are clean-room observations from the publicly available NIST test files (U.S. Government works, public domain):

- **Header**: `PS\x00\x00\x00` + ASCII text `?: TRANSMIT FILE (partition) created by modeller version <N>`
- **Schema block**: starts with `SCH_` identifier, contains field-type descriptors
- **Type codes**: `I` = int32, `d` = float64, `R` = array, `A` = sub-struct, `C` = class reference, `Z` = end marker
- **Entity records**: prefixed by `=p` or `=q` markers, fields are packed in schema order
- **Coordinates**: stored as 3 × float64 LE (24 bytes) inside POINT entity records
- **References**: entity cross-references use int32 IDs (e.g., FACE → SURFACE, EDGE → CURVE)
