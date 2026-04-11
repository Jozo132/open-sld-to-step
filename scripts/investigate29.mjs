/**
 * investigate29.mjs — Complete STEP→Parasolid cross-validation
 * 
 * Parse the reference STEP file for ctc_01, extract ALL entities (vertices, edges,
 * faces, surfaces, curves, loops, shells). Then parse the PS binary sentinel-by-sentinel
 * and match every entity type to its STEP counterpart using coordinate matching.
 * 
 * Goal: build a complete entity-type decoder to feed into ParasolidParser.ts
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');
const ctcDefDir = join(stpDir, 'CTC Definitions');
const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);

// ═══════════════════════════════════════════════════════════════════════════
// PART 1: Parse the STEP reference file completely
// ═══════════════════════════════════════════════════════════════════════════

function parseStepComplete(path) {
    const text = readFileSync(path, 'utf-8');
    const result = {
        unit: 'mm',
        cartesianPoints: new Map(),    // id → [x,y,z]
        directions: new Map(),          // id → [x,y,z]
        vertexPoints: new Map(),        // id → {pointRef}
        edgeCurves: new Map(),          // id → {v1, v2, curveRef, sense}
        orientedEdges: new Map(),       // id → {edgeRef, orientation}
        edgeLoops: new Map(),           // id → {edgeRefs[]}
        faceOuterBounds: new Map(),     // id → {loopRef, orientation}
        faceBounds: new Map(),          // id → {loopRef, orientation}
        advancedFaces: new Map(),       // id → {bounds[], surfaceRef, sameSense}
        closedShells: new Map(),        // id → {faceRefs[]}
        manifoldSolidBreps: new Map(),  // id → {shellRef}
        planes: new Map(),              // id → {axisRef}
        cylSurfaces: new Map(),         // id → {axisRef, radius}
        conSurfaces: new Map(),         // id → {axisRef, radius, semiAngle}
        axis2placements: new Map(),     // id → {locationRef, axisRef, refDirRef}
        lines: new Map(),               // id → {pointRef, dirRef}
        circles: new Map(),             // id → {axisRef, radius}
        bsplineCurves: [],              // raw entries
    };
    
    // Detect units
    if (/CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text)) result.unit = 'inch';
    
    // Helper: parse comma-separated #refs
    const parseRefs = s => [...s.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
    
    // CARTESIAN_POINT
    for (const m of text.matchAll(/#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)\s*\)/g)) {
        result.cartesianPoints.set(parseInt(m[1]), [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])]);
    }
    
    // DIRECTION
    for (const m of text.matchAll(/#(\d+)\s*=\s*DIRECTION\s*\(\s*'[^']*'\s*,\s*\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)\s*\)/g)) {
        result.directions.set(parseInt(m[1]), [parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])]);
    }
    
    // VERTEX_POINT
    for (const m of text.matchAll(/#(\d+)\s*=\s*VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g)) {
        result.vertexPoints.set(parseInt(m[1]), { pointRef: parseInt(m[2]) });
    }
    
    // EDGE_CURVE
    for (const m of text.matchAll(/#(\d+)\s*=\s*EDGE_CURVE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*#(\d+)\s*,\s*#(\d+)\s*,\s*\.(T|F)\.\s*\)/g)) {
        result.edgeCurves.set(parseInt(m[1]), { v1: parseInt(m[2]), v2: parseInt(m[3]), curveRef: parseInt(m[4]), sense: m[5] === 'T' });
    }
    
    // ORIENTED_EDGE
    for (const m of text.matchAll(/#(\d+)\s*=\s*ORIENTED_EDGE\s*\(\s*'[^']*'\s*,\s*\*\s*,\s*\*\s*,\s*#(\d+)\s*,\s*\.(T|F)\.\s*\)/g)) {
        result.orientedEdges.set(parseInt(m[1]), { edgeRef: parseInt(m[2]), orientation: m[3] === 'T' });
    }
    
    // EDGE_LOOP
    for (const m of text.matchAll(/#(\d+)\s*=\s*EDGE_LOOP\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*\)/g)) {
        result.edgeLoops.set(parseInt(m[1]), { edgeRefs: parseRefs(m[2]) });
    }
    
    // FACE_OUTER_BOUND
    for (const m of text.matchAll(/#(\d+)\s*=\s*FACE_OUTER_BOUND\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*\.(T|F)\.\s*\)/g)) {
        result.faceOuterBounds.set(parseInt(m[1]), { loopRef: parseInt(m[2]), orientation: m[3] === 'T' });
    }
    
    // FACE_BOUND  
    for (const m of text.matchAll(/#(\d+)\s*=\s*FACE_BOUND\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*\.(T|F)\.\s*\)/g)) {
        if (!result.faceOuterBounds.has(parseInt(m[1]))) {
            result.faceBounds.set(parseInt(m[1]), { loopRef: parseInt(m[2]), orientation: m[3] === 'T' });
        }
    }
    
    // ADVANCED_FACE
    for (const m of text.matchAll(/#(\d+)\s*=\s*ADVANCED_FACE\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*,\s*#(\d+)\s*,\s*\.(T|F)\.\s*\)/g)) {
        result.advancedFaces.set(parseInt(m[1]), { bounds: parseRefs(m[2]), surfaceRef: parseInt(m[3]), sameSense: m[4] === 'T' });
    }
    
    // CLOSED_SHELL
    for (const m of text.matchAll(/#(\d+)\s*=\s*CLOSED_SHELL\s*\(\s*'[^']*'\s*,\s*\(([^)]+)\)\s*\)/g)) {
        result.closedShells.set(parseInt(m[1]), { faceRefs: parseRefs(m[2]) });
    }
    
    // MANIFOLD_SOLID_BREP
    for (const m of text.matchAll(/#(\d+)\s*=\s*MANIFOLD_SOLID_BREP\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g)) {
        result.manifoldSolidBreps.set(parseInt(m[1]), { shellRef: parseInt(m[2]) });
    }
    
    // PLANE
    for (const m of text.matchAll(/#(\d+)\s*=\s*PLANE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*\)/g)) {
        result.planes.set(parseInt(m[1]), { axisRef: parseInt(m[2]) });
    }
    
    // CYLINDRICAL_SURFACE
    for (const m of text.matchAll(/#(\d+)\s*=\s*CYLINDRICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([-\d.eE+]+)\s*\)/g)) {
        result.cylSurfaces.set(parseInt(m[1]), { axisRef: parseInt(m[2]), radius: parseFloat(m[3]) });
    }
    
    // CONICAL_SURFACE
    for (const m of text.matchAll(/#(\d+)\s*=\s*CONICAL_SURFACE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)/g)) {
        result.conSurfaces.set(parseInt(m[1]), { axisRef: parseInt(m[2]), radius: parseFloat(m[3]), semiAngle: parseFloat(m[4]) });
    }
    
    // AXIS2_PLACEMENT_3D
    for (const m of text.matchAll(/#(\d+)\s*=\s*AXIS2_PLACEMENT_3D\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*#(\d+)\s*,\s*#(\d+)\s*\)/g)) {
        result.axis2placements.set(parseInt(m[1]), { locationRef: parseInt(m[2]), axisRef: parseInt(m[3]), refDirRef: parseInt(m[4]) });
    }
    
    // LINE
    for (const m of text.matchAll(/#(\d+)\s*=\s*LINE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*#(\d+)\s*\)/g)) {
        result.lines.set(parseInt(m[1]), { pointRef: parseInt(m[2]), dirRef: parseInt(m[3]) });
    }
    
    // CIRCLE
    for (const m of text.matchAll(/#(\d+)\s*=\s*CIRCLE\s*\(\s*'[^']*'\s*,\s*#(\d+)\s*,\s*([-\d.eE+]+)\s*\)/g)) {
        result.circles.set(parseInt(m[1]), { axisRef: parseInt(m[2]), radius: parseFloat(m[3]) });
    }
    
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2: Parse the Parasolid binary — all sentinel blocks
// ═══════════════════════════════════════════════════════════════════════════

function getLargestPS(filePath) {
    const buf = readFileSync(filePath);
    let best = null, idx = 0;
    while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const cs = buf.readUInt32LE(idx + 14), ds = buf.readUInt32LE(idx + 18), nl = buf.readUInt32LE(idx + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50_000_000) {
            const po = idx + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try { const n = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 }); if (n.length >= 20 && n[0] === 0x50 && n[1] === 0x53 && (!best || n.length > best.length)) best = n; } catch {}
                    }
                    if (dec.length >= 20 && dec[0] === 0x50 && dec[1] === 0x53 && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

/**
 * Parse all records from sentinel-delimited blocks.
 * 
 * Key insight from investigation: sentinel blocks contain MULTIPLE entity records
 * concatenated together. Each record within a block has pattern:
 * 
 * For 00000003 blocks:
 *   [00 00 00 03] [00 type:1] [id:2] [data...]
 * 
 * For other blocks:
 *   [00 00 XX XX] [refs...] [00 01] [00 01] [00 03] [00 type:1] [id:2] [data...]
 *   Where XX XX is an entity ID (cross-reference), followed by more entity refs,
 *   then [00 01 00 01 00 03] as a separator before the next entity record.
 * 
 * The [00 01 00 01 00 03] pattern separates sub-records within a block.
 */
