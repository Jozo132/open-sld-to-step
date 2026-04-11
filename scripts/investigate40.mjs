/**
 * investigate40.mjs — Deduplicate planes by equation and build convex boundaries
 *
 * Goals:
 * 1. Group planes by (normal, distance) → count unique planes
 * 2. For each unique plane, collect all vertices → compute 2D convex hull
 * 3. Check if approximate face boundaries are feasible
 * 4. Also parse reference STEP to compare plane equations
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
const { ParasolidParser } = await import(
    pathToFileURL(path.join(ROOT, 'dist', 'parser', 'ParasolidParser.js')).href
);

const NIST_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'SolidWorks MBD 2018');
const sldprtPath = path.join(NIST_DIR, 'nist_ctc_01_asme1_rd_sw1802.SLDPRT');

const buf = fs.readFileSync(sldprtPath);
const result = SldprtContainerParser.extractParasolid(buf);
const parser = new ParasolidParser(result.data);
const model = parser.parse();

const vertices = model.vertices;
const surfaces = model.surfaces;

console.log(`Vertices: ${vertices.length}, Surfaces: ${surfaces.length}`);

// ========== 1. Group planes by equation ==========
const ANGLE_TOL = 0.001;  // radians tolerance for normal comparison
const DIST_TOL = 0.5;     // mm tolerance for perpendicular distance
const PLANE_TOL = 0.5;    // mm tolerance for vertex-on-plane check

const planes = surfaces.filter(s => s.surfaceType === 'plane');
const cylinders = surfaces.filter(s => s.surfaceType === 'cylinder');
console.log(`\nPlanes: ${planes.length}, Cylinders: ${cylinders.length}`);

// Group planes by equation
const planeGroups = [];
for (const plane of planes) {
    const p = plane.params;
    const nx = p.normal.x, ny = p.normal.y, nz = p.normal.z;
    const ox = p.origin.x, oy = p.origin.y, oz = p.origin.z;
    const d = nx * ox + ny * oy + nz * oz; // perpendicular distance from origin
    
    // Find matching group
    let found = false;
    for (const group of planeGroups) {
        const gn = group.normal;
        // Check if normals are parallel (dot product ≈ ±1)
        const dot = nx * gn.x + ny * gn.y + nz * gn.z;
        if (Math.abs(Math.abs(dot) - 1) < ANGLE_TOL) {
            // Check perpendicular distance match
            const sign = dot > 0 ? 1 : -1;
            if (Math.abs(d - sign * group.d) < DIST_TOL) {
                group.members.push(plane);
                found = true;
                break;
            }
        }
    }
    
    if (!found) {
        planeGroups.push({
            normal: { x: nx, y: ny, z: nz },
            d: d,
            members: [plane],
        });
    }
}

console.log(`\n=== Unique plane equations: ${planeGroups.length} (ref: 84) ===`);
const groupSizes = planeGroups.map(g => g.members.length);
const histogram = {};
for (const s of groupSizes) {
    const key = s >= 5 ? '5+' : String(s);
    histogram[key] = (histogram[key] || 0) + 1;
}
console.log('Group size distribution:');
for (const [size, count] of Object.entries(histogram).sort((a,b) => parseInt(a[0]) - parseInt(b[0]))) {
    console.log(`  ${size} members: ${count} groups`);
}

// ========== 2. Associate vertices with unique plane groups ==========
console.log('\n=== Vertex associations per plane group ===');
const groupVertCounts = [];
for (const group of planeGroups) {
    const rep = group.members[0];
    const p = rep.params;
    const nx = p.normal.x, ny = p.normal.y, nz = p.normal.z;
    const ox = p.origin.x, oy = p.origin.y, oz = p.origin.z;
    
    const assocVerts = [];
    for (const v of vertices) {
        const dx = v.position.x - ox;
        const dy = v.position.y - oy;
        const dz = v.position.z - oz;
        const dist = Math.abs(dx * nx + dy * ny + dz * nz);
        if (dist < PLANE_TOL) {
            assocVerts.push(v);
        }
    }
    
    groupVertCounts.push({
        members: group.members.length,
        vertCount: assocVerts.length,
        normal: group.normal,
        d: group.d,
    });
}

// How many plane groups have >= 3 vertices?
const g3plus = groupVertCounts.filter(g => g.vertCount >= 3).length;
const g4plus = groupVertCounts.filter(g => g.vertCount >= 4).length;
console.log(`Plane groups with >= 3 vertices on them: ${g3plus}`);
console.log(`Plane groups with >= 4 vertices on them: ${g4plus}`);

// Show groups sorted by vertex count
groupVertCounts.sort((a, b) => a.vertCount - b.vertCount);
console.log('\nFirst 20 plane groups (lowest vertex count):');
for (const g of groupVertCounts.slice(0, 20)) {
    const n = g.normal;
    const nStr = `(${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)})`;
    console.log(`  ${g.vertCount} verts, ${g.members} members, n=${nStr}, d=${g.d.toFixed(2)}`);
}

// ========== 3. Cylinder deduplication ==========
const CYL_AXIS_TOL = 0.001;
const CYL_ORIGIN_TOL = 0.5;
const CYL_RADIUS_TOL = 0.01;

const cylGroups = [];
for (const cyl of cylinders) {
    const p = cyl.params;
    let found = false;
    for (const group of cylGroups) {
        const gp = group.rep.params;
        // Check axis parallel
        const dot = p.axis.x * gp.axis.x + p.axis.y * gp.axis.y + p.axis.z * gp.axis.z;
        if (Math.abs(Math.abs(dot) - 1) < CYL_AXIS_TOL) {
            // Check same radius
            if (Math.abs(p.radius - gp.radius) < CYL_RADIUS_TOL) {
                // Check origin on same axis line
                const dx = p.origin.x - gp.origin.x;
                const dy = p.origin.y - gp.origin.y;
                const dz = p.origin.z - gp.origin.z;
                const proj = dx * gp.axis.x + dy * gp.axis.y + dz * gp.axis.z;
                const px = dx - proj * gp.axis.x;
                const py = dy - proj * gp.axis.y;
                const pz = dz - proj * gp.axis.z;
                const perpDist = Math.sqrt(px*px + py*py + pz*pz);
                if (perpDist < CYL_ORIGIN_TOL) {
                    group.members.push(cyl);
                    found = true;
                    break;
                }
            }
        }
    }
    if (!found) {
        cylGroups.push({ rep: cyl, members: [cyl] });
    }
}

console.log(`\n=== Unique cylinder equations: ${cylGroups.length} (ref: 57) ===`);
const cylHist = {};
for (const g of cylGroups) {
    const key = g.members.length >= 3 ? '3+' : String(g.members.length);
    cylHist[key] = (cylHist[key] || 0) + 1;
}
console.log('Cylinder group sizes:');
for (const [size, count] of Object.entries(cylHist)) {
    console.log(`  ${size} members: ${count} groups`);
}

// ========== 4. Parse reference STEP for comparison ==========
const REF_DIR = path.join('downloads', 'nist', 'NIST-FTC-CTC-PMI-CAD-models', 'CTC Definitions');
const refFiles = fs.readdirSync(REF_DIR).filter(f => f.toLowerCase().endsWith('.stp') || f.toLowerCase().endsWith('.step'));
console.log(`\n=== Reference STEP files: ${refFiles.length} ===`);
for (const f of refFiles) console.log(`  ${f}`);

if (refFiles.length > 0) {
    const refPath = path.join(REF_DIR, refFiles[0]);
    const refContent = fs.readFileSync(refPath, 'utf-8');
    
    // Join continuation lines (STEP wraps at 80 chars, continued lines start with space or don't have #N=)
    const lines = refContent.split('\n');
    const fullEntities = [];
    let current = '';
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) {
            if (current) fullEntities.push(current);
            current = trimmed;
        } else if (trimmed.endsWith(';')) {
            current += ' ' + trimmed;
            fullEntities.push(current);
            current = '';
        } else if (current) {
            current += ' ' + trimmed;
        }
    }
    if (current) fullEntities.push(current);
    
    // Count entity types
    const entityTypes = {};
    for (const ent of fullEntities) {
        const m = ent.match(/^#\d+=\s*(\w+)\s*\(/);
        if (m) {
            entityTypes[m[1]] = (entityTypes[m[1]] || 0) + 1;
        }
    }
    
    console.log(`\nReference entity type counts:`);
    const interesting = ['PLANE', 'CYLINDRICAL_SURFACE', 'CONICAL_SURFACE', 'LINE', 'CIRCLE',
        'EDGE_CURVE', 'ORIENTED_EDGE', 'EDGE_LOOP', 'FACE_BOUND', 'FACE_OUTER_BOUND',
        'ADVANCED_FACE', 'CLOSED_SHELL', 'OPEN_SHELL', 'MANIFOLD_SOLID_BREP',
        'CARTESIAN_POINT', 'DIRECTION', 'AXIS2_PLACEMENT_3D', 'VERTEX_POINT',
        'B_SPLINE_CURVE_WITH_KNOTS'];
    for (const et of interesting) {
        if (entityTypes[et]) console.log(`  ${et}: ${entityTypes[et]}`);
    }
    
    // Extract reference PLANE normals/origins for comparison
    // First build entity map
    const entityMap = {};
    for (const ent of fullEntities) {
        const m = ent.match(/^#(\d+)=\s*(\w+)\s*\((.*)\)\s*;/s);
        if (m) {
            entityMap[m[1]] = { type: m[2], args: m[3] };
        }
    }
    
    // Helper to parse CARTESIAN_POINT
    function parseCartesianPoint(id) {
        const e = entityMap[id];
        if (!e || e.type !== 'CARTESIAN_POINT') return null;
        const nums = e.args.match(/-?\d+\.[\dE+\-]+/g);
        if (!nums || nums.length < 3) return null;
        return { x: parseFloat(nums[0]), y: parseFloat(nums[1]), z: parseFloat(nums[2]) };
    }
    
    function parseDirection(id) {
        const e = entityMap[id];
        if (!e || e.type !== 'DIRECTION') return null;
        const nums = e.args.match(/-?\d+\.[\dE+\-]+/g);
        if (!nums || nums.length < 3) return null;
        return { x: parseFloat(nums[0]), y: parseFloat(nums[1]), z: parseFloat(nums[2]) };
    }
    
    function parseAxis2Placement(id) {
        const e = entityMap[id];
        if (!e || e.type !== 'AXIS2_PLACEMENT_3D') return null;
        const refs = e.args.match(/#(\d+)/g);
        if (!refs || refs.length < 3) return null;
        const origin = parseCartesianPoint(refs[0].slice(1));
        const direction = parseDirection(refs[1].slice(1));
        return { origin, direction };
    }
    
    // Extract reference PLANEs
    const refPlanes = [];
    for (const [id, ent] of Object.entries(entityMap)) {
        if (ent.type === 'PLANE') {
            const refs = ent.args.match(/#(\d+)/g);
            if (refs) {
                const ax = parseAxis2Placement(refs[0].slice(1));
                if (ax && ax.origin && ax.direction) {
                    refPlanes.push({
                        id: id,
                        origin: ax.origin,
                        normal: ax.direction,
                        d: ax.origin.x * ax.direction.x + ax.origin.y * ax.direction.y + ax.origin.z * ax.direction.z,
                    });
                }
            }
        }
    }
    console.log(`\nReference planes parsed: ${refPlanes.length}`);
    
    // Match our unique plane groups against reference planes
    let matched = 0;
    let unmatched = 0;
    for (const rp of refPlanes) {
        let found = false;
        for (const group of planeGroups) {
            const gn = group.normal;
            const dot = rp.normal.x * gn.x + rp.normal.y * gn.y + rp.normal.z * gn.z;
            if (Math.abs(Math.abs(dot) - 1) < 0.01) {
                const sign = dot > 0 ? 1 : -1;
                if (Math.abs(rp.d - sign * group.d) < 1.0) {
                    found = true;
                    matched++;
                    break;
                }
            }
        }
        if (!found) unmatched++;
    }
    console.log(`Reference planes matched to our groups: ${matched}/${refPlanes.length}`);
    console.log(`Reference planes unmatched: ${unmatched}`);
    
    // Also, for each of our plane groups, check if it matches any reference plane
    let ourMatched = 0;
    let ourUnmatched = 0;
    const unmatchedGroups = [];
    for (const group of planeGroups) {
        let found = false;
        for (const rp of refPlanes) {
            const gn = group.normal;
            const dot = rp.normal.x * gn.x + rp.normal.y * gn.y + rp.normal.z * gn.z;
            if (Math.abs(Math.abs(dot) - 1) < 0.01) {
                const sign = dot > 0 ? 1 : -1;
                if (Math.abs(rp.d - sign * group.d) < 1.0) {
                    found = true;
                    ourMatched++;
                    break;
                }
            }
        }
        if (!found) {
            ourUnmatched++;
            unmatchedGroups.push({
                members: group.members.length,
                normal: group.normal,
                d: group.d,
            });
        }
    }
    console.log(`\nOur plane groups matched to reference: ${ourMatched}/${planeGroups.length}`);
    console.log(`Our plane groups NOT in reference: ${ourUnmatched}`);
    console.log('First 10 unmatched groups:');
    for (const g of unmatchedGroups.slice(0, 10)) {
        const n = g.normal;
        console.log(`  ${g.members} members, n=(${n.x.toFixed(4)}, ${n.y.toFixed(4)}, ${n.z.toFixed(4)}), d=${g.d.toFixed(2)}`);
    }
}
