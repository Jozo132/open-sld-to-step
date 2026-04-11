/**
 * investigate38.mjs — Discriminate LINE from PLANE in 7-float geometry entities
 *
 * The key question: what byte(s) in the entity data distinguish a LINE curve
 * from a PLANE surface? Both have 7 floats after the 0x2B marker.
 *
 * All observations derived from publicly available NIST MBE PMI test files
 * (U.S. Government works, public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const refDir = path.join(ROOT, 'downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');

const sldprtPath = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');
const refStepPath = path.join(refDir, 'nist_ctc_01_asme1_rd.stp');

const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const psBuf = result.data;

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SUB_SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);

// Parse all geometry entities
const sents = [];
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) { sents.push(idx); idx += 6; }

const geomEntities = [];
for (let i = 0; i < sents.length; i++) {
    const blockStart = sents[i] + 6;
    const blockEnd = (i + 1 < sents.length) ? sents[i + 1] : psBuf.length;
    const block = psBuf.subarray(blockStart, blockEnd);
    if (block.length < 8) continue;

    // Get primary entity type
    let primaryType = -1;
    if (block.readUInt32BE(0) === 3) primaryType = block[5];

    const recs = [];
    let ss = 0;
    while (true) {
        const sepIdx = block.indexOf(SUB_SEP, ss);
        if (sepIdx < 0) { recs.push(block.subarray(ss)); break; }
        recs.push(block.subarray(ss, sepIdx));
        ss = sepIdx + 6;
    }

    for (let si = 0; si < recs.length; si++) {
        const rec = recs[si];
        let type, id, data;
        if (si === 0) {
            if (rec.length < 8 || rec.readUInt32BE(0) !== 3) continue;
            type = rec[5]; id = rec.readUInt16BE(6); data = rec.subarray(8);
        } else {
            if (rec.length < 4 || rec[0] !== 0x00) continue;
            type = rec[1]; id = rec.readUInt16BE(2); data = rec.subarray(4);
        }
        if (type !== 0x1e && type !== 0x1f) continue;

        const markerIdx = data.indexOf(0x2b);
        if (markerIdx < 0) continue;

        const floatStart = markerIdx + 1;
        const floats = [];
        for (let off = floatStart; off + 8 <= data.length; off += 8) {
            const val = data.readDoubleBE(off);
            if (!isFinite(val) || Math.abs(val) > 1e6) break;
            floats.push(val);
        }

        // Get bytes BEFORE the 0x2B marker
        const preBytesLen = Math.min(markerIdx, 20);
        const preBytes = data.subarray(markerIdx - preBytesLen, markerIdx);

        geomEntities.push({
            type, id, nFloats: floats.length, floats,
            primaryType, subIdx: si,
            preBytes: [...preBytes],
            preByte: markerIdx > 0 ? data[markerIdx - 1] : -1,
            pre2Byte: markerIdx > 1 ? data[markerIdx - 2] : -1,
            dataLen: data.length,
            markerIdx,
        });
    }
}

console.log(`Total geometry entities: ${geomEntities.length}`);
const byFloats = {};
for (const e of geomEntities) {
    byFloats[e.nFloats] = (byFloats[e.nFloats] || 0) + 1;
}
console.log('By float count:', byFloats);

// ── Focus on 7-float entities: LINE vs PLANE ──
const sevenFloat = geomEntities.filter(e => e.nFloats === 7);
console.log(`\n=== 7-float entities: ${sevenFloat.length} ===`);

// Check the byte immediately before 0x2B
const preByteDistrib = {};
for (const e of sevenFloat) {
    const key = `0x${e.preByte.toString(16).padStart(2, '0')}`;
    preByteDistrib[key] = (preByteDistrib[key] || 0) + 1;
}
console.log('Byte before 0x2B:', preByteDistrib);

// Check 2 bytes before 0x2B  
const pre2ByteDistrib = {};
for (const e of sevenFloat) {
    const key = `0x${e.pre2Byte.toString(16).padStart(2, '0')}`;
    pre2ByteDistrib[key] = (pre2ByteDistrib[key] || 0) + 1;
}
console.log('2 bytes before 0x2B:', pre2ByteDistrib);

// Check markerIdx (offset of 0x2B within entity data)
const markerIdxDistrib = {};
for (const e of sevenFloat) {
    markerIdxDistrib[e.markerIdx] = (markerIdxDistrib[e.markerIdx] || 0) + 1;
}
console.log('0x2B offset within data:', markerIdxDistrib);

// Show pre-bytes patterns
console.log('\nFirst 10 with pre-bytes:');
for (const e of sevenFloat.slice(0, 10)) {
    const preHex = e.preBytes.map(b => b.toString(16).padStart(2, '0')).join(' ');
    const dir = `(${e.floats[3].toFixed(4)}, ${e.floats[4].toFixed(4)}, ${e.floats[5].toFixed(4)})`;
    console.log(`  id=${e.id} marker@${e.markerIdx} pre=[${preHex}] dir=${dir} f6=${e.floats[6].toFixed(6)}`);
}

// ── Now also check 11-float entities for comparison ──
const elevenFloat = geomEntities.filter(e => e.nFloats === 11);
console.log(`\n=== 11-float entities: ${elevenFloat.length} ===`);
const pre11 = {};
for (const e of elevenFloat) {
    const key = `0x${e.preByte.toString(16).padStart(2, '0')}`;
    pre11[key] = (pre11[key] || 0) + 1;
}
console.log('Byte before 0x2B:', pre11);
const markerIdx11 = {};
for (const e of elevenFloat) {
    markerIdx11[e.markerIdx] = (markerIdx11[e.markerIdx] || 0) + 1;
}
console.log('0x2B offset within data:', markerIdx11);

// ── Try to match with reference STEP to find discriminator ──
const refStep = fs.readFileSync(refStepPath, 'utf-8');

// Extract reference plane origins and normals
const refEntMap = new Map();
for (const line of refStep.split('\n')) {
    const m = line.match(/^#(\d+)=(.+);$/);
    if (m) refEntMap.set(parseInt(m[1]), m[2]);
}

// Get reference plane axes (normals + origins)
const refPlaneData = [];
for (const [id, val] of refEntMap) {
    if (!val.startsWith('PLANE(')) continue;
    // PLANE('',#axisRef)
    const axisMatch = val.match(/#(\d+)/);
    if (!axisMatch) continue;
    const axisId = parseInt(axisMatch[1]);
    const axisDef = refEntMap.get(axisId);
    if (!axisDef) continue;
    // AXIS2_PLACEMENT_3D('',#ptRef,#dirRef,#refDir)
    const refs = [...axisDef.matchAll(/#(\d+)/g)].map(m => parseInt(m[1]));
    if (refs.length < 2) continue;
    
    const ptDef = refEntMap.get(refs[0]);
    const dirDef = refEntMap.get(refs[1]);
    if (!ptDef || !dirDef) continue;
    
    // Parse CARTESIAN_POINT coords
    const ptMatch = ptDef.match(/\(([-\d.eE+]+),([-\d.eE+]+),([-\d.eE+]+)\)/);
    const dirMatch = dirDef.match(/\(([-\d.eE+]+),([-\d.eE+]+),([-\d.eE+]+)\)/);
    if (!ptMatch || !dirMatch) continue;
    
    refPlaneData.push({
        origin: [parseFloat(ptMatch[1]), parseFloat(ptMatch[2]), parseFloat(ptMatch[3])],
        normal: [parseFloat(dirMatch[1]), parseFloat(dirMatch[2]), parseFloat(dirMatch[3])],
    });
}
console.log(`\nReference planes: ${refPlaneData.length}`);

// For each 7-float PS entity, check if its normal matches any reference plane normal
// (normals are unit vectors, so exact match should work)
let planeMatches = 0;
let lineMatches = 0;
const matchedMarkerIdx = { plane: {}, line: {} };

for (const e of sevenFloat) {
    const psNormal = [e.floats[3], e.floats[4], e.floats[5]];
    const psOrigin = [e.floats[0] * 1000, e.floats[1] * 1000, e.floats[2] * 1000]; // to mm
    
    // Check if normal matches any reference plane
    let isPlane = false;
    for (const rp of refPlaneData) {
        // Check normal alignment (same or opposite direction)
        const dot = psNormal[0]*rp.normal[0] + psNormal[1]*rp.normal[1] + psNormal[2]*rp.normal[2];
        if (Math.abs(Math.abs(dot) - 1.0) < 0.01) {
            // Check if point is ON the reference plane (perpendicular distance ≈ 0)
            const dx = psOrigin[0] - rp.origin[0];
            const dy = psOrigin[1] - rp.origin[1];
            const dz = psOrigin[2] - rp.origin[2];
            const dist = Math.abs(dx*rp.normal[0] + dy*rp.normal[1] + dz*rp.normal[2]);
            if (dist < 0.1) {
                isPlane = true;
                break;
            }
        }
    }
    
    if (isPlane) {
        planeMatches++;
        matchedMarkerIdx.plane[e.markerIdx] = (matchedMarkerIdx.plane[e.markerIdx] || 0) + 1;
    } else {
        lineMatches++;
        matchedMarkerIdx.line[e.markerIdx] = (matchedMarkerIdx.line[e.markerIdx] || 0) + 1;
    }
}

console.log(`\n7-float entities matching reference planes: ${planeMatches}`);
console.log(`7-float entities NOT matching (likely LINEs): ${lineMatches}`);
console.log('Marker offset for PLANEs:', matchedMarkerIdx.plane);
console.log('Marker offset for LINEs:', matchedMarkerIdx.line);

// ── Check pre-bytes for PLANEs vs LINEs ──
console.log('\n--- Pre-byte analysis for identified PLANEs vs LINEs ---');
const planePreBytes = {};
const linePreBytes = {};

for (const e of sevenFloat) {
    const psNormal = [e.floats[3], e.floats[4], e.floats[5]];
    const psOrigin = [e.floats[0] * 1000, e.floats[1] * 1000, e.floats[2] * 1000];
    
    let isPlane = false;
    for (const rp of refPlaneData) {
        const dot = psNormal[0]*rp.normal[0] + psNormal[1]*rp.normal[1] + psNormal[2]*rp.normal[2];
        if (Math.abs(Math.abs(dot) - 1.0) < 0.01) {
            const dx = psOrigin[0] - rp.origin[0];
            const dy = psOrigin[1] - rp.origin[1];
            const dz = psOrigin[2] - rp.origin[2];
            const dist = Math.abs(dx*rp.normal[0] + dy*rp.normal[1] + dz*rp.normal[2]);
            if (dist < 0.1) { isPlane = true; break; }
        }
    }
    
    const preHex = e.preBytes.slice(-6).map(b => b.toString(16).padStart(2, '0')).join(' ');
    const bucket = isPlane ? planePreBytes : linePreBytes;
    bucket[preHex] = (bucket[preHex] || 0) + 1;
}

console.log('PLANE pre-6-bytes:');
for (const [k, v] of Object.entries(planePreBytes).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  [${k}]: ${v}`);
}
console.log('LINE pre-6-bytes:');
for (const [k, v] of Object.entries(linePreBytes).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  [${k}]: ${v}`);
}

// ── Check the byte at a specific offset in the entity data ──
console.log('\n--- Byte-by-byte analysis at fixed offsets ---');
for (let checkOff = 0; checkOff < 10; checkOff++) {
    const planeVals = {};
    const lineVals = {};
    
    for (const e of sevenFloat) {
        if (checkOff >= e.markerIdx) continue;
        const val = e.preBytes[e.preBytes.length - e.markerIdx + checkOff];
        if (val === undefined) continue;
        
        const psNormal = [e.floats[3], e.floats[4], e.floats[5]];
        const psOrigin = [e.floats[0] * 1000, e.floats[1] * 1000, e.floats[2] * 1000];
        
        let isPlane = false;
        for (const rp of refPlaneData) {
            const dot = psNormal[0]*rp.normal[0] + psNormal[1]*rp.normal[1] + psNormal[2]*rp.normal[2];
            if (Math.abs(Math.abs(dot) - 1.0) < 0.01) {
                const dx = psOrigin[0] - rp.origin[0];
                const dy = psOrigin[1] - rp.origin[1];
                const dz = psOrigin[2] - rp.origin[2];
                const dist = Math.abs(dx*rp.normal[0] + dy*rp.normal[1] + dz*rp.normal[2]);
                if (dist < 0.1) { isPlane = true; break; }
            }
        }
        
        const hex = `0x${val.toString(16).padStart(2, '0')}`;
        if (isPlane) planeVals[hex] = (planeVals[hex] || 0) + 1;
        else lineVals[hex] = (lineVals[hex] || 0) + 1;
    }
    
    console.log(`  data[${checkOff}]: PLANE=${JSON.stringify(planeVals)}  LINE=${JSON.stringify(lineVals)}`);
}
