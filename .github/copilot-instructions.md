# Agent Instructions — open-sld-to-step

## What This Project Is

A **clean-room** Node.js / TypeScript library that:
1. Parses SolidWorks `.SLDPRT` files (OLE2/CFB or SW 3D Storage v4 containers)
2. Extracts the embedded Parasolid BRep geometry stream
3. Translates it into an ISO 10303-21 STEP (AP214) file

## Hard Rules

1. **No proprietary APIs.** All code must rely on standard stream parsing and public ISO specifications. Do not hallucinate or reference Dassault Systèmes or Siemens proprietary SDKs, headers, or documentation.
2. **Clean-room only.** See `LEGAL.md` for the full legal notice. All parsing is based on [MS-CFB], ISO 10303, public Parasolid schema references, and observable byte-level structure of public-domain NIST test files.
3. **Investigation scripts** go into `./scripts/investigate#.mjs` where `#` is the next serial number (currently 1–72 exist). These are disposable `.mjs` files for binary exploration — run with `node scripts/investigate#.mjs`.
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
  compare-step.mjs                  # Deep STEP-vs-reference comparison (per-entity)
  compare-all.mjs                   # Batch compare all 11 NIST files, summary table
  convert-all.mjs                   # Batch convert all NIST .SLDPRT → .stp
  investigate[1-72].mjs             # Disposable binary exploration scripts
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
| `npm run compare-all` | Compare all 11 generated STEP files against NIST references |
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

### Compare-all scores (current baseline: 49.9% average)

| File | Planes | Cylinders | Cones | Faces | Overall |
|------|--------|-----------|-------|-------|---------|
| CTC_01 | 53.8% (43/80) | 78.9% (45/57) | 0% (0/2) | 56.1% (78/139) | 60.7% |
| CTC_02 | 31.0% (49/158) | 52.8% (168/318) | 0% (0/158) | 18.8% (125/664) | 42.4% |
| CTC_03 | 57.0% (49/86) | 100% (53/53) | — | 71.2% (99/139) | 78.1% |
| CTC_04 | 35.9% (61/170) | 69.5% (164/236) | 0% (0/64) | 31.9% (166/520) | 48.3% |
| CTC_05 | 54.0% (34/63) | 50.0% (50/100) | 0% (0/26) | 27.3% (57/209) | 42.0% |
| FTC_06 | 50.7% (36/71) | 88.7% (55/62) | 0% (0/4) | 43.8% (63/144) | 51.0% |
| FTC_07 | 23.4% (26/111) | 66.0% (70/106) | 0% (0/28) | 36.4% (98/269) | 47.2% |
| FTC_08 | 48.5% (48/99) | 60.9% (95/156) | 0% (0/2) | 44.1% (119/270) | 48.0% |
| FTC_09 | 58.7% (37/63) | 51.1% (45/88) | 0% (0/8) | 35.4% (56/158) | 48.0% |
| FTC_10 | 64.2% (34/53) | 65.0% (80/123) | 0% (0/8) | 39.7% (85/214) | 55.4% |
| FTC_11 | 4.8% (1/21) | 33.3% (1/3) | — | 15.0% (3/20) | 27.4% |
| **AVG** | **43.8%** | **65.1%** | **18.2%** | **38.2%** | **49.9%** |

Score weights: Planes×3, Cylinders×3, Cones×2, Faces×4, HolesExact×2, InnerLoops×2, Vertices×1, Circles×1.

### Known remaining issues

