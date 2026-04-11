---
description: "Continue open-sld-to-step parser improvement work. Loads project context from mcp-remember, follows investigation strategy v2, avoids known dead ends."
mode: "agent"
tools: ["mcp_remember_recall", "mcp_remember_entry", "mcp_remember_issue", "mcp_remember_todo", "mcp_remember_upsert", "mcp_remember_insight"]
---

# Continue Parser Improvement — open-sld-to-step

You are continuing work on a clean-room Parasolid-to-STEP converter. The project has extensive history stored in mcp-remember. **DO NOT start coding or investigating until you complete the startup checklist.**

## Step 1 — Load Context from mcp-remember (MANDATORY)

Execute these in order before doing ANYTHING else:

```
1. mcp_remember_recall (project: "open-sld-to-step")
   → Gets full project summary, current state, priorities

2. mcp_remember_issue (method: "list", project: "open-sld-to-step")
   → Gets open blockers and bugs — DO NOT work on anything blocked

3. mcp_remember_entry (method: "search", project: "open-sld-to-step", tags: ["scores"])
   → Gets current compare-all baseline scores

4. mcp_remember_entry (method: "search", project: "open-sld-to-step", tags: ["dead-end"])
   → Gets PROVEN DEAD ENDS — DO NOT re-investigate these

5. mcp_remember_entry (method: "get", project: "open-sld-to-step", key: "investigation-strategy-v2")
   → Gets the 7-rule investigation strategy — FOLLOW IT

6. mcp_remember_entry (method: "get", project: "open-sld-to-step", key: "investigation-decision-forks")
   → Gets past decision analysis — learn from these mistakes

7. mcp_remember_entry (method: "get", project: "open-sld-to-step", key: "investigation-dead-ends")
   → Gets confirmed dead ends with full reasoning
```

Read **ALL** of these before proceeding. Summarize what you learned to the user.

## Step 2 — Identify Current Priority

Based on loaded context, pick work from this priority stack:

### Priority A: Structural Improvements (HIGHEST LEVERAGE)
1. **Schema-driven parsing** — Parse the SCH_ section in Parasolid binary to get entity class→field layout mappings. This resolves LINE/PLANE ambiguity, enables topology extraction, and classifies cones/tori/spheres. This was abandoned after investigate13-14 and is the #1 strategic gap.
2. **Topology extraction** — Use schema field layouts to extract face→loop→edge→vertex chains. BLOCKED on schema parsing. Do NOT attempt without it (tried 4 times, all failed).
3. **Cone extraction** — 11-float type-0x1E entities with non-zero semiAngle are cones. Investigation 55-57 confirmed they exist in binary but code was NEVER WRITTEN. Implement in ParasolidParser.ts.

### Priority B: Quick Wins (SAFE, INCREMENTAL)
4. **Disable plane inference** — Investigation 65 proved inference is 0% accurate. Test with inference disabled: if average rises, commit.
5. **FTC_11 fix** — Currently 27.4%, worst performer. Reference has only 2 planes + 2 cylinders. We generate 21 false planes. Targeted fix.
6. **CTC_03 optimization** — Currently 78.1% with 100% ceiling. Missing 1 non-axis normal (0.707, -0.707, 0). Best candidate for high score.

### Priority C: Validation (AFTER EVERY CHANGE)
7. Run `npm test` — all 242 tests must pass
8. Run `npm run convert` — rebuild all STEP files
9. Run `npm run compare-all` — get new scores
10. Compare against stored baseline → update mcp-remember if improved

## Step 3 — HARD RULES

### DO NOT:
- ❌ Search for a LINE/PLANE binary discriminator (tried 4x: inv38, 53, 62, 66 — conclusive dead end)
- ❌ Attempt topology extraction without schema parsing (tried 4x: inv18, 37, 50, 51)
- ❌ Try vertex-triplet normal discovery (tried 2x, both regressed: 46.9%, 49.2%)
- ❌ Try cylinder shadow filtering (tried 2x, both regressed: 42.6%, 45.4%)
- ❌ Reference proprietary Dassault Systèmes or Siemens APIs (clean-room project)
- ❌ Move to next investigation after confirming something is implementable — IMPLEMENT FIRST
- ❌ Commit code that regresses compare-all average score

### DO:
- ✅ Check mcp-remember before creating any new investigation script
- ✅ Tag findings in mcp-remember immediately after every script (`dead-end`, `actionable`, `conclusive`)
- ✅ Update `compare-all-scores` entry in mcp-remember after score changes
- ✅ Use `npm run compare-all` as the ground truth for progress
- ✅ Next investigation script number is: check `scripts/` for highest existing number + 1
- ✅ Prefer structural solutions (schema, topology) over heuristic tuning (thresholds, filters)
- ✅ Add `// Clean-room analysis of public-domain NIST test files.` to investigation script headers

## Step 4 — After Each Work Unit

```
1. Run tests: npm test
2. If tests pass AND code changes were made:
   a. npm run convert
   b. npm run compare-all
   c. Compare against mcp-remember baseline
   d. If improved: update mcp-remember scores, commit
   e. If regressed: REVERT, create mcp-remember issue explaining why
3. If investigation script was created:
   a. Store findings in mcp-remember (entry, insight, issue, or memory)
   b. Tag appropriately (dead-end, actionable, structural, per-file, etc.)
4. Brief progress summary to user
```

## Context Reminders

- **Score formula**: Planes×3, Cylinders×3, Cones×2, Faces×4, HolesExact×2, InnerLoops×2, Vertices×1, Circles×1. Denominator: `max(generated, reference)`. False positives hurt more than false negatives at high gen counts.
- **Reference units**: MM files (CTC_01/02/04, FTC_10/11), INCH files (CTC_03/05, FTC_06-09)
- **PS coordinates**: meters, Big Endian float64. Scale: ×1000 for MM output.
- **Current baseline**: ~49.9% average across 11 files, 242 tests passing
- **The ~50% heuristic ceiling**: All threshold/heuristic approaches converge here. Only structural changes (schema, topology, new surface types) can break through.
