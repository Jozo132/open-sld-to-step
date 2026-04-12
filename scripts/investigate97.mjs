/**
 * investigate97.mjs — FTC_11 detailed geometry entity dump
 *
 * Deep-dives into FTC_11 (worst performer at 27.4%) to inspect all
 * type-0x1D (POINT), type-0x1F (BSPLINE), and type-0x20 (ATTRIB)
 * entities with hex dumps and float extraction. FTC_11 is a simple
 * revolve with only 2 planes + 3 cylinders in the reference.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D = Buffer.from([0x14,0x00,0x06,0x00,0x08,0x00]);
const SENT = Buffer.from([0xc2,0xbc,0x92,0x8f,0x99,0x6e,0x00,0x00]);
const SEP = Buffer.from([0x00,0x01,0x00,0x01,0x00,0x03]);
const MM = 1000;
function isPS(b){return b.length>20&&b[0]===0x50&&b[1]===0x53&&b.indexOf('TRANSMIT',0,'ascii')>=0&&b.indexOf('TRANSMIT',0,'ascii')<32;}
function getPS(fp){const buf=readFileSync(fp);let best=null,i=0;while((i=buf.indexOf(SW3D,i))>=0){if(i+26>buf.length)break;const cs=buf.readUInt32LE(i+14),ds=buf.readUInt32LE(i+18),nl=buf.readUInt32LE(i+22);if(nl>0&&nl<1024&&cs>4&&cs<buf.length&&ds>4&&ds<50e6){const po=i+26+nl,pe=po+cs;if(pe<=buf.length){try{const d=inflateRawSync(buf.subarray(po,pe),{maxOutputLength:ds+1024});if(d.length>28&&d[28]===0x78){try{const n=inflateSync(d.subarray(28),{maxOutputLength:50e6});if(isPS(n)&&(!best||n.length>best.length))best=n;}catch{}}if(isPS(d)&&(!best||d.length>best.length))best=d;}catch{}}}i++;}return best;}
function getEnts(buf){const ents=[],sp=[];let i=0;while((i=buf.indexOf(SENT,i))>=0){sp.push(i);i+=SENT.length;}for(let i=0;i<sp.length;i++){const bs=sp[i]+SENT.length,be=(i+1<sp.length)?sp[i+1]:buf.length,bl=buf.subarray(bs,be);if(bl.length<8)continue;const sr=[];let s=0;while(true){const si=bl.indexOf(SEP,s);if(si<0){sr.push(bl.subarray(s));break;}sr.push(bl.subarray(s,si));s=si+SEP.length;}for(let j=0;j<sr.length;j++){const r=sr[j];if(j===0){if(r.length<8||r.readUInt32BE(0)!==3)continue;const t=r[5];if(t<0x0d||t>0x3f)continue;ents.push({type:t,id:r.readUInt16BE(6),data:r.subarray(8),blockIdx:i,subIdx:j});}else{if(r.length<4||r[0]!==0)continue;const t=r[1];if(t<0x0d||t>0x3f)continue;ents.push({type:t,id:r.readUInt16BE(2),data:r.subarray(4),blockIdx:i,subIdx:j});}}}return ents;}

const ps = getPS(join(dir, 'nist_ftc_11_asme1_rb_sw1802.SLDPRT'));
console.log('PS buffer size:', ps.length);
const ents = getEnts(ps);
console.log('Total entities:', ents.length);

// Type distribution
const typeCounts = new Map();
for (const e of ents) typeCounts.set(e.type, (typeCounts.get(e.type)||0)+1);
console.log('\nEntity type distribution:');
for (const [t,c] of [...typeCounts.entries()].sort((a,b)=>a[0]-b[0])) {
    const names = {0x0d:'VERTEX?',0x0e:'?',0x0f:'FACE',0x10:'EDGE',0x11:'SHELL/BODY',0x12:'COEDGE',0x13:'LOOP',0x1d:'POINT',0x1e:'SURFACE',0x1f:'BSPLINE',0x20:'ATTRIB'};
    console.log('  0x'+t.toString(16).padStart(2,'0')+' ('+( names[t]||'?').padEnd(10)+'): '+c);
}

// Dump ALL type-0x1F entities in detail
console.log('\n=== Type 0x1F (BSPLINE) entities ===');
for (const e of ents.filter(x=>x.type===0x1f)) {
    console.log('\nEntity id='+e.id+' dataLen='+e.data.length+' block='+e.blockIdx+' sub='+e.subIdx);
    console.log('  Raw hex (first 200 bytes):');
    const hex = e.data.subarray(0, Math.min(200, e.data.length));
    for (let row = 0; row < hex.length; row += 32) {
        const slice = hex.subarray(row, Math.min(row+32, hex.length));
        const hexStr = [...slice].map(b=>b.toString(16).padStart(2,'0')).join(' ');
        console.log('    '+row.toString().padStart(4)+': '+hexStr);
    }
    
    // Try reading floats from ALL possible marker positions
    console.log('  Float sequences from all markers:');
    for (const marker of [0x2b, 0x2d]) {
        let mi = -1;
        while ((mi = e.data.indexOf(marker, mi+1)) >= 0) {
            if (mi+9 > e.data.length) continue;
            const floats = [];
            for (let o = mi+1; o+8 <= e.data.length; o += 8) {
                const v = e.data.readDoubleBE(o);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                floats.push(v);
            }
            if (floats.length >= 3) {
                console.log('    marker=0x'+marker.toString(16)+' at offset '+mi+': '+floats.length+' floats');
                // Show floats with mm conversion for first 3 (origin)
                for (let fi = 0; fi < floats.length; fi++) {
                    const mm = (floats[fi] * MM).toFixed(4);
                    console.log('      ['+fi+'] = '+floats[fi].toFixed(8)+' (×1000 = '+mm+' mm)');
                }
            }
        }
    }
}

// Also show all type-0x1D (POINT) entities
console.log('\n=== Type 0x1D (POINT) entities ===');
for (const e of ents.filter(x=>x.type===0x1d)) {
    // Try reading 3 float64 BE from the data
    if (e.data.length >= 24) {
        // scan for 3 consecutive valid floats
        for (let off = 0; off + 24 <= e.data.length; off++) {
            const x = e.data.readDoubleBE(off);
            const y = e.data.readDoubleBE(off+8);
            const z = e.data.readDoubleBE(off+16);
            if (isFinite(x) && isFinite(y) && isFinite(z) && Math.abs(x)<1e3 && Math.abs(y)<1e3 && Math.abs(z)<1e3) {
                const xm=x*MM, ym=y*MM, zm=z*MM;
                if (Math.abs(xm)<200 && Math.abs(ym)<200 && Math.abs(zm)<200) {
                    console.log('  id='+e.id+' off='+off+': ('+xm.toFixed(3)+', '+ym.toFixed(3)+', '+zm.toFixed(3)+') mm');
                    break;
                }
            }
        }
    }
}

// Show type-0x20 (ATTRIB) entities - may contain surface geometry (LIMIT output to avoid flooding terminal)
const attribs = ents.filter(x=>x.type===0x20);
console.log('\n=== Type 0x20 (ATTRIB) entities (showing first 10 of '+attribs.length+') ===');
let attribShown = 0;
for (const e of attribs) {
    if (attribShown++ >= 10) break;
    console.log('\nAttrib id='+e.id+' dataLen='+e.data.length);
    // Try reading floats (limit hits per entity)
    let hits = 0;
    for (const marker of [0x2b, 0x2d]) {
        let mi = -1;
        while ((mi = e.data.indexOf(marker, mi+1)) >= 0) {
            if (hits >= 5) break;
            if (mi+9 > e.data.length) continue;
            const floats = [];
            for (let o = mi+1; o+8 <= e.data.length; o += 8) {
                const v = e.data.readDoubleBE(o);
                if (!isFinite(v) || Math.abs(v) > 1e6) break;
                floats.push(v);
            }
            if (floats.length >= 3) {
                console.log('  marker=0x'+marker.toString(16)+' at '+mi+': '+floats.length+'f = ['+floats.slice(0,15).map(v=>(v*MM).toFixed(2)+'mm').join(', ')+']');
                hits++;
            }
        }
    }
}
