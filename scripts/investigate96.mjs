/**
 * investigate96.mjs — Type-0x1F float count census across all NIST files
 *
 * Surveys type-0x1E and type-0x1F entities (surface/curve) in all 11 NIST
 * SolidWorks files, counting float payloads by length. Shows which files
 * store planes in 0x1F vs 0x1E and the distribution of geometry types.
 *
 * Clean-room analysis of public-domain NIST test files.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';
const dir = 'downloads/nist/NIST-FTC-CTC-PMI-CAD-models/SolidWorks MBD 2018';
const SW3D = Buffer.from([0x14,0x00,0x06,0x00,0x08,0x00]);
const SENT = Buffer.from([0xc2,0xbc,0x92,0x8f,0x99,0x6e,0x00,0x00]);
const SEP = Buffer.from([0x00,0x01,0x00,0x01,0x00,0x03]);
const MM = 1000;
function isPS(b){return b.length>20&&b[0]===0x50&&b[1]===0x53&&b.indexOf('TRANSMIT',0,'ascii')>=0&&b.indexOf('TRANSMIT',0,'ascii')<32;}
function getPS(fp){const buf=readFileSync(fp);let best=null,i=0;while((i=buf.indexOf(SW3D,i))>=0){if(i+26>buf.length)break;const cs=buf.readUInt32LE(i+14),ds=buf.readUInt32LE(i+18),nl=buf.readUInt32LE(i+22);if(nl>0&&nl<1024&&cs>4&&cs<buf.length&&ds>4&&ds<50e6){const po=i+26+nl,pe=po+cs;if(pe<=buf.length){try{const d=inflateRawSync(buf.subarray(po,pe),{maxOutputLength:ds+1024});if(d.length>28&&d[28]===0x78){try{const n=inflateSync(d.subarray(28),{maxOutputLength:50e6});if(isPS(n)&&(!best||n.length>best.length))best=n;}catch{}}if(isPS(d)&&(!best||d.length>best.length))best=d;}catch{}}}i++;}return best;}
function getEnts(buf){const ents=[],sp=[];let i=0;while((i=buf.indexOf(SENT,i))>=0){sp.push(i);i+=SENT.length;}for(let i=0;i<sp.length;i++){const bs=sp[i]+SENT.length,be=(i+1<sp.length)?sp[i+1]:buf.length,bl=buf.subarray(bs,be);if(bl.length<8)continue;const sr=[];let s=0;while(true){const si=bl.indexOf(SEP,s);if(si<0){sr.push(bl.subarray(s));break;}sr.push(bl.subarray(s,si));s=si+SEP.length;}for(let j=0;j<sr.length;j++){const r=sr[j];if(j===0){if(r.length<8||r.readUInt32BE(0)!==3)continue;const t=r[5];if(t<0x0d||t>0x3f)continue;ents.push({type:t,id:r.readUInt16BE(6),data:r.subarray(8)});}else{if(r.length<4||r[0]!==0)continue;const t=r[1];if(t<0x0d||t>0x3f)continue;ents.push({type:t,id:r.readUInt16BE(2),data:r.subarray(4)});}}}return ents;}
function gf(data){let best=null;for(const m of[0x2b,0x2d]){let mi=-1;while((mi=data.indexOf(m,mi+1))>=0){if(mi+9>data.length)continue;const f=[];for(let o=mi+1;o+8<=data.length;o+=8){const v=data.readDoubleBE(o);if(!isFinite(v)||Math.abs(v)>1e6)break;f.push(v);}if(f.length<3)continue;if(!best||f.length>best.floats.length||(f.length===best.floats.length&&mi>best.mi))best={floats:f,mi};}}return best;}
const files=readdirSync(dir).filter(f=>f.endsWith('.SLDPRT')).sort();
for(const fn of files){const sn=fn.replace('nist_','').replace('_asme1_',' ').replace('_sw1802.SLDPRT','').toUpperCase();const ps=getPS(join(dir,fn));if(!ps){console.log(sn+': no PS');continue;}const ents=getEnts(ps);const t1E=ents.filter(e=>e.type===0x1e),t1F=ents.filter(e=>e.type===0x1f);console.log('\n'+sn+'  (1E:'+t1E.length+'  1F:'+t1F.length+')');const fc=new Map();for(const e of t1F){const r=gf(e.data);const c=r?r.floats.length:0;fc.set(c,(fc.get(c)||0)+1);}for(const[c,q]of[...fc.entries()].sort((a,b)=>a[0]-b[0])){const tag=(c===7||c===8)?' <-PLANE?':c>=11?' <-CYL':'';console.log('  1F: '+c+'f x'+q+tag);}for(const e of t1F){const r=gf(e.data);if(!r||(r.floats.length!==7&&r.floats.length!==8))continue;const f=r.floats,d=f.slice(3,6),mg=Math.sqrt(d[0]**2+d[1]**2+d[2]**2),dd=(f[0]*d[0]+f[1]*d[1]+f[2]*d[2])*MM;console.log('  PLANE? id='+e.id+' n=('+d.map(v=>v.toFixed(4))+') |n|='+mg.toFixed(4)+' d='+dd.toFixed(2)+'mm');}let sh=0;for(const e of t1F){const r=gf(e.data);if(!r||r.floats.length<11)continue;if(sh++>=20)break;const f=r.floats,rad=(f[9]*MM).toFixed(2),sa=f[10].toFixed(6);console.log('  '+(Math.abs(f[10])<1e-6?'CYL':'CONE')+' id='+e.id+' r='+rad+'mm sa='+sa+' axis=('+f.slice(3,6).map(v=>v.toFixed(4))+')');}if(t1E.length>0){const fc2=new Map();for(const e of t1E){const r=gf(e.data);fc2.set(r?r.floats.length:0,(fc2.get(r?r.floats.length:0)||0)+1);}console.log('  1E: '+[...fc2.entries()].sort((a,b)=>a[0]-b[0]).map(([c,q])=>c+'f:'+q).join(' '));}}
