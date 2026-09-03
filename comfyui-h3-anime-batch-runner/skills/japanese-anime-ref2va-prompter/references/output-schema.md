# Output schema

Return one JSON object and no Markdown fence or commentary.

For Codex CLI structured output, the machine-readable version of this contract is `output-schema.json` in the same directory.

```json
{
  "title": "Short project title",
  "totalDurationSeconds": 30,
  "segmentSeconds": 15,
  "referenceAnalysis": [
    {
      "picture": 1,
      "subjectId": "Subject 1",
      "role": "main character",
      "observedTraits": "Concise visual traits actually visible in the image"
    }
  ],
  "voiceCast": [
    {
      "speakerId": "S1",
      "subjectId": "Subject 1",
      "characterName": "Optional story name",
      "voiceDirection": "Stable English voice profile: age impression, pitch, timbre, articulation, pace and baseline emotional quality"
    }
  ],
  "continuityBible": "Stable English continuity rules shared by all clips",
  "segments": [
    {
      "id": "clip_01",
      "number": 1,
      "startSeconds": 0,
      "durationSeconds": 15,
      "sourceRange": "00:00–00:15",
      "synopsis": "Short Japanese summary for the web UI",
      "dialoguePreview": "Exact Japanese dialogue lines joined compactly for the web UI",
      "prompt": "subject_definitions:\n...\n\nsummary:\n...\n\nretention_analysis:\n...\n\ndetailed_description:\n...\n\noverall_soundscape:\n...\n\nnon_diegetic_music:\n..."
    }
  ]
}
```

Use JSON string escaping correctly. Do not add properties whose only purpose is future speculation.

The final segment may be shorter than `segmentSeconds`. Its `durationSeconds` must equal the remaining project duration. `sourceRange` is an easy-to-read label; the numeric fields are authoritative.

`referenceAnalysis` must contain one entry for every supplied picture, in order. When several pictures depict the same subject, reuse the same `subjectId` and distinguish the view or role in `observedTraits`.

`voiceCast` must contain every speaker who produces dialogue. Keep `voiceDirection` stable and specific enough that the same vocal identity can be reproduced across clips. Do not name a real voice actor.

Each segment's `prompt` is a self-contained H3 full-reference prompt. Repeat the required subject definitions, voice descriptions, reference relationships, and continuity facts inside every segment rather than relying on another clip's prompt.
