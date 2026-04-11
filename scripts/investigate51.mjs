/**
 * investigate51.mjs — True entity census by scanning for [00 03 00 TYPE] patterns
 * vs extractAllEntities sentinel-based parsing. Discover the real layout.
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const { SldprtContainerParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'SldprtContainerParser.js')).href
);

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const sldprtPath = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');
const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const psBuf = result.data;

// Method 1: Count by [00 03 00 TYPE] pattern (from getEntityCensus)
const typeNames = {
    0x0d: 'BODY/RGN', 0x0e: 'LUMP', 0x0f: 'FACE', 0x10: 'EDGE',
    0x11: 'SHELL', 0x12: 'COEDGE', 0x13: 'LOOP', 0x15: 'VERTEX',
    0x1d: 'POINT', 0x1e: 'CURVE', 0x1f: 'SURFACE',
    0x20: 'type0x20', 0x26: 'type0x26', 0x32: 'GEOM50', 0x33: 'GEOM51',
};

console.log('=== Method 1: [00 03 00 TYPE] pattern scan ===');
const countByType = {};
const posByType = {};
for (let i = 0; i < psBuf.length - 3; i++) {
    if (psBuf[i] === 0x00 && psBuf[i + 1] === 0x03 && psBuf[i + 2] === 0x00) {
        const type = psBuf[i + 3];
        if (type < 0x0d || type > 0x3f) continue;
        const name = typeNames[type] || `0x${type.toString(16)}`;
        countByType[name] = (countByType[name] || 0) + 1;
        if (!posByType[name]) posByType[name] = [];
        posByType[name].push(i);
    }
}
Object.entries(countByType).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n}: ${c}`));

// Method 2: Count by [00 TYPE] where TYPE is known, with broader scanning
console.log('\n=== Method 2: ID extraction for type-0x0F (FACE) ===');
const facePositions = posByType['FACE'] || [];
console.log(`FACE entities found at ${facePositions.length} positions`);
for (let fi = 0; fi < Math.min(30, facePositions.length); fi++) {
    const pos = facePositions[fi];
    // Pattern: [00 03 00 0F] [id_hi id_lo]
    const id = psBuf.readUInt16BE(pos + 4);
    // Read next 20 bytes for context
    const hexCtx = [];
    for (let j = 0; j < 20 && pos + j < psBuf.length; j++) {
        hexCtx.push(psBuf[pos + j].toString(16).padStart(2, '0'));
    }
    // Read uint16 refs after id (starting at pos+6)
    const refs = [];
    for (let j = 6; j < 30 && pos + j + 2 <= psBuf.length; j += 2) {
        refs.push(psBuf.readUInt16BE(pos + j));
    }
    console.log(`  pos=${pos} id=${id} refs=[${refs.slice(0, 8).join(',')}]`);
}

// Method 3: Analyze the interval between sentinels
console.log('\n=== Sentinel intervals ===');
const sentPositions = [];
let idx = 0;
while ((idx = psBuf.indexOf(SENTINEL, idx)) >= 0) {
    sentPositions.push(idx);
    idx += SENTINEL.length;
}
console.log(`Total sentinels: ${sentPositions.length}`);

// Show type markers around each sentinel
console.log('\n=== Entity types AROUND sentinels (pattern: [00 03 00 TYPE] near sentinel) ===');
for (let si = 0; si < Math.min(20, sentPositions.length); si++) {
    const sentPos = sentPositions[si];
    
    // Look for [00 03 00 TYPE] within 200 bytes BEFORE sentinel
    const markers = [];
    for (let j = Math.max(0, sentPos - 200); j < sentPos; j++) {
        if (psBuf[j] === 0x00 && psBuf[j+1] === 0x03 && psBuf[j+2] === 0x00) {
            const t = psBuf[j+3];
            if (t >= 0x0d && t <= 0x3f) {
                const id = psBuf.readUInt16BE(j + 4);
                markers.push(`${typeNames[t]||'0x'+t.toString(16)}#${id}@-${sentPos-j}`);
            }
        }
    }
    // And within 100 bytes AFTER sentinel
    for (let j = sentPos + 6; j < Math.min(psBuf.length - 3, sentPos + 100); j++) {
        if (psBuf[j] === 0x00 && psBuf[j+1] === 0x03 && psBuf[j+2] === 0x00) {
            const t = psBuf[j+3];
            if (t >= 0x0d && t <= 0x3f) {
                const id = psBuf.readUInt16BE(j + 4);
                markers.push(`${typeNames[t]||'0x'+t.toString(16)}#${id}@+${j-sentPos}`);
            }
        }
    }
    
    console.log(`  Sentinel ${si} @${sentPos}: ${markers.join(', ')}`);
}

// Analyze EDGE entity layout (type 0x10)
console.log('\n=== EDGE entity analysis (type 0x10) ===');
const edgePositions = posByType['EDGE'] || [];
console.log(`EDGE [00 03 00 10] positions: ${edgePositions.length}`);
for (let i = 0; i < Math.min(10, edgePositions.length); i++) {
    const pos = edgePositions[i];
    const id = psBuf.readUInt16BE(pos + 4);
    
    // Read 30 bytes of data after the header
    const data = [];
    for (let j = 0; j < 60 && pos + j < psBuf.length; j++) {
        data.push(psBuf[pos + j].toString(16).padStart(2, '0'));
    }
    
    // Check distance to nearest sentinel
    let nearestSent = -1;
    for (const sp of sentPositions) {
        if (sp >= pos && (nearestSent < 0 || sp < nearestSent)) {
            nearestSent = sp;
            break;
        }
    }
    
    console.log(`  EDGE #${id} @${pos} (sent@${nearestSent}, dist=${nearestSent-pos})`);
    console.log(`    ${data.join(' ')}`);
}

// Analyze COEDGE entity layout (type 0x12)
console.log('\n=== COEDGE entity analysis (type 0x12) ===');
const coedgePositions = posByType['COEDGE'] || [];
console.log(`COEDGE [00 03 00 12] positions: ${coedgePositions.length}`);
for (let i = 0; i < Math.min(10, coedgePositions.length); i++) {
    const pos = coedgePositions[i];
    const id = psBuf.readUInt16BE(pos + 4);
    
    const data = [];
    for (let j = 0; j < 40 && pos + j < psBuf.length; j++) {
        data.push(psBuf[pos + j].toString(16).padStart(2, '0'));
    }
    
    let nearestSent = -1;
    for (const sp of sentPositions) {
        if (sp >= pos && (nearestSent < 0 || sp < nearestSent)) {
            nearestSent = sp;
            break;
        }
    }
    
    console.log(`  COEDGE #${id} @${pos} (sent@${nearestSent}, dist=${nearestSent-pos})`);
    console.log(`    ${data.join(' ')}`);
}

// Histogram of entity type near sentinels
console.log('\n=== Type of entity that BEGINS each sentinel block ===');
const firstTypeAfterSent = {};
for (const sp of sentPositions) {
    // Look for [00 03 00 TYPE] immediately or within 50 bytes after sentinel
    for (let j = sp + 6; j < sp + 50 && j < psBuf.length - 3; j++) {
        if (psBuf[j] === 0x00 && psBuf[j+1] === 0x03 && psBuf[j+2] === 0x00) {
            const t = psBuf[j+3];
            if (t >= 0x0d && t <= 0x3f) {
                const name = typeNames[t] || `0x${t.toString(16)}`;
                firstTypeAfterSent[name] = (firstTypeAfterSent[name] || 0) + 1;
                break;
            }
        }
    }
}
Object.entries(firstTypeAfterSent).sort((a, b) => b[1] - a[1]).forEach(([n, c]) => console.log(`  ${n}: ${c}`));

// Look for FF-marked entities
console.log('\n=== FF-marked entities (0xFF after type code) ===');
for (let i = 0; i < psBuf.length - 5; i++) {
    if (psBuf[i] === 0x00 && psBuf[i+2] === 0xff) {
        const type = psBuf[i+1];
        if (type >= 0x0d && type <= 0x3f) {
            const id = psBuf.readUInt16BE(i + 3);
            const name = typeNames[type] || `0x${type.toString(16)}`;
            console.log(`  FF: ${name} #${id} @${i}`);
        }
    }
}
