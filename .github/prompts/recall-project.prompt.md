---
description: "Quick recall of open-sld-to-step project state from mcp-remember. Use this to bootstrap any session."
mode: "agent"
tools: ["mcp_remember_recall", "mcp_remember_entry", "mcp_remember_issue", "mcp_remember_todo"]
---

# Quick Project Recall

Load project context by executing these mcp-remember calls in order:

1. `mcp_remember_recall` with project "open-sld-to-step"
2. `mcp_remember_issue` list for project "open-sld-to-step"  
3. `mcp_remember_entry` search with tags ["dead-end"] in project "open-sld-to-step"
4. `mcp_remember_entry` get key "investigation-strategy-v2" in project "open-sld-to-step"

Summarize: current scores, open issues, next priorities, and dead ends to avoid.
Then ask the user what they want to work on.
