/**
 * investigate98.mjs — FTC_11 complete surface extraction analysis
 *
 * FTC_11 reference needs: 2 planes (z=-1.5, z=0.425), 2 cylinders
 * (r=16, r=31.5), 2 tori (R=30/r=1.5, R=17.5/r=1.5), 6 faces.
 *
 * Currently extracting: 1 plane (z≈0), 3 cylinders (r=16, r=18.94,
 * r=28.56). The r=18.94 and r=28.56 are torus inner/outer circle
 * radii being misclassified as cylinders. Missing r=31.5 outer cylinder.
 *
 * Goal: Find where the correct geometry lives in the binary and
 * understand why we're extracting wrong surfaces.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const SENT = Buffer.from([0xc2, 0xbc, 0x92, 0x8f, 0x99, 0x6e]);
const SEP = Buffer.from([0x00, 0x01, 0x00, 0x01, 0x00, 0x03]);
const MM = 1000;

function isPS(b) { return b.length > 20 && b[0] === 0x50 && b[1] === 0x53 && b.indexOf('TRANSMIT', 0, 'ascii') >= 0 && b.indexOf('TRANSMIT', 0, 'ascii') < 32; }

function getPS(fp) {
    const buf = readFileSync(fp);
    let best = null, i = 0;
    while ((i = buf.indexOf(SW3D, i)) >= 0) {
        if (i + 26 > buf.length) break;
        const cs = buf.readUInt32LE(i + 14), ds = buf.readUInt32LE(i + 18), nl = buf.readUInt32LE(i + 22);
        if (nl > 0 && nl < 1024 && cs > 4 && cs < buf.length && ds > 4 && ds < 50e6) {
            const po = i + 26 + nl, pe = po + cs;
            if (pe <= buf.length) {
                try {
                    const d = inflateRawSync(buf.subarray(po, pe), { maxOutputLength: ds + 1024 });
                    if (d.length > 28 && d[28] === 0x78) {
                        try { const n = inflateSync(d.subarray(28), { maxOutputLength: 50e6 }); if (isPS(n) && (!best || n.length > best.length)) best = n; } catch { }
                    }
                    if (isPS(d) && (!best || d.length > best.length)) best = d;
                } catch { }
            }
        }
        i++;
    }
    return best;
}

function getEnts(buf) {
    const ents = [], sp = [];
    let i = 0;
    while ((i = buf.indexOf(SENT, i)) >= 0) { sp.push(i); i += SENT.length; }
    for (let i = 0; i < sp.length; i++) {
        const bs = sp[i] + SENT.length, be = (i + 1 < sp.length) ? sp[i + 1] : buf.length;
        const bl = buf.subarray(bs, be);
        if (bl.length < 8) continue;
        const sr = [];
        let s = 0;
        while (true) {
            const si = bl.indexOf(SEP, s);
            if (si < 0) { sr.push(bl.subarray(s)); break; }
            sr.push(bl.subarray(s, si));
            s = si + SEP.length;
        }
        for (let j = 0; j < sr.length; j++) {
            const r = sr[j];
            if (j === 0) {
                if (r.length < 8 || r.readUInt32BE(0) !== 3) continue;
                const t = r[5];
                if (t < 0x0d || t > 0x3f) continue;
                ents.push({ type: t, id: r.readUInt16BE(6), data: r.subarray(8), blockIdx: i, subIdx: j });
            } else {
                if (r.length < 4 || r[0] !== 0) continue;
                const t = r[1];
                if (t < 0x0d || t > 0x3f) continue;
                ents.push({ type: t, id: r.readUInt16BE(2), data: r.subarray(4), blockIdx: i, subIdx: j });
            }
        }
    }
    return ents;
}

function readGeomFloats(data) {
    let best = null;
    for (const m of [0x2b, 0x2d]) {
        let mi = -1;
        while ((mi = data.indexOf(m, mi + 1)) >= 0) {
            if (mi + 9 > data.length) continue;
            const f = [];
            for (let o = mi + 1; o + 8 <= data.length; o += 8) {
                const v = data.readDoubleBE(o);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                f.push(v);
            }
            if (f.length < 3) continue;
            // Score: prefer unit-length direction at floats[3:6]
            let score = f.length;
            if ([7, 8, 11].includes(f.length)) score += 5;
            if (f.length >= 7) {
                const dm = Math.sqrt(f[3] ** 2 + f[4] ** 2 + f[5] ** 2);
                if (dm > 0.5 && dm < 1.5) score += 15;
            }
            if (f.length >= 11 && f[9] > 0 && f[9] < 1e4) score += 10;
            if (!best || score > best.score || (score === best.score && f.length > best.floats.length))
                best = { floats: f, marker: m, mi, score };
        }
    }
    return best;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════
const ps = getPS(join(dir, 'nist_ftc_11_asme1_rb_sw1802.SLDPRT'));
console.log('PS buffer size:', ps.length);

const ents = getEnts(ps);
console.log('Total entities:', ents.length);

// Type distribution
const typeCounts = new Map();
for (const e of ents) typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
console.log('\nEntity type distribution:');
const names = { 0x0d: 'VERTEX?', 0x0e: '?', 0x0f: 'FACE', 0x10: 'EDGE', 0x11: 'SHELL/BODY', 0x12: 'COEDGE', 0x13: 'LOOP', 0x1d: 'POINT', 0x1e: 'SURFACE', 0x1f: 'BSPLINE', 0x20: 'ATTRIB' };
for (const [t, c] of [...typeCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log('  0x' + t.toString(16).padStart(2, '0') + ' (' + (names[t] || '?').padEnd(10) + '): ' + c);
}

// ═══════════════════════════════════════════════════════════════
// Detailed dump of ALL geometry entities (0x1E and 0x1F)
// ═══════════════════════════════════════════════════════════════
console.log('\n=== ALL GEOMETRY ENTITIES ===');
for (const e of ents.filter(x => x.type === 0x1e || x.type === 0x1f)) {
    const tag = e.type === 0x1e ? '0x1E' : '0x1F';
    const r = readGeomFloats(e.data);
    const nf = r ? r.floats.length : 0;
    console.log(`\n${tag} id=${e.id} dataLen=${e.data.length} nFloats=${nf} block=${e.blockIdx} sub=${e.subIdx}`);

    if (r) {
        const f = r.floats;
        console.log(`  marker=0x${r.marker.toString(16)} at offset ${r.mi}`);
        console.log(`  origin: (${(f[0] * MM).toFixed(4)}, ${(f[1] * MM).toFixed(4)}, ${(f[2] * MM).toFixed(4)}) mm`);
        if (f.length >= 6) {
            const dir = f.slice(3, 6);
            const mag = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
            console.log(`  dir:    (${dir.map(v => v.toFixed(6)).join(', ')}) |n|=${mag.toFixed(6)}`);
        }
        if (f.length >= 7) console.log(`  [6]:    ${f[6]} (${(f[6] * MM).toFixed(4)} mm)`);
        if (f.length >= 10) {
            const refdir = f.slice(6, 9);
            console.log(`  refdir: (${refdir.map(v => v.toFixed(6)).join(', ')})`);
            console.log(`  radius: ${(f[9] * MM).toFixed(4)} mm`);
        }
        if (f.length >= 11) console.log(`  semiAngle: ${f[10].toFixed(8)} rad`);
        if (f.length >= 12) console.log(`  extra[11]: ${f[11]} (${(f[11] * MM).toFixed(4)} mm)`);
        if (f.length >= 13) console.log(`  extra[12]: ${f[12]} (${(f[12] * MM).toFixed(4)} mm)`);

        // Classification
        if (nf === 7 || nf === 8) {
            const d = (f[0] * f[3] + f[1] * f[4] + f[2] * f[5]) * MM;
            console.log(`  → CANDIDATE PLANE d=${d.toFixed(4)} mm`);
        } else if (nf >= 11) {
            const radius = f[9] * MM;
            const sa = f[10];
            if (Math.abs(sa) < 1e-6) {
                console.log(`  → CYLINDER r=${radius.toFixed(4)} mm`);
            } else {
                console.log(`  → CONE r=${radius.toFixed(4)} mm semiAngle=${sa.toFixed(6)} rad`);
            }
        }
    }

    // Raw hex dump first 80 bytes
    const hex = e.data.subarray(0, Math.min(80, e.data.length));
    const lines = [];
    for (let row = 0; row < hex.length; row += 32) {
        const slice = hex.subarray(row, Math.min(row + 32, hex.length));
        lines.push('    ' + row.toString().padStart(4) + ': ' + [...slice].map(b => b.toString(16).padStart(2, '0')).join(' '));
    }
    console.log(lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════
// Also scan for r=31.5 (0.0315m) and r=30 (0.030m) in the full buffer
// ═══════════════════════════════════════════════════════════════
console.log('\n=== SCANNING FOR MISSING RADII IN FULL BUFFER ===');
const targets = [
    { name: 'r=31.5mm', val: 0.0315 },
    { name: 'r=30mm (torus R)', val: 0.030 },
    { name: 'r=17.5mm (torus R)', val: 0.0175 },
    { name: 'r=1.5mm (torus r)', val: 0.0015 },
    { name: 'z=-1.5mm', val: -0.0015 },
    { name: 'z=0.425mm', val: 0.000425 },
];
for (const { name, val } of targets) {
    let count = 0;
    const positions = [];
    for (let off = 0; off + 8 <= ps.length; off++) {
        const v = ps.readDoubleBE(off);
        if (Math.abs(v - val) < 1e-10) {
            positions.push(off);
            count++;
        }
    }
    console.log(`  ${name} (${val}): found ${count} times at offsets [${positions.slice(0, 10).join(', ')}${count > 10 ? '...' : ''}]`);
}

// Also scan for the exact vertex positions from reference
console.log('\n=== SCANNING FOR REFERENCE VERTEX POSITIONS ===');
const refVerts = [
    { name: '(0,-16,-1.5)', x: 0, y: -0.016, z: -0.0015 },
    { name: '(0,-16,0)', x: 0, y: -0.016, z: 0 },
    { name: '(0,-31.5,-1.5)', x: 0, y: -0.0315, z: -0.0015 },
    { name: '(0,-31.5,0)', x: 0, y: -0.0315, z: 0 },
];
for (const rv of refVerts) {
    let found = false;
    for (let off = 0; off + 24 <= ps.length; off++) {
        const x = ps.readDoubleBE(off);
        const y = ps.readDoubleBE(off + 8);
        const z = ps.readDoubleBE(off + 16);
        if (Math.abs(x - rv.x) < 1e-8 && Math.abs(y - rv.y) < 1e-8 && Math.abs(z - rv.z) < 1e-8) {
            console.log(`  ${rv.name}: found at offset ${off}`);
            found = true;
            break;
        }
    }
    if (!found) console.log(`  ${rv.name}: NOT FOUND`);
}

// ═══════════════════════════════════════════════════════════════
// Scan POINTS extracted from type-0x1D entities
// ═══════════════════════════════════════════════════════════════
console.log('\n=== TYPE 0x1D POINT ENTITIES ===');
for (const e of ents.filter(x => x.type === 0x1d)) {
    if (e.data.length >= 24) {
        for (let off = 0; off + 24 <= e.data.length; off++) {
            const x = e.data.readDoubleBE(off);
            const y = e.data.readDoubleBE(off + 8);
            const z = e.data.readDoubleBE(off + 16);
            if (isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x) < 1 && Math.abs(y) < 1 && Math.abs(z) < 1) {
                console.log(`  id=${e.id} off=${off}: (${(x * MM).toFixed(4)}, ${(y * MM).toFixed(4)}, ${(z * MM).toFixed(4)}) mm`);
                break;
            }
        }
    }
}

// Also scan for point records using header pattern [00 1D]
console.log('\n=== POINT RECORDS BY HEADER SCAN ===');
let ptCount = 0;
for (let off = 0; off + 40 < ps.length; off++) {
    if (ps[off] !== 0x00 || ps[off + 1] !== 0x1d) continue;
    if (ps[off + 4] !== 0x00 || ps[off + 5] !== 0x00) continue;
    if (ps[off + 8] !== 0x00 || ps[off + 9] !== 0x01) continue;
    const x = ps.readDoubleBE(off + 16);
    const y = ps.readDoubleBE(off + 24);
    const z = ps.readDoubleBE(off + 32);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
    if (Math.abs(x) > 1 || Math.abs(y) > 1 || Math.abs(z) > 1) continue;
    console.log(`  off=${off}: (${(x * MM).toFixed(4)}, ${(y * MM).toFixed(4)}, ${(z * MM).toFixed(4)}) mm`);
    if (++ptCount >= 30) break;
}