- **LINE/PLANE ambiguity**: Type-0x1E 7-float entities are mixed LINE curves and PLANE surfaces. No binary discriminator found in entity headers (investigate66). The direction field is the FACE NORMAL for PLANEs but the EDGE TANGENT for LINEs — currently indistinguishable. Of extracted planes for CTC_01: ~47% are correct PLANEs, ~53% are LINE curves with wrong normals.
- **False positive planes**: Axis-aligned inference generates many spurious planes from incidental vertex alignments (FTC_11: 21 generated vs 2 reference). Cylinder cross-section vertices happen to be coplanar along axis directions. A cylinder-shadow filter was attempted but it also removes real planes at cylinder-plane intersections.
- **Missing non-axis normals**: CTC_01 has 15 unique reference normal directions, we cover only 5. The 10 missing include 45° (0.707,0.707,0), hex 30°/60° (0.5,0.866,0), and compound normals like (0.354,-0.612,0.707). A vertex-triplet normal discovery approach was tested but generated too many false normals at practical thresholds.
- **Missing cylinders**: CTC_01 misses 12 cylinders: 6 at r=10mm with horizontal axes (Y and X oriented) at Z=-60mm, 6 at r=5mm with hex-angle axes (0.866, ±0.5, 0) — hex boss fillet cylinders.
- **Convex hull fills concavities**: Face boundaries are convex polygons. The reference has concave profiles (dog-bone). Without edge topology, convex hull is the best available approximation.
- **Missing surface types**: 298 cones + 119 tori + 103 spheres + 25 B-splines across all reference files cannot be generated. Cone entities exist in binary (11-float with non-zero semiAngle) but 0 found for CTC_01.
- **Missing topology**: Cannot extract actual face→loop→edge→vertex chains from binary data. Topology entities are embedded inline in type-0x11 records, not as separate sub-record entities.
- **Schema-driven parsing**: The current approach classifies entities by float count. A proper implementation would parse the schema section.

### Approaches tried and results

| Approach | Score | Notes |
|----------|-------|-------|
| Committed baseline | 49.9% | Current best |
| Inference-only planes (no extraction) | 49.6% | Neutral — extraction d-values not worse than inference |
| Vertex-triplet normals (MIN_HITS=4) | 46.9% | Too many false normals, FTC_11 exploded to 185 surfaces |
| Vertex-triplet normals (MIN_HITS=20) | 49.2% | Marginal — triplets don't help at safe thresholds |
| Cylinder shadow filter (all) | 42.6% | Too aggressive — removes real planes at hole boundaries |
| Cylinder shadow filter (⊥ only) | 45.4% | Still removes real planes with horizontal through-holes |

### Face ceiling analysis (investigate68)

Maximum achievable face score if we perfectly matched every plane+cylinder (no cones/tori/spheres/B-splines):

| File | Ceiling | Why limited |
|------|---------|-------------|
| CTC_01 | 98.6% | Only 2 cones |
| CTC_02 | 70.6% | 158 cones, 4 tori |
| CTC_03 | 100% | All planes+cylinders |
| CTC_04 | 81.2% | 64 cones |
| CTC_05 | 77.5% | 26 cones |
| FTC_06 | 93.1% | 4 cones |
| FTC_07 | 86.9% | 28 cones |
| FTC_08 | 100% | All planes+cylinders |
| FTC_09 | 94.9% | 8 cones |
| FTC_10 | 93.5% | 8 cones, 2 tori |
| FTC_11 | 100% | All planes+cylinders |

### CTC_01 plane match diagnostic (investigate72)

Of 43 generated planes, 29 match the reference (all with d ≤ 0.1mm precision). 14 are wrong:
- 7 wrong axis-aligned (d-values off by 4–59mm)
- 7 wrong non-axis (LINE tangent directions misidentified as face normals)

51 reference planes are unmatched — mostly AXIS-ALIGNED at positions our vertex clustering misses (Y=±20, ±25, ±100, ±125, ±225; Z=−13.75, −22.7, −31.6, 18.5, 27.4, 36.25) plus 12 NON-AXIS planes at compound angles.

### Reference file units

- **MM**: CTC_01, CTC_02, CTC_04, FTC_10, FTC_11
- **INCH**: CTC_03, CTC_05, FTC_06, FTC_07, FTC_08, FTC_09

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
