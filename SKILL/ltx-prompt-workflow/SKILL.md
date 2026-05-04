---
name: ltx-prompt-workflow
description: Build Chinese LTX-ready prompts and shot JSON from full scripts, four-panel storyboard descriptions, or existing video prompt drafts. Use when Codex needs to plan continuous four-grid story beats, adapt video prompts to the LTX-2.3 JSON format, or generate prompt scripts from four storyboard frames when no full script is available.
---

# LTX Prompt Workflow

## Overview

Follow this skill when the job is to turn story material into usable LTX prompt assets.
Keep outputs in Chinese unless the user explicitly asks for another language.

## Workflow Decision Tree

- If the user provides a full script, wants multi-group continuous four-grid planning, or asks for a Work-Fisher public workflow output, read `references/script-driven-continuous-four-grid.md`.
- If the user already has a video prompt draft, wants a strict LTX-2.3 or generic video-model JSON screenplay, or asks to map frame 1-4 into shot JSON, read `references/video-prompt-to-ltx-json.txt`.
- If the user has no script and only four-grid images, four frame descriptions, or a storyboard sequence that should become a flowing prompt, read `references/no-script-four-grid-to-prompt.txt`.

## Shared Rules

- Preserve character appearance, costume, props, space, lighting, and emotional continuity across all four frames or grouped shots.
- Prefer action continuity, eyeline continuity, or spatial continuity before adding cuts.
- Use clean hard cuts only when the chosen reference explicitly requires them, or when perspective, time, or state changes are large enough that continuous motion would feel false.
- Keep audio grounded in scene reality. Do not invent BGM or score unless the chosen reference explicitly asks for it.
- Sanity-check template contradictions before final output. If a reference contains mismatched total durations or parameter fields, align shot durations and global duration fields to the user's requested runtime.
- Preserve mandatory literal strings exactly when a reference marks them as fixed text.

## Output Expectations

- In script-driven mode, produce whole-story understanding and the complete group planning table before expanding any single group.
- In LTX JSON mode, keep the required JSON structure intact and output raw JSON only when the user asks for final JSON.
- In no-script four-grid mode, write naturally flowing cinematic language that treats the four frames as one continuous time slice unless a cut is justified.

## References

- `references/script-driven-continuous-four-grid.md`: full public workflow for turning a complete script into multiple continuous four-grid groups.
- `references/video-prompt-to-ltx-json.txt`: strict four-shot LTX JSON adaptation template.
- `references/no-script-four-grid-to-prompt.txt`: fallback template for generating prompts from four-grid material without a full script.
