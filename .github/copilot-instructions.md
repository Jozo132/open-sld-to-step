# Agent Instructions — open-sld-to-step

## What This Project Is

A **clean-room** Node.js / TypeScript library that:
1. Parses SolidWorks `.SLDPRT` files (OLE2/CFB or SW 3D Storage v4 containers)
2. Extracts the embedded Parasolid BRep geometry stream
3. Translates it into an ISO 10303-21 STEP (AP214) file

## Hard Rules

1. **No proprietary APIs.** All code must rely on standard stream parsing and public ISO specifications. Do not hallucinate or reference Dassault Systèmes or Siemens proprietary SDKs, headers, or documentation.
2. **Clean-room only.** See `LEGAL.md` for the full legal notice. All parsing is based on [MS-CFB], ISO 10303, public Parasolid schema references, and observable byte-level structure of public-domain NIST test files.
3. **Investigation scripts** go into `./scripts/investigate#.mjs` where `#` is the next serial number (currently 1–34 exist). These are disposable `.mjs` files for binary exploration — run with `node scripts/investigate#.mjs`.
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
    ParasolidParser.ts              # Parasolid binary transmit (.x_b) parser
  step/
    ParasolidToStepMapper.ts        # PsModel → STEP entity graph (AP214)
    convertSldprtToStep.ts          # End-to-end: Buffer in → STEP string out
tests/
  ole-container-parser.test.ts      # ✅ passing
  sw3d-storage-parser.test.ts       # ✅ passing
  sldprt-container-parser.test.ts   # ✅ passing
  brep-extraction.test.ts           # ✅ passing (77 tests, needs NIST samples)
  parasolid-to-step-mapper.test.ts  # ✅ passing
  step-conversion.test.ts           # ✅ passing (117 tests, needs NIST samples)
scripts/
  download-nist-samples.mjs         # Downloads NIST MBE PMI test models
  investigate[1-34].mjs             # Disposable binary exploration scripts
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

- **242 passing, 0 failing** — all 6 suites green
- Requires NIST sample files for integration tests (`npm run download-samples`)

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

## Where We Left Off — Current State

**All 242 tests pass. The parser now extracts vertices AND surfaces from Parasolid data and generates full BRep STEP output.**

### Solved problems

1. **Section selection**: `extractFirstParasolidSection` was returning the first PS-matching section (a tiny ~1KB schema-only partition header). Fix: return the **largest** PS section, which contains the actual BRep geometry.
2. **Endianness**: Float64 values are **Big Endian** (network byte order), not Little Endian. Confirmed by √2/2, 1.0, and other geometric constants.
3. **Markerless records**: Some Parasolid editions (same schema version!) have NO `=p`/`=q` record markers at all. Fix: fallback to full-buffer BE float64 triplet scanning when no markers are found. Of 11 NIST files, 4 use `=p`/`=q` markers and 7 do not.
4. **Sub-record separator**: Geometry entities (0x1E/0x1F) are always sub-records within sentinel blocks, separated by `00 01 00 01 00 03`. The `extractAllEntities()` method splits blocks accordingly.
5. **Surface classification**: 7-float entities after 0x2B marker → plane (origin+normal+0), 11-float → cylinder/cone (origin+axis+refdir+radius+semiAngle). Verified: CTC_01 yields 214 planes + 68 cylinders.
6. **Synthetic BRep topology**: Each surface gets a face with an empty edge loop, bundled into an OPEN_SHELL and MANIFOLD_SOLID_BREP. This produces valid ADVANCED_BREP_SHAPE_REPRESENTATION STEP output.

### Future improvements

- **Unit conversion**: PS stores coordinates in meters, STEP declares MILLIMETRE. All coordinates need ×1000 scaling (PS origin ±0.4 → STEP ±400mm). Currently passed through unscaled.
- **Edge/loop topology**: Faces currently have empty edge loops. Real topology requires extracting face→loop→edge→vertex reference chains from the binary data. Sub-record separator works for geometry but NOT for topology entities (only 1 face found vs 139 expected).
- **Plane vs line discrimination**: 7-float entities include both PLANEs and LINE curves (indistinguishable by structure alone). Needs context from topology references or perpendicular-distance heuristics.
- **Cone detection**: 11-float entities with non-zero semiAngle are cones — implemented but untested (no cones in the tested files).
- **B-spline surfaces**: Entities with 9, 10, 13+ floats are skipped. These likely include B-spline surfaces and tori.
- **Schema-driven parsing**: The current approach classifies by float count. A proper implementation would parse the schema section, map class IDs to field layouts, and decode each entity record structurally.

### Files that are solid (do not need changes for basic operation)

- All source files are complete and tested — 242/242 tests pass

## Parasolid Binary Transmit Format Notes

These are clean-room observations from the publicly available NIST test files (U.S. Government works, public domain):

- **Header**: `PS\x00\x00\x00` + ASCII text `?: TRANSMIT FILE (partition) created by modeller version <N>`
- **Schema block**: starts with `SCH_` identifier, contains field-type descriptors
- **Type codes**: `I` = int32, `d` = float64, `R` = array, `A` = sub-struct, `C` = class reference, `Z` = end marker
- **Sentinel**: 6-byte entity block separator `C2 BC 92 8F 99 6E`
- **Sub-record separator**: `00 01 00 01 00 03` splits concatenated entities within a sentinel block
- **Primary entity header**: `[00 00 00 03] [00 TYPE] [ID_hi ID_lo]` — first entity in a sentinel block
- **Sub-record header**: `[00 TYPE] [ID_hi ID_lo]` — entities after the sub-record separator
- **Entity type codes (byte 2)**: 0x0F=face, 0x10=edge, 0x11=shell/body, 0x12=coedge, 0x13=loop, 0x1D=point, 0x1E=surface/curve, 0x1F=bspline
- **Entity records**: some editions prefix with `=p` (0x3D 0x70) or `=q` (0x3D 0x71) markers; others use a different encoding with no markers
- **Coordinates**: stored as 3 × float64 **Big Endian** (24 bytes) inside POINT entity records. Units: meters.
- **Geometry data marker**: `0x2B` byte precedes float64 params in surface/curve entities
- **Surface classification by float count after 0x2B**:
  - 7 floats: LINE or PLANE — origin(3) + direction(3) + 0
  - 8 floats: unclear — origin(3) + direction(3) + 0 + 0
  - 11 floats: CYLINDER (semiAngle≈0) or CONE — origin(3) + axis(3) + refdir(3) + radius + semiAngle
  - 9, 10, 13+: likely B-spline or torus (not yet classified)
- **Geometry entities are always sub-records** (type 0x1E/0x1F), never primary block entities
- **References**: entity cross-references use int16 BE IDs (e.g., FACE → SURFACE, EDGE → CURVE)
