---
name: vision-routing
description: Route image analysis to a dedicated vision subagent when the active model cannot understand images directly.
---

When the vision-routing hook says the active model is text-only and a request contains or references an image, delegate visual inspection to the agent named in that hook context. Pass all relevant absolute image paths, the hook marker, and the user's exact visual question. Require the child to load every local path with the platform-native image tool before analysis: `view_image` on Codex or `Read` on Claude Code. Wait for the result, then continue using its structured report. Do not claim to inspect the image directly.

Do not delegate when the active model supports image input. Do not invoke the vision agent when no image is involved.
