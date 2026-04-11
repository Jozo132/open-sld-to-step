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
  investigate[1-43].mjs             # Disposable binary exploration scripts
wasm/assembly/
  geometry.ts                       # AssemblyScript stub (dot product, normalize, etc.)
downloads/nist/                     # NIST sample files (not in git)
output/                             # Generated STEP files (not in git)
```

## Commands

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (Jest, ESM, ts-jest) |
| `npm run test:integration` | Run only `brep-extraction.test.ts` |
| `npm run build` | TypeScript → `dist/` |
| `npm run lint` | Type-check without emit |
| `npm run convert` | Build + batch-convert all NIST .SLDPRT → .stp in `./output/` |
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

**All 242 tests pass. The parser extracts vertices, surfaces (planes + cylinders), deduplicates by equation, clusters vertices into face regions, computes convex hull boundaries, and detects cylinder-through-plane holes as inner loops. Output is CLOSED_SHELL ADVANCED_BREP with bounded faces.**

### Solved problems

1. **Section selection**: `extractFirstParasolidSection` was returning the first PS-matching section (a tiny ~1KB schema-only partition header). Fix: return the **largest** PS section, which contains the actual BRep geometry.
2. **Endianness**: Float64 values are **Big Endian** (network byte order), not Little Endian. Confirmed by √2/2, 1.0, and other geometric constants.
3. **Markerless records**: Some Parasolid editions (same schema version!) have NO `=p`/`=q` record markers at all. Fix: fallback to full-buffer BE float64 triplet scanning when no markers are found. Of 11 NIST files, 4 use `=p`/`=q` markers and 7 do not.
4. **Sub-record separator**: Geometry entities (0x1E/0x1F) are always sub-records within sentinel blocks, separated by `00 01 00 01 00 03`. The `extractAllEntities()` method splits blocks accordingly.
5. **Surface classification**: 7-float entities after 0x2B marker → plane (origin+normal+0), 11-float → cylinder/cone (origin+axis+refdir+radius+semiAngle). Raw extraction: 214 planes + 68 cylinders for CTC_01.
6. **Unit conversion**: PS meters × 1000 → STEP mm. Applied to vertex positions, surface origins, and cylinder/cone radii.
7. **Surface deduplication**: Planes grouped by normal+distance, cylinders by axis+radius → 214 raw planes → 55 unique, 68 raw cylinders → 42 unique for CTC_01.
8. **Vertex-surface association**: Each surface gets its nearby vertices (perpendicular distance < 0.5mm for planes, radial distance from cylinder ≈ radius ± 0.5mm).
9. **LINE vs PLANE filtering**: 7-float entities include both PLANEs and LINE curves. LINEs are filtered out by requiring ≥ 3 associated vertices for a face. Effectively: 55 unique planes → faces with ≥ 3 vertices.
10. **Bounded face topology**: Convex hull of associated vertices on each plane → LINE edges forming the face boundary. Cylinders get circle+seam edges. CLOSED_SHELL instead of OPEN_SHELL.
11. **Vertex spatial clustering**: Vertices on the same plane equation are clustered by 2D proximity (60mm threshold) to create separate faces for spatially separated surface patches.
12. **Inner loops (holes)**: Cylinders whose axes are roughly parallel to a plane's normal and project inside the face's convex hull create circle inner loops (FACE_BOUND). CTC_01 now has 15 inner loop holes across 5 faces.

### Current output quality (CTC_01 vs reference)

| Entity | Ours | Reference |
|--------|------|-----------|
| PLANE | 55 | 80 |
| CYLINDRICAL_SURFACE | 42 | 57 |
| EDGE_LOOP | 92 | 174 |
| ADVANCED_FACE | 77 | 139 |
| FACE_BOUND (inner) | 15 | 57 |
| CLOSED_SHELL | 1 | 1 |
| MANIFOLD_SOLID_BREP | 1 | 1 |

### Known remaining issues

- **Convex hull fills concavities**: The top face boundary is a convex polygon. The reference has a concave dog-bone profile. Without edge topology, the convex hull is the best available boundary approximation.
- **Missing surfaces**: 55 planes vs 80 reference, 42 cylinders vs 57. Some surfaces are lost in deduplication (tolerance too aggressive) or not extracted (B-spline, cone types).
- **Missing topology**: Cannot extract actual face→loop→edge→vertex chains from binary data. Topology entities are embedded inline in type-0x11 records, not as separate sub-record entities.
- **Cone detection**: 11-float entities with non-zero semiAngle → implemented but 0 found for CTC_01.
- **B-spline surfaces**: Entities with 9, 10, 13+ floats are skipped.
- **Schema-driven parsing**: The current approach classifies by float count. A proper implementation would parse the schema section.

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
