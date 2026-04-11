/**
 * investigate25.mjs — Correct-scale vertex search in both marker and
 * markerless PS files, with unit detection from STEP files.
 *
 * Key insight from investigate24: ctc_03 STEP uses INCHES not mm.
 * PS always stores meters. So conversion is:
 *   ctc_01: STEP_mm / 1000 = PS_meters  
 *   ctc_03: STEP_inches × 0.0254 = PS_meters (inches → meters)
 * 
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const stpDir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models';
const sldDir = join(stpDir, 'SolidWorks MBD 2018');

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
        const cs = buf.readUInt32LE(idx + 14), ds = buf.readUInt32LE(idx + 18), nl = buf.readUInt32LE(idx + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50_000_000) {
            const po = idx + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const dec = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (dec.length > 28 && dec[28] === 0x78) {
                        try {
                            const nested = inflateSync(dec.subarray(28), { maxOutputLength: 50_000_000 });
                            if (isParasolid(nested) && (!best || nested.length > best.length)) best = nested;
                        } catch {}
                    }
                    if (isParasolid(dec) && (!best || dec.length > best.length)) best = dec;
                } catch {}
            }
        }
        idx++;
    }
    return best;
}

function float64BEbytes(val) { const b = Buffer.alloc(8); b.writeDoubleBE(val); return b; }

function detectStepUnit(filePath) {
    const text = readFileSync(filePath, 'utf8').substring(0, 20000);
    // Look for unit definitions
    if (/CONVERSION_BASED_UNIT.*INCH/i.test(text)) return { unit: 'inch', toMeters: 0.0254 };
    if (/SI_UNIT\s*\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/i.test(text)) return { unit: 'mm', toMeters: 0.001 };
    if (/SI_UNIT\s*\(\s*\$\s*,\s*\.METRE\.\s*\)/i.test(text)) return { unit: 'm', toMeters: 1.0 };
    // If file has LENGTH_MEASURE with small values, it's likely inches
    return { unit: 'unknown', toMeters: 0.001 }; // assume mm
}

function parseStepForModel(filePath) {
    const text = readFileSync(filePath, 'utf8');
    const joined = text.replace(/\r\n/g, '\n').replace(/\n(?!#)/g, '');
    const entities = new Map();
    const re = /#(\d+)\s*=\s*([A-Z_0-9]+)\s*\(([^;]*)\)\s*;/g;
    let m;
    while ((m = re.exec(joined)) !== null) {
        entities.set(parseInt(m[1]), { type: m[2], args: m[3].trim() });
    }

    const points = new Map();
    for (const [id, ent] of entities) {
        if (ent.type === 'CARTESIAN_POINT') {
            const match = ent.args.match(/\(([^)]+)\)/);
            if (match) {
                const c = match[1].split(',').map(Number);
                if (c.length >= 3 && c.every(isFinite)) points.set(id, { x: c[0], y: c[1], z: c[2] });
            }
        }
    }

    const vertices = [];
    for (const [id, ent] of entities) {
        if (ent.type === 'VERTEX_POINT') {
            const refs = [...ent.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
            const pt = points.get(refs[refs.length - 1]);
            if (pt) vertices.push({ id, ...pt });
        }
    }

    // Get surface definitions
    const surfaces = [];
    for (const [id, ent] of entities) {
        if (/^(PLANE|CYLINDRICAL_SURFACE|CONICAL_SURFACE|SPHERICAL_SURFACE|TOROIDAL_SURFACE)$/.test(ent.type)) {
            const refs = [...ent.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
            const ap = entities.get(refs[0]);
            let origin = null, axis = null, refDir = null;
            if (ap && ap.type === 'AXIS2_PLACEMENT_3D') {
                const apRefs = [...ap.args.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
                origin = points.get(apRefs[0]);
                // axis direction
                const axEnt = entities.get(apRefs[1]);
                if (axEnt && axEnt.type === 'DIRECTION') {
                    const match = axEnt.args.match(/\(([^)]+)\)/);
                    if (match) { const c = match[1].split(',').map(Number); axis = { dx: c[0], dy: c[1], dz: c[2] }; }
                }
                // ref direction
                if (apRefs[2]) {
                    const rdEnt = entities.get(apRefs[2]);
                    if (rdEnt && rdEnt.type === 'DIRECTION') {
                        const match = rdEnt.args.match(/\(([^)]+)\)/);
                        if (match) { const c = match[1].split(',').map(Number); refDir = { dx: c[0], dy: c[1], dz: c[2] }; }
                    }
                }
            }
            // Extract radius from args
            const numMatch = ent.args.match(/,\s*([\d.eE+-]+)\s*\)/);
            const radius = numMatch ? parseFloat(numMatch[1]) : null;
            surfaces.push({ id, type: ent.type, origin, axis, refDir, radius });
        }
    }

    return { vertices, points, surfaces, entities };
}

function hexDump(buf, offset, len) {
    const start = Math.max(0, offset);
    const end = Math.min(buf.length, offset + len);
    const lines = [];
    for (let off = start; off < end; off += 32) {
        const slice = buf.subarray(off, Math.min(off + 32, end));
        const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = [...slice].map(b => b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.').join('');
        lines.push(`  ${off.toString(16).padStart(6, '0')}: ${hex.padEnd(96)}  ${ascii}`);
    }
    return lines.join('\n');
}

function findTripletInPS(ps, x, y, z) {
    const xNeedle = float64BEbytes(x);
    const yNeedle = float64BEbytes(y);
    const zNeedle = float64BEbytes(z);
    const results = [];
    let idx = 0;
    while ((idx = ps.indexOf(xNeedle, idx)) >= 0) {
        if (idx + 24 <= ps.length &&
            ps.subarray(idx + 8, idx + 16).equals(yNeedle) &&
            ps.subarray(idx + 16, idx + 24).equals(zNeedle)) {
            results.push(idx);
        }
        idx++;
    }
    return results;
}

// ── Process all models ──────────────────────────────────────────────────────

const models = [
    {
        name: 'ctc_01',
        stp: join(stpDir, 'CTC Definitions', 'nist_ctc_01_asme1_rd.stp'),
        sld: join(sldDir, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT'),
    },
    {
        name: 'ctc_03',
        stp: join(stpDir, 'CTC Definitions', 'nist_ctc_03_asme1_rc.stp'),
        sld: join(sldDir, 'nist_ctc_03_asme1_rc_sw1802.SLDPRT'),
    },
    {
        name: 'ftc_06',
        stp: join(stpDir, 'FTC Definitions', 'nist_ftc_06_asme1_rd.stp'),
        sld: join(sldDir, 'nist_ftc_06_asme1_rd_sw1802.SLDPRT'),
    },
];

for (const model of models) {
    console.log(`\n${'═'.repeat(80)}`);
    console.log(`MODEL: ${model.name}`);
    console.log(`${'═'.repeat(80)}`);

    const stepUnit = detectStepUnit(model.stp);
    const step = parseStepForModel(model.stp);
    const ps = getLargestPS(model.sld);
    
    // Find =p/=q markers
    const markers = [];
    for (let i = 0; i < ps.length - 1; i++) {
        if (ps[i] === 0x3d && (ps[i + 1] === 0x70 || ps[i + 1] === 0x71))
            markers.push(i);
    }

    console.log(`  STEP unit: ${stepUnit.unit} (×${stepUnit.toMeters} → meters)`);
    console.log(`  STEP vertices: ${step.vertices.length}, surfaces: ${step.surfaces.length}`);
    console.log(`  PS buffer: ${ps.length} bytes, markers: ${markers.length}`);

    // Try all scale factors to find triplets
    console.log(`\n  Scale factor search:`);
    const scales = [
        ['÷1000 (mm→m)', 0.001],
        ['×0.0254 (in→m)', 0.0254],
        ['÷1 (raw)', 1.0],
        ['×0.001 (μm→mm?)', 0.001], // just in case
    ];

    let bestScale = 0.001, bestCount = 0;
    for (const [label, toM] of scales) {
        let count = 0;
        for (const v of step.vertices.slice(0, 50)) {
            const hits = findTripletInPS(ps, v.x * toM, v.y * toM, v.z * toM);
            if (hits.length > 0) count++;
        }
        console.log(`    ${label}: ${count} / ${Math.min(50, step.vertices.length)} vertices found`);
        if (count > bestCount) { bestCount = count; bestScale = toM; }
    }
    console.log(`    → Best: ×${bestScale}\n`);

    // Now find ALL vertices with the best scale
    const foundVertices = [];
    for (const v of step.vertices) {
        const hits = findTripletInPS(ps, v.x * bestScale, v.y * bestScale, v.z * bestScale);
        if (hits.length > 0) {
            foundVertices.push({ vertex: v, offsets: hits });
        }
    }
    console.log(`  Found: ${foundVertices.length} / ${step.vertices.length} vertices as exact triplets`);

    // Show first 15 found vertices with context
    console.log(`\n  === VERTEX LOCATIONS (first 15) ===\n`);
    for (const fv of foundVertices.slice(0, 15)) {
        const v = fv.vertex;
        const off = fv.offsets[0];

        // Find containing marker
        let mIdx = -1;
        for (let i = markers.length - 1; i >= 0; i--) {
            if (markers[i] <= off) { mIdx = i; break; }
        }
        const mOff = mIdx >= 0 ? markers[mIdx] : -1;
        const mType = mOff >= 0 ? (ps[mOff + 1] === 0x70 ? '=p' : '=q') : 'none';
        const relOff = mOff >= 0 ? off - mOff : off;

        console.log(`  STEP #${v.id} (${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)}) → PS @0x${off.toString(16)} (marker: ${mType}, +${relOff})`);
        // Show 24 bytes before and 32 bytes after
        console.log(hexDump(ps, off - 24, 72));

        // Extract the entity header before the coordinates
        // Pattern seen in ctc_01: [00] [type:1] [id:2] [00 00] [ref:2] [00 01] [ref1:2] [ref2:2] [ref3:2] [x:8] [y:8] [z:8]
        if (off >= 16) {
            const preBytes = ps.subarray(off - 16, off);
            const typeByte = preBytes[1]; // assuming [00] [type] at -16
            const id = preBytes.readUInt16BE(2);
            console.log(`    Pre-triplet: type=0x${typeByte.toString(16)} id=${id}`);
        }
        console.log('');
    }

    // Analyze gaps between consecutive vertex offsets
    if (foundVertices.length > 3) {
        const sorted = [...foundVertices].sort((a, b) => a.offsets[0] - b.offsets[0]);
        console.log(`  === INTER-VERTEX STRUCTURE ===\n`);
        for (let i = 0; i < Math.min(10, sorted.length - 1); i++) {
            const curr = sorted[i].offsets[0];
            const next = sorted[i + 1].offsets[0];
            const gap = next - (curr + 24);
            console.log(`    #${sorted[i].vertex.id} @0x${curr.toString(16)} → #${sorted[i + 1].vertex.id} @0x${next.toString(16)} : gap=${gap} bytes`);
            if (gap > 0 && gap <= 128) {
                const gapBuf = ps.subarray(curr + 24, next);
                const hex = [...gapBuf].map(b => b.toString(16).padStart(2, '0')).join(' ');
                console.log(`      ${hex}`);
            }
        }
    }

    // Now search for surface origins + axis + normal
    console.log(`\n  === SURFACE LOCATIONS ===\n`);
    let surfFound = 0;
    for (const s of step.surfaces.slice(0, 20)) {
        if (!s.origin) continue;
        const ox = s.origin.x * bestScale, oy = s.origin.y * bestScale, oz = s.origin.z * bestScale;
        const hits = findTripletInPS(ps, ox, oy, oz);
        if (hits.length > 0) {
            surfFound++;
            const off = hits[0];
            // Check if axis direction follows
            let axisMatch = '';
            if (s.axis && off + 48 <= ps.length) {
                const ax = ps.readDoubleBE(off + 24);
                const ay = ps.readDoubleBE(off + 32);
                const az = ps.readDoubleBE(off + 40);
                if (Math.abs(ax - s.axis.dx) < 1e-6 && Math.abs(ay - s.axis.dy) < 1e-6 && Math.abs(az - s.axis.dz) < 1e-6) {
                    axisMatch = ' ✓ axis follows';
                }
            }
            console.log(`    ${s.type} #${s.id} origin=(${s.origin.x.toFixed(2)}, ${s.origin.y.toFixed(2)}, ${s.origin.z.toFixed(2)}) → @0x${off.toString(16)}${axisMatch}${s.radius ? ' r=' + s.radius : ''}`);

            // Show 80 bytes from origin
            console.log(hexDump(ps, off - 16, 96));

            // Try to identify post-origin structure
            if (off + 56 <= ps.length) {
                const postVals = [];
                for (let j = off + 24; j + 8 <= off + 80 && j + 8 <= ps.length; j += 8) {
                    const v = ps.readDoubleBE(j);
                    if (isFinite(v) && Math.abs(v) < 1e6) postVals.push(v.toFixed(6));
                    else postVals.push('NaN/Inf');
                }
                console.log(`    Post-origin float64s: ${postVals.join(', ')}`);
            }
            console.log('');

            if (surfFound >= 10) break;
        }
    }
    console.log(`  Surface origins found: ${surfFound}`);
}
