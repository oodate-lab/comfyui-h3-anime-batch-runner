import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs, buildCodexSearchCandidates, extractHistoryExecutionError, extractJsonObject, formatComfyExecutionError, patchWorkflow, testCodexCli, validateAnimeProject } from '../server.js';

function h3Prompt(picture = 1, dialogue = 'こんにちは。') {
  return `subject_definitions:\n<Subject 1> is the character in <Picture ${picture}>.\n\nsummary:\nA Japanese anime scene.\n\nretention_analysis:\n<Subject 1>: fully_preserved.\n\ndetailed_description:\nNo visible subtitles, captions, speech bubbles, lyric typography, logos, UI, or generated writing. [Shot 1] <Subject 1> (S1) speaks with precise lip sync, <d>[Japanese] ${dialogue}</d>\n\noverall_soundscape:\nClean room tone and synchronized dialogue.\n\nnon_diegetic_music:\nN/A`;
}

test('Codex exec arguments use read-only structured output and ordered images', () => {
  const args = buildCodexExecArgs({
    model: 'gpt-test', schemaPath: '/tmp/schema.json', outputPath: '/tmp/output.json',
    imagePaths: ['/tmp/picture-1.png', '/tmp/picture-2.png'],
  });
  assert.deepEqual(args, [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', '/tmp/schema.json', '-o', '/tmp/output.json',
    '--model', 'gpt-test', '--image', '/tmp/picture-1.png', '--image', '/tmp/picture-2.png', '-',
  ]);
});

test('Windows Codex discovery searches PATH and standard npm folders', () => {
  const candidates = buildCodexSearchCandidates('codex', {
    PATH: 'C:\\Tools',
    APPDATA: 'C:\\Users\\Akita\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Akita\\AppData\\Local',
  }, 'win32');
  assert.ok(candidates.includes('C:\\Tools\\codex.cmd'));
  assert.ok(candidates.includes('C:\\Users\\Akita\\AppData\\Roaming\\npm\\codex.cmd'));
  assert.ok(candidates.includes('C:\\Users\\Akita\\AppData\\Local\\npm\\codex.cmd'));
});

test('missing Codex CLI returns an actionable Japanese installation message', async () => {
  await assert.rejects(
    () => testCodexCli({ codexCommand: 'codex-definitely-not-installed-for-test' }),
    /npm install -g @openai\/codex.*where\.exe codex/,
  );
});

