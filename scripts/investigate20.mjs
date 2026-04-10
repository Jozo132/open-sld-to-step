/**
 * investigate20.mjs — Surface and curve type identification
 *
 * Type-30 (CURVE) and type-31 (SURFACE) entities contain float64 parameters.
 * Need to identify: plane normals, cylinder axes/radii, cone angles, etc.
 * 
 * Also: investigate type-16 → type-30/31 cross-references to understand
 * which edges reference which curves, and which faces reference which surfaces.
 *
 * Additionally: find how FACE entities connect to their LOOPS and EDGES.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
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

const SENTINEL = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e, 0x00, 0x00]);

const files = readdirSync(dir).filter(f => /\.sldprt$/i.test(f));
const fname = files.find(f => f.startsWith('nist_ctc_01'));
const ps = getLargestPS(join(dir, fname));
console.log(`File: ${fname}, buffer: ${ps.length} bytes\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// Build a COMPLETE entity map — scan for ALL entity headers
// ═══════════════════════════════════════════════════════════════════════════════

const allEntities = new Map();

// 1. Scan FF-marked entities
for (let off = 0; off < ps.length - 11; off++) {
    if (ps[off + 2] !== 0xFF) continue;
    const type = ps.readUInt16BE(off);
    const id = ps.readUInt16BE(off + 3);
    const z = ps.readUInt16BE(off + 5);
    const flags = ps.readUInt16BE(off + 7);
    const one = ps.readUInt16BE(off + 9);
    if (z !== 0 || one !== 1 || type < 1 || type > 200 || id < 1 || id > 10000) continue;
    if (allEntities.has(id)) continue;
    allEntities.set(id, { type, id, flags, offset: off, format: 'ff', headerSize: 11 });
}

// 2. Scan sentinel-zone type-18 entities  
const sentinels = [];
let si = 0;
while ((si = ps.indexOf(SENTINEL, si)) >= 0 && sentinels.length < 5000) { sentinels.push(si); si++; }

for (const sentOff of sentinels) {
    const off = sentOff - 18;
    if (off < 0) continue;
    const t = ps.readUInt16BE(off);
    const id = ps.readUInt16BE(off + 2);
    const z = ps.readUInt16BE(off + 4);
    const flags = ps.readUInt16BE(off + 6);
    const o = ps.readUInt16BE(off + 8);
    if (t === 18 && z === 0 && o === 1 && id > 0 && id < 10000 && !allEntities.has(id)) {
        allEntities.set(id, { type: t, id, flags, offset: off, format: 'compact', headerSize: 10 });
    }
    // Type-29 in gap
    const gapOff = sentOff + 10; // skip separator (2B) + type marker (2B)... no
    const gapStart = sentOff + 8;
    if (gapStart + 6 <= ps.length) {
        const nt = ps.readUInt16BE(gapStart + 2);
        const gid = ps.readUInt16BE(gapStart + 4);
        const gz = ps.readUInt16BE(gapStart + 6);
        const gf = ps.readUInt16BE(gapStart + 8);
        const go = ps.readUInt16BE(gapStart + 10);
        if (nt === 29 && gz === 0 && go === 1 && gid > 0 && gid < 10000 && !allEntities.has(gid)) {
            allEntities.set(gid, { type: 29, id: gid, flags: gf, offset: gapStart + 2, format: 'compact', headerSize: 10 });
        }
    }
}

// 3. Scan for type-16 entities (sentinel in data)
for (const sentOff of sentinels) {
    const off = sentOff - 10;
    if (off < 0) continue;
    const t = ps.readUInt16BE(off);
    const id = ps.readUInt16BE(off + 2);
    const z = ps.readUInt16BE(off + 4);
    const flags = ps.readUInt16BE(off + 6);
    const o = ps.readUInt16BE(off + 8);
    if (t === 16 && z === 0 && o === 1 && id > 0 && id < 10000 && !allEntities.has(id)) {
        allEntities.set(id, { type: t, id, flags, offset: off, format: 'compact', headerSize: 10, dataOffset: 18 });
    }
}

// 4. Scan for other entity types in the data zone
for (let off = 0; off < ps.length - 10; off++) {
    const t = ps.readUInt16BE(off);
    const id = ps.readUInt16BE(off + 2);
    const z = ps.readUInt16BE(off + 4);
    const flags = ps.readUInt16BE(off + 6);
    const o = ps.readUInt16BE(off + 8);
    if (z !== 0 || o !== 1) continue;
    if (t < 1 || t > 200 || id < 1 || id > 10000) continue;
    if (allEntities.has(id)) continue;
    // Only add if it's a known entity type
    if ([15, 30, 31, 50, 51, 52, 13, 38].includes(t)) {
        allEntities.set(id, { type: t, id, flags, offset: off, format: 'compact', headerSize: 10 });
    }
}

console.log(`Total entities in map: ${allEntities.size}`);

// Group by type
const byType = new Map();
for (const e of allEntities.values()) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(e);
}
for (const [type, ents] of [...byType.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  Type ${type}: ${ents.length} entities`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Deep analysis of type-30 entities (CURVES)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-30 ENTITY DETAILED ANALYSIS (CURVES?) ===\n');

const type30 = byType.get(30) || [];
// Read int16 refs and float64 data from each
for (const e of type30.slice(0, 20)) {
    const dataStart = e.offset + (e.dataOffset || e.headerSize);
    
    // Read first 8 int16 fields
    const fields = [];
    for (let j = 0; j < 8; j++) {
        if (dataStart + j * 2 + 2 <= ps.length) {
            fields.push(ps.readUInt16BE(dataStart + j * 2));
        }
    }
    
    // Read float64 values from offset + 16 onwards (after 4 refs × 2 bytes + optional padding)
    const floats = [];
    // Try different offsets for floats
    for (let fOff = dataStart + 8; fOff < dataStart + 80 && fOff + 8 <= ps.length; fOff += 2) {
        const f = ps.readDoubleBE(fOff);
        if (isFinite(f) && Math.abs(f) < 100 && Math.abs(f) > 1e-15) {
            floats.push({ offset: fOff - dataStart, value: f });
        }
    }
    
    // Get ref types
    const refTypes = fields.slice(0, 4).map(r => {
        const target = allEntities.get(r);
        return target ? `${r}(t${target.type})` : `${r}`;
    });
    
    console.log(`  id=${e.id} flags=0x${e.flags.toString(16)} refs=[${refTypes.join(', ')}]`);
    if (floats.length > 0) {
        console.log(`    Floats: ${floats.map(f => `@+${f.offset}: ${f.value.toFixed(6)}`).join(', ')}`);
    }
    
    // Also dump 1 byte marker right after refs (at dataStart+8)
    if (dataStart + 9 <= ps.length) {
        const markerByte = ps[dataStart + 8];
        const marker2 = ps[dataStart + 9];
        console.log(`    Marker bytes at +8: 0x${markerByte.toString(16)} 0x${marker2.toString(16)}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Deep analysis of type-31 entities (SURFACES?)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-31 ENTITY DETAILED ANALYSIS (SURFACES?) ===\n');

const type31 = byType.get(31) || [];
for (const e of type31.slice(0, 20)) {
    const dataStart = e.offset + (e.dataOffset || e.headerSize);
    
    const fields = [];
    for (let j = 0; j < 8; j++) {
        if (dataStart + j * 2 + 2 <= ps.length) fields.push(ps.readUInt16BE(dataStart + j * 2));
    }
    
    const floats = [];
    for (let fOff = dataStart + 8; fOff < dataStart + 80 && fOff + 8 <= ps.length; fOff += 2) {
        const f = ps.readDoubleBE(fOff);
        if (isFinite(f) && Math.abs(f) < 100 && Math.abs(f) > 1e-15) {
            floats.push({ offset: fOff - dataStart, value: f });
        }
    }
    
    const refTypes = fields.slice(0, 4).map(r => {
        const target = allEntities.get(r);
        return target ? `${r}(t${target.type})` : `${r}`;
    });
    
    console.log(`  id=${e.id} flags=0x${e.flags.toString(16)} refs=[${refTypes.join(', ')}]`);
    if (floats.length > 0) {
        console.log(`    Floats: ${floats.map(f => `@+${f.offset}: ${f.value.toFixed(6)}`).join(', ')}`);
    }
    
    if (dataStart + 10 <= ps.length) {
        const mb = ps[dataStart + 8];
        const m2 = ps[dataStart + 9];
        console.log(`    Marker bytes at +8: 0x${mb.toString(16)} 0x${m2.toString(16)}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Type-16 → type-30/31 reference chain
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-16 → CURVE/SURFACE REFERENCE CHAIN ===\n');

// For each type-16 entity, find which type-30/31 entities it connects to
const type16 = byType.get(16) || [];
let t16_to_t30 = 0, t16_to_t31 = 0, t16_to_unknown = 0;

for (const e of type16) {
    const dataStart = e.offset + (e.dataOffset || e.headerSize);
    const refs = [];
    for (let j = 0; j < 6; j++) {
        if (dataStart + j * 2 + 2 <= ps.length) refs.push(ps.readUInt16BE(dataStart + j * 2));
    }
    
    // refs[0]=unknown, refs[1]=prev_t16, refs[2]=next_t16, refs[3]=???, refs[4]=1, refs[5]=1
    const ref3 = refs[3];
    const target = allEntities.get(ref3);
    if (target) {
        if (target.type === 30) t16_to_t30++;
        else if (target.type === 31) t16_to_t31++;
        else t16_to_unknown++;
    } else {
        t16_to_unknown++;
    }
}

console.log(`Type-16 refs[3] → type-30: ${t16_to_t30}`);
console.log(`Type-16 refs[3] → type-31: ${t16_to_t31}`);
console.log(`Type-16 refs[3] → unknown: ${t16_to_unknown}`);

// Also check refs[0]
let t16_ref0_types = new Map();
for (const e of type16) {
    const dataStart = e.offset + (e.dataOffset || e.headerSize);
    const ref0 = ps.readUInt16BE(dataStart);
    const target = allEntities.get(ref0);
    const tType = target ? `t${target.type}` : '?';
    t16_ref0_types.set(tType, (t16_ref0_types.get(tType) || 0) + 1);
}
console.log('\nType-16 refs[0] type distribution:');
for (const [t, c] of [...t16_ref0_types.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Type-18 → type-16 connection: does ref[0] of type-18 point to type-16?
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-18 (COEDGE) ref[0] ANALYSIS ===\n');

const type18 = byType.get(18) || [];
const t18_ref0_types = new Map();
for (const e of type18) {
    const dataStart = e.offset + e.headerSize;
    const ref0 = ps.readUInt16BE(dataStart);
    const target = allEntities.get(ref0);
    const tType = target ? `t${target.type}` : '?';
    t18_ref0_types.set(tType, (t18_ref0_types.get(tType) || 0) + 1);
}
console.log('Type-18 ref[0] type distribution:');
for (const [t, c] of [...t18_ref0_types.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${c}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Type-15 entity analysis — what are they?
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-15 ENTITY ANALYSIS ===\n');

const type15 = byType.get(15) || [];
console.log(`Type 15 entities: ${type15.length}`);

// Read a longer field list for type-15
for (const e of type15.slice(0, 10)) {
    const dataStart = e.offset + e.headerSize;
    const fields = [];
    for (let j = 0; j < 14; j++) {
        if (dataStart + j * 2 + 2 <= ps.length) fields.push(ps.readUInt16BE(dataStart + j * 2));
    }
    
    // Annotate with types
    const refTypes = fields.map(r => {
        const target = allEntities.get(r);
        return target ? `${r}(t${target.type})` : `${r}`;
    });
    
    console.log(`  id=${e.id} flags=0x${e.flags.toString(16)}`);
    console.log(`    Fields: [${refTypes.join(', ')}]`);
}

// Check: do type-15 entities reference type-18 (coedge) entities?
let t15_to_t18 = 0;
for (const e of type15) {
    const dataStart = e.offset + e.headerSize;
    for (let j = 0; j < 14; j++) {
        const ref = ps.readUInt16BE(dataStart + j * 2);
        const target = allEntities.get(ref);
        if (target && target.type === 18) { t15_to_t18++; break; }
    }
}
console.log(`\nType-15 entities referencing type-18 (coedge): ${t15_to_t18}/${type15.length}`);

// ═══════════════════════════════════════════════════════════════════════════════
// Surface classification: analyze float64 patterns in type-31
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== SURFACE CLASSIFICATION ATTEMPT ===\n');

// A PLANE has: origin (3 floats) + normal (3 floats) = 6 floats
// A CYLINDER has: origin (3) + axis (3) + radius (1) = 7 floats
// A CONE has: origin (3) + axis (3) + half_angle (1) = 7 floats
// A SPHERE has: center (3) + radius (1) = 4 floats
// A TORUS has: center (3) + axis (3) + major_radius + minor_radius = 8 floats

// Classify type-31 entities by number of float64 values detected
const floatCounts = new Map();
for (const e of type31) {
    const dataStart = e.offset + (e.dataOffset || e.headerSize) + 8; // skip refs
    const markerByte = ps[dataStart];
    
    let floatCount = 0;
    for (let fOff = dataStart + 2; fOff + 8 <= ps.length && fOff < dataStart + 80; fOff += 8) {
        const f = ps.readDoubleBE(fOff);
        if (isFinite(f) && Math.abs(f) < 1e6) floatCount++;
        else break;
    }
    
    const key = `marker=0x${markerByte.toString(16)} floats=${floatCount}`;
    floatCounts.set(key, (floatCounts.get(key) || 0) + 1);
}
console.log('Type-31 marker + float count patterns:');
for (const [k, v] of [...floatCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v} entities`);
}

// Same for type-30
const floatCounts30 = new Map();
for (const e of type30) {
    const dataStart = e.offset + (e.dataOffset || e.headerSize) + 8;
    const markerByte = ps[dataStart];
    
    let floatCount = 0;
    for (let fOff = dataStart + 2; fOff + 8 <= ps.length && fOff < dataStart + 80; fOff += 8) {
        const f = ps.readDoubleBE(fOff);
        if (isFinite(f) && Math.abs(f) < 1e6) floatCount++;
        else break;
    }
    
    const key = `marker=0x${markerByte.toString(16)} floats=${floatCount}`;
    floatCounts30.set(key, (floatCounts30.get(key) || 0) + 1);
}
console.log('\nType-30 marker + float count patterns:');
for (const [k, v] of [...floatCounts30.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v} entities`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Show some type-31 entities with many floats (likely complex surfaces)
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n=== TYPE-31 ENTITIES WITH MOST FLOAT DATA ===\n');

const t31analyzed = type31.map(e => {
    const dataStart = e.offset + (e.dataOffset || e.headerSize) + 8;
    const marker = ps[dataStart];
    const marker2 = ps[dataStart + 1];
    
    const floats = [];
    for (let fOff = dataStart + 2; fOff + 8 <= ps.length && fOff < dataStart + 120; fOff += 8) {
        const f = ps.readDoubleBE(fOff);
        if (isFinite(f) && Math.abs(f) < 1e6) floats.push(f);
        else break;
    }
    
    return { ...e, marker, marker2, floats };
}).sort((a, b) => b.floats.length - a.floats.length);

for (const e of t31analyzed.slice(0, 15)) {
    // Look for patterns:
    // If 3 floats are close to ±1,0,0 : axis-aligned normal
    // If last float is a radius value: cylinder/cone/sphere
    const f = e.floats;
    let surfType = '?';
    
    if (f.length >= 6) {
        // Check if last 3 floats form a unit vector (normal/axis)
        const nx = f[3], ny = f[4], nz = f[5];
        const mag = Math.sqrt(nx*nx + ny*ny + nz*nz);
        if (Math.abs(mag - 1.0) < 0.01) {
            if (f.length === 6) surfType = 'PLANE';
            else if (f.length === 7) surfType = `CYLINDER(r=${f[6].toFixed(4)})`;
            else if (f.length >= 8) surfType = `CONE/TORUS`;
        }
    }
    
    console.log(`  id=${e.id} marker=0x${e.marker.toString(16)},0x${e.marker2.toString(16)} ${surfType}`);
    console.log(`    ${f.length} floats: ${f.map(v => v.toFixed(6)).join(', ')}`);
}
