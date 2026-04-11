/**
 * investigate22.mjs — Parse reference STEP files from NIST and cross-reference
 * with Parasolid binary data to map entity types.
 *
 * Uses the CTC/FTC Definitions/*.stp files as ground truth, then compares
 * coordinate sets with what we extract from the .SLDPRT Parasolid stream.
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

// ── STEP parser (minimal) ────────────────────────────────────────────────────

function parseStepFile(filePath) {
    const text = readFileSync(filePath, 'utf8');
    const entities = new Map(); // id → { type, args (raw string) }

    // Join continuation lines: STEP wraps lines but each entity starts with #N=
    const joined = text.replace(/\r\n/g, '\n').replace(/\n(?!#|\s*END|\s*ISO|\s*HEADER|\s*FILE_|\s*DATA|\s*ENDSEC)/g, '');

    const re = /#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([^;]*)\)\s*;/g;
    let m;
    while ((m = re.exec(joined)) !== null) {
        entities.set(parseInt(m[1]), { type: m[2], args: m[3].trim() });
    }
    return entities;
}

function parseRefList(s) {
    // Parse "(#123,#456,...)" → [123, 456, ...]
    const refs = [];
    const re = /#(\d+)/g;
    let m;
    while ((m = re.exec(s)) !== null) refs.push(parseInt(m[1]));
    return refs;
}

function parseFloatList(s) {
    // Parse "(1.0,2.0,3.0)" → [1.0, 2.0, 3.0]
    return s.replace(/[()]/g, '').split(',').map(Number).filter(n => !isNaN(n));
}

function parseStepArgs(argsStr) {
    // Simple tokenizer for STEP argument lists
    const tokens = [];
    let depth = 0, current = '';
    for (const ch of argsStr) {
        if (ch === '(' && depth === 0) { depth++; current += ch; continue; }
        if (ch === '(') { depth++; current += ch; continue; }
        if (ch === ')') { depth--; current += ch; continue; }
        if (ch === ',' && depth === 0) { tokens.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    if (current.trim()) tokens.push(current.trim());
    return tokens;
}

// ── Extract topology from STEP ──────────────────────────────────────────────

function extractStepTopology(entities) {
    const result = {
        points: [],       // { id, x, y, z }
        directions: [],   // { id, dx, dy, dz }
        vertices: [],     // { id, pointId }
        edges: [],        // { id, v1, v2, curveId }
        faces: [],        // { id, surfaceId, bounds[] }
        surfaces: [],     // { id, type, params }
        curves: [],       // { id, type, params }
        shells: [],       // { id, faceIds[] }
        loops: [],        // { id, edgeIds[] }
    };

    for (const [id, ent] of entities) {
        const args = parseStepArgs(ent.args);
        switch (ent.type) {
            case 'CARTESIAN_POINT': {
                const coords = parseFloatList(args[1] || args[0]);
                if (coords.length >= 3) {
                    result.points.push({ id, x: coords[0], y: coords[1], z: coords[2] });
                }
                break;
            }
            case 'DIRECTION': {
                const d = parseFloatList(args[1] || args[0]);
                if (d.length >= 3) {
                    result.directions.push({ id, dx: d[0], dy: d[1], dz: d[2] });
                }
                break;
            }
            case 'VERTEX_POINT': {
                const refs = parseRefList(args[1] || args[0]);
                if (refs.length >= 1) result.vertices.push({ id, pointId: refs[refs.length - 1] });
                break;
            }
            case 'EDGE_CURVE': {
                const refs = parseRefList(ent.args);
                // EDGE_CURVE('', #v1, #v2, #curve, .T.)
                if (refs.length >= 3) {
                    result.edges.push({ id, v1: refs[0], v2: refs[1], curveId: refs[2] });
                }
                break;
            }
            case 'ORIENTED_EDGE': {
                const refs = parseRefList(ent.args);
                // ORIENTED_EDGE('', *, *, #edge, .T./.F.)
                if (refs.length >= 1) {
                    // Last ref before the boolean is the edge_curve
                    result.edges.push({ id, edgeCurveId: refs[refs.length - 1], type: 'oriented' });
                }
                break;
            }
            case 'EDGE_LOOP': {
                const refs = parseRefList(ent.args);
                result.loops.push({ id, edgeIds: refs });
                break;
            }
            case 'FACE_BOUND':
            case 'FACE_OUTER_BOUND': {
                // stored inline in ADVANCED_FACE
                break;
            }
            case 'ADVANCED_FACE': {
                const refs = parseRefList(ent.args);
                // ADVANCED_FACE('', (bounds...), #surface, .T.)
                // Last ref is the surface
                if (refs.length >= 2) {
                    result.faces.push({
                        id,
                        surfaceId: refs[refs.length - 1],
                        boundIds: refs.slice(0, -1),
                    });
                }
                break;
            }
            case 'CLOSED_SHELL':
            case 'OPEN_SHELL': {
                const refs = parseRefList(ent.args);
                result.shells.push({ id, faceIds: refs, type: ent.type });
                break;
            }
            case 'PLANE':
            case 'CYLINDRICAL_SURFACE':
            case 'CONICAL_SURFACE':
            case 'SPHERICAL_SURFACE':
            case 'TOROIDAL_SURFACE':
            case 'B_SPLINE_SURFACE_WITH_KNOTS': {
                const refs = parseRefList(ent.args);
                result.surfaces.push({ id, type: ent.type, refs, args });
                break;
            }
            case 'LINE':
            case 'CIRCLE':
            case 'ELLIPSE':
            case 'B_SPLINE_CURVE_WITH_KNOTS': {
                const refs = parseRefList(ent.args);
                result.curves.push({ id, type: ent.type, refs, args });
                break;
            }
        }
    }
    return result;
}

// ── Extract Parasolid data ──────────────────────────────────────────────────

const SW3D_MARKER = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);

function isParasolid(buf) {
    if (buf.length < 20 || buf[0] !== 0x50 || buf[1] !== 0x53) return false;
    return buf.indexOf('TRANSMIT', 0, 'ascii') >= 0 && buf.indexOf('TRANSMIT', 0, 'ascii') < 32;
}

function getLargestPS(filePath) {
    const buf = readFileSync(filePath);
    let best = null, idx = 0;
    while ((idx = buf.indexOf(SW3D_MARKER, idx)) >= 0) {
        if (idx + 26 > buf.length) break;
        const compressedSize = buf.readUInt32LE(idx + 14);
        const decompressedSize = buf.readUInt32LE(idx + 18);
        const nameLength = buf.readUInt32LE(idx + 22);
        if (nameLength > 0 && nameLength < 1024 && compressedSize > 4 &&
            compressedSize < buf.length && decompressedSize > 4 && decompressedSize < 50_000_000) {
            const payloadOffset = idx + 26 + nameLength;
            const payloadEnd = payloadOffset + compressedSize;
            if (payloadEnd <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(payloadOffset, payloadEnd),
                        { maxOutputLength: decompressedSize + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (isParasolid(nested) && (!best || nested.length > best.length))
                                best = nested;
                        } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length))
                        best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

function extractPsTriplets(buf) {
    // Find =p/=q markers
    const markers = [];
    for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i] === 0x3d && (buf[i + 1] === 0x70 || buf[i + 1] === 0x71))
            markers.push(i);
    }

    const points = [];
    const seen = new Set();

    const scan = (start, end) => {
        for (let j = start; j + 24 <= end; j++) {
            const x = buf.readDoubleBE(j);
            const y = buf.readDoubleBE(j + 8);
            const z = buf.readDoubleBE(j + 16);
            if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
            if (Math.abs(x) > 1e4 || Math.abs(y) > 1e4 || Math.abs(z) > 1e4) continue;
            if (x === 0 && y === 0 && z === 0) continue;
            if (Math.abs(x) + Math.abs(y) + Math.abs(z) < 1e-15) continue;
            const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push({ x, y, z, offset: j });
        }
    };

    if (markers.length > 0) {
        for (let mi = 0; mi < markers.length; mi++) {
            const mOff = markers[mi];
            const isP = buf[mOff + 1] === 0x70;
            const end = mi + 1 < markers.length ? markers[mi + 1] : Math.min(mOff + 20000, buf.length);
            const start = mOff + (isP ? 5 : 2);
            scan(start, end);
        }
    } else {
        // Markerless: skip header/schema
        let dataStart = 0x400;
        for (let i = Math.min(0x1000, buf.length) - 1; i >= 0x60; i--) {
            if (buf[i] === 0x5a) { dataStart = i + 1; break; }
        }
        scan(dataStart, buf.length);
    }
    return points;
}

// ── Cross-reference ─────────────────────────────────────────────────────────

function crossReference(stepTopo, psTriplets) {
    // Round coordinates to match
    const roundKey = (x, y, z, decimals = 4) =>
        `${x.toFixed(decimals)},${y.toFixed(decimals)},${z.toFixed(decimals)}`;

    // Build a lookup from STEP CARTESIAN_POINTs
    const stepPointMap = new Map();
    for (const p of stepTopo.points) {
        // STEP uses mm, Parasolid may use meters — try both
        stepPointMap.set(roundKey(p.x, p.y, p.z), { ...p, scale: 'mm' });
        stepPointMap.set(roundKey(p.x / 1000, p.y / 1000, p.z / 1000), { ...p, scale: 'm→mm' });
    }

    // Try matching PS triplets to STEP points
    const matched = [];
    const unmatched = [];
    for (const pt of psTriplets) {
        const key = roundKey(pt.x, pt.y, pt.z);
        if (stepPointMap.has(key)) {
            matched.push({ ps: pt, step: stepPointMap.get(key) });
        } else {
            unmatched.push(pt);
        }
    }

    return { matched, unmatched, stepPointMap };
}

// ── Main ────────────────────────────────────────────────────────────────────

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');

const pairs = [
    { name: 'ctc_01', stp: join(stpDir, 'CTC Definitions', 'nist_ctc_01_asme1_rd.stp'), sld: join(sldDir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT') },
    { name: 'ctc_03', stp: join(stpDir, 'CTC Definitions', 'nist_ctc_03_asme1_rc.stp'), sld: join(sldDir, 'nist_ctc_03_asme1_rc_sw1802.SLDPRT') },
    { name: 'ftc_06', stp: join(stpDir, 'FTC Definitions', 'nist_ftc_06_asme1_rd.stp'), sld: join(sldDir, 'nist_ftc_06_asme1_rd_sw1802.SLDPRT') },
    { name: 'ftc_11', stp: join(stpDir, 'FTC Definitions', 'nist_ftc_11_asme1_rb.stp'), sld: join(sldDir, 'nist_ftc_11_asme1_rb_sw1802.SLDPRT') },
];

for (const pair of pairs) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`MODEL: ${pair.name}`);
    console.log(`${'═'.repeat(80)}`);

    // Parse reference STEP
    const entities = parseStepFile(pair.stp);
    const topo = extractStepTopology(entities);

    console.log(`\n── STEP Reference ──`);
    console.log(`  Entities total:    ${entities.size}`);
    console.log(`  CARTESIAN_POINTs:  ${topo.points.length}`);
    console.log(`  DIRECTIONs:        ${topo.directions.length}`);
    console.log(`  VERTEX_POINTs:     ${topo.vertices.length}`);
    console.log(`  EDGE_CURVEs:       ${topo.edges.filter(e => !e.type).length}`);
    console.log(`  EDGE_LOOPs:        ${topo.loops.length}`);
    console.log(`  ADVANCED_FACEs:    ${topo.faces.length}`);
    console.log(`  Shells:            ${topo.shells.length}`);

    // Surface types
    const surfTypes = {};
    for (const s of topo.surfaces) surfTypes[s.type] = (surfTypes[s.type] || 0) + 1;
    console.log(`  Surfaces:          ${topo.surfaces.length} — ${JSON.stringify(surfTypes)}`);

    // Curve types
    const curveTypes = {};
    for (const c of topo.curves) curveTypes[c.type] = (curveTypes[c.type] || 0) + 1;
    console.log(`  Curves:            ${topo.curves.length} — ${JSON.stringify(curveTypes)}`);

    // Vertex coordinate ranges (in STEP mm units)
    const vertexPoints = topo.vertices.map(v => topo.points.find(p => p.id === v.pointId)).filter(Boolean);
    if (vertexPoints.length > 0) {
        const xs = vertexPoints.map(p => p.x), ys = vertexPoints.map(p => p.y), zs = vertexPoints.map(p => p.z);
        console.log(`  Vertex coord ranges (mm):`);
        console.log(`    X: [${Math.min(...xs).toFixed(3)}, ${Math.max(...xs).toFixed(3)}]`);
        console.log(`    Y: [${Math.min(...ys).toFixed(3)}, ${Math.max(...ys).toFixed(3)}]`);
        console.log(`    Z: [${Math.min(...zs).toFixed(3)}, ${Math.max(...zs).toFixed(3)}]`);

        console.log(`\n  First 10 vertex coordinates (mm):`);
        for (const vp of vertexPoints.slice(0, 10)) {
            console.log(`    #${vp.id}: (${vp.x.toFixed(4)}, ${vp.y.toFixed(4)}, ${vp.z.toFixed(4)})`);
        }
    }

    // Extract PS data
    const ps = getLargestPS(pair.sld);
    if (!ps) { console.log(`  ⚠ No Parasolid data from ${pair.sld}`); continue; }

    const psTriplets = extractPsTriplets(ps);
    console.log(`\n── Parasolid Data ──`);
    console.log(`  Buffer size:       ${ps.length} bytes`);
    console.log(`  Triplets found:    ${psTriplets.length}`);

    if (psTriplets.length > 0) {
        const pxs = psTriplets.map(p => p.x), pys = psTriplets.map(p => p.y), pzs = psTriplets.map(p => p.z);
        console.log(`  Coord ranges:`);
        console.log(`    X: [${Math.min(...pxs).toFixed(6)}, ${Math.max(...pxs).toFixed(6)}]`);
        console.log(`    Y: [${Math.min(...pys).toFixed(6)}, ${Math.max(...pys).toFixed(6)}]`);
        console.log(`    Z: [${Math.min(...pzs).toFixed(6)}, ${Math.max(...pzs).toFixed(6)}]`);

        console.log(`\n  First 10 PS triplets:`);
        for (const t of psTriplets.slice(0, 10)) {
            console.log(`    @0x${t.offset.toString(16)}: (${t.x.toFixed(6)}, ${t.y.toFixed(6)}, ${t.z.toFixed(6)})`);
        }
    }

    // Cross-reference
    const xref = crossReference(topo, psTriplets);
    console.log(`\n── Cross-Reference ──`);
    console.log(`  PS→STEP matched:   ${xref.matched.length} / ${psTriplets.length} PS triplets`);
    console.log(`  STEP vertex points: ${vertexPoints.length}`);

    if (xref.matched.length > 0) {
        console.log(`\n  First 10 matches:`);
        for (const m of xref.matched.slice(0, 10)) {
            const sp = m.step;
            console.log(`    PS (${m.ps.x.toFixed(4)}, ${m.ps.y.toFixed(4)}, ${m.ps.z.toFixed(4)}) → STEP #${sp.id} (${sp.scale}) (${sp.x.toFixed(4)}, ${sp.y.toFixed(4)}, ${sp.z.toFixed(4)})`);
        }
    }

    if (xref.unmatched.length > 0) {
        // Check if unmatched PS points might be direction vectors or surface params
        const directionLike = xref.unmatched.filter(p => {
            const mag = Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2);
            return Math.abs(mag - 1.0) < 0.001;
        });
        const otherUnmatched = xref.unmatched.filter(p => {
            const mag = Math.sqrt(p.x ** 2 + p.y ** 2 + p.z ** 2);
            return Math.abs(mag - 1.0) >= 0.001;
        });
        console.log(`\n  Unmatched PS triplets: ${xref.unmatched.length}`);
        console.log(`    Unit vectors (directions): ${directionLike.length}`);
        console.log(`    Other (curve/surface params): ${otherUnmatched.length}`);

        // Check how many PS unit vectors match STEP DIRECTIONs
        const stepDirKeys = new Set();
        for (const d of topo.directions) {
            stepDirKeys.add(`${d.dx.toFixed(4)},${d.dy.toFixed(4)},${d.dz.toFixed(4)}`);
        }
        const matchedDirs = directionLike.filter(p =>
            stepDirKeys.has(`${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`)
        );
        console.log(`    Unit vectors matching STEP DIRECTIONs: ${matchedDirs.length} / ${directionLike.length}`);
    }

    // Determine unit scale: are PS coords in meters (STEP in mm)?
    if (vertexPoints.length > 0 && psTriplets.length > 0) {
        // Try to find the scale factor
        const stepV = vertexPoints[0];
        let bestScale = 1, bestDist = Infinity;
        for (const scale of [1, 1000, 0.001, 25.4, 1/25.4]) {
            for (const pt of psTriplets) {
                const d = Math.sqrt(
                    (pt.x * scale - stepV.x) ** 2 +
                    (pt.y * scale - stepV.y) ** 2 +
                    (pt.z * scale - stepV.z) ** 2
                );
                if (d < bestDist) { bestDist = d; bestScale = scale; }
            }
        }
        console.log(`\n  Best unit scale factor: ${bestScale} (residual: ${bestDist.toFixed(6)})`);
    }
}
