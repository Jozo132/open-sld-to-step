/**
 * investigate42.mjs — Validate STEP output: check all entity references resolve
 *
 * NIST test files are US Government works (public domain).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const ourPath = path.join(ROOT, 'output', 'nist_ctc_01_asme1_rd_sw1802.stp');
const content = fs.readFileSync(ourPath, 'utf-8');

// Parse all entities
const entityIds = new Set();
const entityRefs = []; // {from, to}

const lines = content.split('\n');
for (const line of lines) {
    const trimmed = line.trim();
    const defMatch = trimmed.match(/^#(\d+)=/);
    if (defMatch) {
        entityIds.add(parseInt(defMatch[1]));
        // Find all #N references in this line
        const refMatches = trimmed.match(/#(\d+)/g);
        if (refMatches) {
            const fromId = parseInt(defMatch[1]);
            for (const ref of refMatches.slice(1)) { // skip the definition itself
                const toId = parseInt(ref.slice(1));
                if (toId !== fromId) { // skip self-refs
                    entityRefs.push({ from: fromId, to: toId });
                }
            }
        }
    }
}

console.log(`Total entities: ${entityIds.size}`);
console.log(`Total references: ${entityRefs.length}`);

// Check for broken references
let broken = 0;
const brokenDetails = [];
for (const ref of entityRefs) {
    if (!entityIds.has(ref.to)) {
        broken++;
        if (brokenDetails.length < 10) {
            brokenDetails.push(`#${ref.from} → #${ref.to} (not found)`);
        }
    }
}

console.log(`Broken references: ${broken}`);
if (brokenDetails.length > 0) {
    console.log('First broken refs:');
    for (const d of brokenDetails) console.log(`  ${d}`);
}

// Verify sequential IDs
const maxId = Math.max(...entityIds);
console.log(`\nID range: 1..${maxId}`);
let gaps = 0;
for (let i = 1; i <= maxId; i++) {
    if (!entityIds.has(i)) gaps++;
}
console.log(`ID gaps: ${gaps}`);

// Summary statistics
const typeCount = {};
for (const line of lines) {
    const m = line.trim().match(/^#\d+=(\w+)\(/);
    if (m) typeCount[m[1]] = (typeCount[m[1]] || 0) + 1;
}
const totalEntities = Object.values(typeCount).reduce((a, b) => a + b, 0);
console.log(`\nTotal entity instances: ${totalEntities}`);
console.log(`File size: ${(content.length / 1024).toFixed(1)} KB`);