function parseAllEntities(ps) {
    // Find sentinel positions
    const sentPositions = [];
    let idx = 0;
    while ((idx = ps.indexOf(SENTINEL, idx)) >= 0) { sentPositions.push(idx); idx++; }
    
    const entities = [];
    const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
    
    for (let i = 0; i < sentPositions.length; i++) {
        const blockStart = sentPositions[i] + 6;
        const blockEnd = (i + 1 < sentPositions.length) ? sentPositions[i + 1] : ps.length;
        const block = ps.subarray(blockStart, blockEnd);
        
        if (block.length < 8) continue;
        
        // Find all sub-record separators in this block: [00 01 00 01 00 03]
        const subStarts = [0]; // first record starts at 0
        let searchFrom = 0;
        while (searchFrom < block.length - 6) {
            const sepIdx = block.indexOf(SUB_SEP, searchFrom);
            if (sepIdx < 0) break;
            subStarts.push(sepIdx + 6); // sub-record starts after separator
            searchFrom = sepIdx + 6;
        }
        
        // Parse each sub-record
        for (let si = 0; si < subStarts.length; si++) {
            const recStart = subStarts[si];
            const recEnd = (si + 1 < subStarts.length) ? subStarts[si + 1] - 6 : block.length;
            
            if (recStart + 4 > block.length) continue;
            const rec = block.subarray(recStart, recEnd);
            
            // Try to find entity type marker: [00 XX] where XX is in known range
            // First sub-record in 00000003 blocks: [00 00 00 03] [00 type] [id:2]
            // Subsequent sub-records: [00 type] [id:2] [data...]
            let type = -1, id = -1, dataOff = -1;
            
            if (si === 0 && rec.length >= 8 && rec.readUInt32BE(0) === 3) {
                // 00000003 header — entity at +4
                type = rec.readUInt16BE(4);
                id = rec.readUInt16BE(6);
                dataOff = 8;
            } else if (rec.length >= 4) {
                // Sub-record: [00 type] [id:2]
                if (rec[0] === 0x00 && rec[1] >= 0x0d && rec[1] <= 0x85) {
                    type = rec.readUInt16BE(0);
                    id = rec.readUInt16BE(2);
                    dataOff = 4;
                }
            }
            
            if (type < 0 || id < 0 || dataOff < 0) continue;
            
            entities.push({
                type,
                id,
                data: rec.subarray(dataOff),
                sentinelIdx: i,
                offset: blockStart + recStart,
                fullRec: rec,
            });
        }
    }
    
    return entities;
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3: Decode entity fields by type
// ═══════════════════════════════════════════════════════════════════════════

function decodePointEntity(data) {
    // [00 00] [ref:2] [00 01] [ref1:2] [ref2:2] [ref3:2] [x:8] [y:8] [z:8]
    if (data.length < 36) return null;
    if (data[0] !== 0x00 || data[1] !== 0x00) return null;
    const ref0 = data.readUInt16BE(2);
    // data[4..5] should be [00 01]
    const ref1 = data.readUInt16BE(6);
    const ref2 = data.readUInt16BE(8);
    const ref3 = data.readUInt16BE(10);
    const x = data.readDoubleBE(12);
    const y = data.readDoubleBE(20);
    const z = data.readDoubleBE(28);
    return { ref0, ref1, ref2, ref3, x, y, z };
}

function decodeSurfaceCurveEntity(data) {
    // Records with 0x2B marker before geometry floats
    // [refs...] [2B] [origin:3×f64] [axis:3×f64] [refDir:3×f64] [radius?:f64]
    const idx2b = data.indexOf(0x2b);
    if (idx2b < 0 || idx2b + 25 > data.length) return null;
    
    // Parse refs before 0x2B
    const refs = [];
    for (let r = 0; r + 2 <= idx2b; r += 2) {
        refs.push(data.readUInt16BE(r));
    }
    
    const floatStart = idx2b + 1;
    const floats = [];
    for (let f = floatStart; f + 8 <= data.length; f += 8) {
        const v = data.readDoubleBE(f);
        if (!isFinite(v)) break;
        floats.push(v);
    }
    
    return { refs, floats, numFloats: floats.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 4: Cross-reference PS entities with STEP entities
// ═══════════════════════════════════════════════════════════════════════════

function fuzzyMatch(a, b, tol = 1e-9) {
    if (a === b) return true;
    if (Math.abs(a) < 1e-15 && Math.abs(b) < 1e-15) return true;
    return Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-15) < tol;
}

function fuzzyMatchPoint(ps, step, scale) {
    return fuzzyMatch(ps[0], step[0] * scale) &&
           fuzzyMatch(ps[1], step[1] * scale) &&
           fuzzyMatch(ps[2], step[2] * scale);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

console.log('Loading ctc_01...');

const stepFile = join(ctcDefDir, 'nist_ctc_01_asme1_rd.stp');
const sldFile = join(sldDir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const step = parseStepComplete(stepFile);
const ps = getLargestPS(sldFile);

console.log(`PS buffer: ${ps.length} bytes`);
console.log(`STEP unit: ${step.unit}`);
const scale = step.unit === 'inch' ? 0.0254 : 0.001;

// STEP entity census
console.log(`\n=== STEP ENTITY CENSUS ===`);
console.log(`  CARTESIAN_POINT:      ${step.cartesianPoints.size}`);
console.log(`  DIRECTION:            ${step.directions.size}`);
console.log(`  VERTEX_POINT:         ${step.vertexPoints.size}`);
console.log(`  EDGE_CURVE:           ${step.edgeCurves.size}`);
console.log(`  ORIENTED_EDGE:        ${step.orientedEdges.size}`);
console.log(`  EDGE_LOOP:            ${step.edgeLoops.size}`);
console.log(`  FACE_OUTER_BOUND:     ${step.faceOuterBounds.size}`);
console.log(`  FACE_BOUND (inner):   ${step.faceBounds.size}`);
console.log(`  ADVANCED_FACE:        ${step.advancedFaces.size}`);
console.log(`  CLOSED_SHELL:         ${step.closedShells.size}`);
console.log(`  MANIFOLD_SOLID_BREP:  ${step.manifoldSolidBreps.size}`);
console.log(`  PLANE:                ${step.planes.size}`);
console.log(`  CYLINDRICAL_SURFACE:  ${step.cylSurfaces.size}`);
console.log(`  CONICAL_SURFACE:      ${step.conSurfaces.size}`);
console.log(`  LINE:                 ${step.lines.size}`);
console.log(`  CIRCLE:               ${step.circles.size}`);
console.log(`  AXIS2_PLACEMENT_3D:   ${step.axis2placements.size}`);

// Parse PS entities
const entities = parseAllEntities(ps);
console.log(`\n=== PS ENTITY CENSUS ===`);
console.log(`  Total parsed entities: ${entities.length}`);

const typeCounts = new Map();
for (const e of entities) {
    typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
}
for (const [type, count] of [...typeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  type 0x${type.toString(16).padStart(4, '0')} (${type}): ${count}`);
}

// ── Match type 0x001d (POINT) → STEP VERTEX_POINT/CARTESIAN_POINT ──
console.log(`\n=== MATCHING TYPE 0x1D (POINT) → STEP VERTICES ===`);
const psPoints = entities.filter(e => e.type === 0x1d);
const decoded1d = psPoints.map(e => ({ ...decodePointEntity(e.data), id: e.id })).filter(Boolean);

let vertexMatched = 0;
for (const sv of step.vertexPoints.values()) {
    const sp = step.cartesianPoints.get(sv.pointRef);
    if (!sp) continue;
    for (const pd of decoded1d) {
        if (fuzzyMatchPoint([pd.x, pd.y, pd.z], sp, scale)) {
            vertexMatched++;
            break;
        }
    }
}
console.log(`  PS type-0x1D entities: ${psPoints.length}`);
console.log(`  Decoded with coords:   ${decoded1d.length}`);
console.log(`  Matched STEP vertices: ${vertexMatched} / ${step.vertexPoints.size}`);

// ── Match type 0x1e and 0x1f surfaces/curves → STEP surfaces ──
console.log(`\n=== MATCHING TYPE 0x1E/0x1F → STEP SURFACES/CURVES ===`);
const psGeom = entities.filter(e => e.type === 0x1e || e.type === 0x1f);
const decodedGeom = psGeom.map(e => ({ ...decodeSurfaceCurveEntity(e.data), id: e.id, type: e.type })).filter(Boolean);

// Surface origins are at float offsets 0,1,2 (from the 2B marker)
// Axis direction at 3,4,5 and ref direction at 6,7,8
let surfaceMatched = 0;
const stepSurfaces = new Map(); // collect all surface origin points
for (const [sid, surface] of step.planes) {
    const axis = step.axis2placements.get(surface.axisRef);
    if (!axis) continue;
    const loc = step.cartesianPoints.get(axis.locationRef);
    if (!loc) continue;
    stepSurfaces.set(sid, { type: 'plane', origin: loc });
}
for (const [sid, surface] of step.cylSurfaces) {
    const axis = step.axis2placements.get(surface.axisRef);
    if (!axis) continue;
    const loc = step.cartesianPoints.get(axis.locationRef);
    if (!loc) continue;
    stepSurfaces.set(sid, { type: 'cylinder', origin: loc, radius: surface.radius });
}
for (const [sid, surface] of step.conSurfaces) {
    const axis = step.axis2placements.get(surface.axisRef);
    if (!axis) continue;
    const loc = step.cartesianPoints.get(axis.locationRef);
    if (!loc) continue;
    stepSurfaces.set(sid, { type: 'cone', origin: loc, radius: surface.radius });
}

for (const [sid, ss] of stepSurfaces) {
    for (const pg of decodedGeom) {
        if (pg.numFloats >= 3 && fuzzyMatchPoint([pg.floats[0], pg.floats[1], pg.floats[2]], ss.origin, scale)) {
            surfaceMatched++;
            break;
        }
    }
}
console.log(`  PS type-0x1E entities: ${entities.filter(e => e.type === 0x1e).length}`);
console.log(`  PS type-0x1F entities: ${entities.filter(e => e.type === 0x1f).length}`);
console.log(`  Decoded with floats:   ${decodedGeom.length}`);
console.log(`  Matched STEP surfaces: ${surfaceMatched} / ${stepSurfaces.size}`);

// ── Distinguish 0x1E and 0x1F by float count → surface type ──
console.log(`\n=== GEOMETRY TYPE ANALYSIS (by float count) ===`);
const floatCountDist = new Map();
for (const pg of decodedGeom) {
    const key = `type-0x${pg.type.toString(16)}_floats-${pg.numFloats}`;
    floatCountDist.set(key, (floatCountDist.get(key) || 0) + 1);
}
for (const [key, count] of [...floatCountDist.entries()].sort()) {
    console.log(`  ${key}: ${count}`);
}

// ── Check type-0x1E with 10 floats → plane (origin + axis + refdir + nothing extra)
// ── Check type-0x1E with 10 floats and last float ≈ radius → cylinder
// ── Check type-0x1F → bspline?
console.log(`\n=== TYPE 0x1E SURFACE CLASSIFICATION ===`);
const type1e = decodedGeom.filter(g => g.type === 0x1e);
for (const g of type1e.slice(0, 15)) {
    // Check: does origin match a STEP plane, cylinder, or cone?
    let stepType = '?';
    for (const [sid, ss] of stepSurfaces) {
        if (g.numFloats >= 3 && fuzzyMatchPoint([g.floats[0], g.floats[1], g.floats[2]], ss.origin, scale)) {
            stepType = ss.type;
            if (ss.radius) stepType += ` r=${ss.radius}`;
            break;
        }
    }
    // Show float pattern
    const floatStr = g.floats.map((f, i) => {
        const af = Math.abs(f);
        if (af === 0) return '0';
        if (fuzzyMatch(af, 1.0, 1e-6)) return f > 0 ? '+1' : '-1';
        if (fuzzyMatch(af, 0.7071067811865, 1e-3)) return f > 0 ? '+√½' : '-√½';
        return f.toFixed(6);
    }).join(', ');
    console.log(`  id=${g.id} nf=${g.numFloats} → ${stepType}: [${floatStr}]`);
}

console.log(`\n=== TYPE 0x1F SURFACE/CURVE DETAIL ===`);
const type1f = decodedGeom.filter(g => g.type === 0x1f);
for (const g of type1f.slice(0, 10)) {
    let stepType = '?';
    for (const [sid, ss] of stepSurfaces) {
        if (g.numFloats >= 3 && fuzzyMatchPoint([g.floats[0], g.floats[1], g.floats[2]], ss.origin, scale)) {
            stepType = ss.type;
            if (ss.radius) stepType += ` r=${ss.radius}`;
            break;
        }
    }
    const floatStr = g.floats.slice(0, 15).map(f => f.toFixed(6)).join(', ');
    console.log(`  id=${g.id} nf=${g.numFloats} → ${stepType}: [${floatStr}]`);
}

// ── Analyze type 0x11 (SHELL/BODY) and type 0x0f (FACE) ──
console.log(`\n=== TYPE 0x11 (SHELL/BODY) ===`);
const type11 = entities.filter(e => e.type === 0x11);
for (const e of type11.slice(0, 10)) {
    console.log(`  id=${e.id} dataLen=${e.data.length}: ${[...e.fullRec.subarray(0, Math.min(60, e.fullRec.length))].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}

console.log(`\n=== TYPE 0x0f (FACE) ===`);
const type0f = entities.filter(e => e.type === 0x0f);
for (const e of type0f.slice(0, 10)) {
    console.log(`  id=${e.id} dataLen=${e.data.length}: ${[...e.fullRec.subarray(0, Math.min(60, e.fullRec.length))].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}

console.log(`\n=== TYPE 0x10 (EDGE) ===`);
const type10 = entities.filter(e => e.type === 0x10);
for (const e of type10.slice(0, 10)) {
    console.log(`  id=${e.id} dataLen=${e.data.length}: ${[...e.fullRec.subarray(0, Math.min(40, e.fullRec.length))].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}

console.log(`\n=== TYPE 0x12 (COEDGE) ===`);
const type12 = entities.filter(e => e.type === 0x12);
for (const e of type12.slice(0, 10)) {
    console.log(`  id=${e.id} dataLen=${e.data.length}: ${[...e.fullRec.subarray(0, Math.min(40, e.fullRec.length))].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}

console.log(`\n=== TYPE 0x13 (LOOP) ===`);
const type13 = entities.filter(e => e.type === 0x13);
for (const e of type13.slice(0, 10)) {
    console.log(`  id=${e.id} dataLen=${e.data.length}: ${[...e.fullRec.subarray(0, Math.min(40, e.fullRec.length))].map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
}

// ── Summary of what we know vs what STEP expects ──
console.log(`\n${'='.repeat(70)}`);
console.log(`CROSS-REFERENCE SUMMARY`);
console.log(`${'='.repeat(70)}`);
console.log(`  STEP expects → PS has`);
console.log(`  ─────────────────────`);
console.log(`  ${step.vertexPoints.size} VERTEX_POINT   → ${psPoints.length} type-0x1D (${vertexMatched} matched)`);
console.log(`  ${step.edgeCurves.size} EDGE_CURVE     → ${type10.length} type-0x10`);
console.log(`  ${step.orientedEdges.size} ORIENTED_EDGE  → ${type12.length} type-0x12`);
console.log(`  ${step.edgeLoops.size} EDGE_LOOP      → ${type13.length} type-0x13`);
console.log(`  ${step.advancedFaces.size} ADVANCED_FACE  → ${type0f.length} type-0x0F`);
console.log(`  ${step.closedShells.size} CLOSED_SHELL   → ${type11.length} type-0x11`);
console.log(`  ${stepSurfaces.size} surfaces       → ${psGeom.length} type-0x1E/0x1F (${surfaceMatched} matched)`);