test('patchWorkflow replaces prompt and reference images without an audio mapping', () => {
  const base = {
    '1': { class_type: 'Text', inputs: { text: 'old' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    '3': { class_type: 'Save', inputs: { filename_prefix: 'old' } },
    '4': { class_type: 'Sampler', inputs: { seed: 0 } },
  };
  const patched = patchWorkflow(base, { id: 'clip_01', index: 2, prompt: 'new prompt' }, {
    prompt: { nodeId: '1', inputKey: 'text' },
    images: [{ nodeId: '2', inputKey: 'image', uploadIndex: 0 }],
    filename: { nodeId: '3', inputKey: 'filename_prefix' },
    seeds: [{ nodeId: '4', inputKey: 'seed' }], baseSeed: 100, outputPrefix: 'anime',
  }, { images: ['batch/ref.png'] });
  assert.equal(patched['1'].inputs.text, 'new prompt');
  assert.equal(patched['2'].inputs.image, 'batch/ref.png');
  assert.equal(patched['3'].inputs.filename_prefix, 'anime/clip_01');
  assert.equal(patched['4'].inputs.seed, 102);
  assert.equal(base['1'].inputs.text, 'old');
});

test('patchWorkflow supports nine independently mapped reference images', () => {
  const base = { text: { class_type: 'Text', inputs: { text: 'old' } } };
  const mappings = [];
  const paths = [];
  for (let index = 1; index <= 9; index += 1) {
    base[`image${index}`] = { class_type: 'LoadImage', inputs: { image: 'old.png' } };
    mappings.push({ nodeId: `image${index}`, inputKey: 'image', uploadIndex: index - 1 });
    paths.push(`batch/ref${index}.png`);
  }
  const patched = patchWorkflow(base, { id: 'clip_01', prompt: 'nine pictures' }, {
    prompt: { nodeId: 'text', inputKey: 'text' }, images: mappings,
  }, { images: paths });
  for (let index = 1; index <= 9; index += 1) assert.equal(patched[`image${index}`].inputs.image, `batch/ref${index}.png`);
});

test('patchWorkflow rejects graph connections, wrong types, and missing images', () => {
  assert.throws(() => patchWorkflow({
    primitive: { class_type: 'Primitive', inputs: { value: 'old' } },
    h3: { class_type: 'H3', inputs: { prompt: ['primitive', 0] } },
  }, { id: 'clip_01', prompt: 'new' }, { prompt: { nodeId: 'h3', inputKey: 'prompt' }, images: [] }, { images: [] }), /connection from node primitive/);
  assert.throws(() => patchWorkflow({ text: { class_type: 'Primitive', inputs: { value: 1 } } }, { id: 'x', prompt: 'new' }, {
    prompt: { nodeId: 'text', inputKey: 'value' }, images: [],
  }, { images: [] }), /is number.*assign string/);
  assert.throws(() => patchWorkflow({
    text: { class_type: 'Text', inputs: { text: 'old' } }, image: { class_type: 'LoadImage', inputs: { image: '' } },
  }, { id: 'x', prompt: 'new' }, { prompt: { nodeId: 'text', inputKey: 'text' }, images: [{ nodeId: 'image', inputKey: 'image' }] }, { images: [] }), /Picture 1.*no staged image/);
});

test('extractJsonObject accepts fenced JSON', () => {
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
});

test('validateAnimeProject normalizes timing and accepts native Japanese dialogue', () => {
  const raw = {
    title: 'Test',
    referenceAnalysis: [{ picture: 1 }],
    voiceCast: [{ speakerId: 'S1', voiceDirection: 'youthful and clear' }],
    continuityBible: 'Keep S1 stable.',
    segments: [
      { synopsis: '前半', dialoguePreview: 'こんにちは', prompt: h3Prompt(1, 'こんにちは。') },
      { synopsis: '後半', dialoguePreview: 'またね', prompt: h3Prompt(1, 'またね。') },
    ],
  };
  const project = validateAnimeProject(raw, { totalDurationSeconds: 20, segmentSeconds: 15, referenceCount: 1 });
  assert.equal(project.segments.length, 2);
  assert.equal(project.segments[0].durationSeconds, 15);
  assert.equal(project.segments[1].durationSeconds, 5);
  assert.equal(project.segments[1].sourceRange, '00:15–00:20');
});

test('validateAnimeProject rejects audio references and missing pictures, then repairs a missing subtitle exclusion', () => {
  const base = { title: 'X', referenceAnalysis: [{ picture: 1 }], segments: [{ prompt: h3Prompt(1) }] };
  assert.throws(() => validateAnimeProject({ ...base, segments: [{ prompt: h3Prompt(1).replace('N/A', '<Audio 1>') }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 }), /Audio/);
  assert.throws(() => validateAnimeProject({ ...base, referenceAnalysis: [{ picture: 1 }, { picture: 2 }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 2 }), /Picture 2/);
  const repaired = validateAnimeProject({ ...base, segments: [{ prompt: h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, logos, UI, or generated writing. ', '') }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(repaired.segments[0].prompt, /No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing\./);
});

test('validateAnimeProject accepts equivalent subtitle prohibitions but rejects display instructions', () => {
  const base = { title: 'X', referenceAnalysis: [{ picture: 1 }] };
  const equivalent = h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, logos, UI, or generated writing.', 'Subtitles and captions are strictly prohibited; all dialogue remains audio-only.');
  const accepted = validateAnimeProject({ ...base, segments: [{ prompt: equivalent }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(accepted.segments[0].prompt, /strictly prohibited/);
  const imperative = h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, logos, UI, or generated writing.', 'Do not display subtitles or captions at any time.');
  const imperativeAccepted = validateAnimeProject({ ...base, segments: [{ prompt: imperative }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(imperativeAccepted.segments[0].prompt, /Do not display subtitles/);
  const visible = h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, logos, UI, or generated writing.', 'Display subtitles for every Japanese line.');
  assert.throws(() => validateAnimeProject({ ...base, segments: [{ prompt: visible }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 }), /字幕を表示する指示/);
});

test('ComfyUI execution error formatting remains actionable', () => {
  const message = formatComfyExecutionError({ node_id: '42', node_type: 'H3ReferenceVideo', exception_type: 'TypeError', exception_message: 'bad input' }, 'prompt-1');
  assert.match(message, /node 42/);
  assert.match(message, /H3ReferenceVideo/);
  assert.match(extractHistoryExecutionError({ status: { messages: [['execution_error', { node_id: '7', node_type: 'LoadImage', exception_message: 'missing' }]] } }, 'p1'), /node 7/);
});
