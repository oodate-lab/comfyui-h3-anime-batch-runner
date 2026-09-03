import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { app } from '../server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function validPrompt() {
  return `subject_definitions:\n<Subject 1> is the character in <Picture 1>.\n\nsummary:\nA Japanese anime scene.\n\nretention_analysis:\n<Subject 1>: fully_preserved.\n\ndetailed_description:\nNo visible subtitles, captions, speech bubbles, lyric typography, logos, UI, or generated writing. [Shot 1] <Subject 1> (S1) performs and says, <d>[Japanese] 見つけた。</d>\n\noverall_soundscape:\nClean native Japanese dialogue and room tone.\n\nnon_diegetic_music:\nN/A`;
}

test('Codex CLI receives the reference image, schema and bundled prompt skill', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'fake-codex-'));
  const capturePath = path.join(temp, 'capture.json');
  const project = {
    title: '放課後', totalDurationSeconds: 15, segmentSeconds: 15,
    referenceAnalysis: [{ picture: 1, subjectId: 'Subject 1', role: 'main character', observedTraits: 'reference-locked anime character' }],
    voiceCast: [{ speakerId: 'S1', subjectId: 'Subject 1', characterName: '少女', voiceDirection: 'youthful, soft and precisely articulated' }],
    continuityBible: 'Preserve identity and S1 voice.',
    segments: [{ id: 'clip_01', number: 1, startSeconds: 0, durationSeconds: 15, sourceRange: '00:00–00:15', synopsis: '少女が見つける', dialoguePreview: '見つけた。', prompt: validPrompt() }],
  };
  const scriptPath = path.join(temp, 'fake-codex.mjs');
  await fsp.writeFile(scriptPath, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nif (args.includes('--version')) { console.log('codex-cli 9.9.9-test'); process.exit(0); }\nlet input = '';\nfor await (const chunk of process.stdin) input += chunk;\nconst outputPath = args[args.indexOf('-o') + 1];\nfs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, input }));\nfs.writeFileSync(outputPath, ${JSON.stringify(JSON.stringify(project))});\nconsole.log('done');\n`);
  await fsp.chmod(scriptPath, 0o755);
  const runner = http.createServer(app);
  const runnerPort = await listen(runner);
  try {
    const checked = await fetch(`http://127.0.0.1:${runnerPort}/api/test-codex`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codexCommand: scriptPath }),
    }).then((response) => response.json());
    assert.equal(checked.ok, true);
    assert.match(checked.version, /9\.9\.9-test/);

    const form = new FormData();
    form.append('codexCommand', scriptPath);
    form.append('codexModel', 'gpt-test');
    form.append('codexTimeoutMinutes', '1');
    form.append('roughStory', '放課後、少女が忘れ物を見つける。');
    form.append('totalDurationSeconds', '15');
    form.append('segmentSeconds', '15');
    form.append('animeDirection', 'polished Japanese TV anime');
    form.append('dialogueDensity', 'standard');
    form.append('images', new Blob([Buffer.from('reference')], { type: 'image/png' }), 'character.png');
    const response = await fetch(`http://127.0.0.1:${runnerPort}/api/generate-anime-project`, { method: 'POST', body: form });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.ok, true);
    assert.equal(result.project.segments[0].durationSeconds, 15);
    const capture = JSON.parse(await fsp.readFile(capturePath, 'utf8'));
    assert.match(capture.input, /Japanese Anime Ref2va Prompter/);
    assert.match(capture.input, /<Picture 1> = attached image picture-1\.png/);
    assert.ok(capture.args.includes('--output-schema'));
    assert.ok(capture.args.includes('--image'));
    assert.deepEqual(capture.args.slice(capture.args.indexOf('--model'), capture.args.indexOf('--model') + 2), ['--model', 'gpt-test']);
  } finally {
    await close(runner);
    await fsp.rm(temp, { recursive: true, force: true });
  }
});

test('ordered Picture files and prompts reach ComfyUI without MP3 input', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'h3-anime-test-'));
  const inputDir = path.join(temp, 'input');
  await fsp.mkdir(inputDir);
  const queuedWorkflows = [];
  const fakeComfy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/system_stats') return res.end(JSON.stringify({ system: 'ok' }));
    if (req.url === '/prompt' && req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      return req.on('end', () => {
        queuedWorkflows.push(JSON.parse(Buffer.concat(chunks).toString()).prompt);
        res.end(JSON.stringify({ prompt_id: `prompt-${queuedWorkflows.length}` }));
      });
    }
    if (/^\/history\/prompt-\d+$/.test(req.url)) {
      const id = req.url.split('/').at(-1);
      return res.end(JSON.stringify({ [id]: { status: { completed: true }, outputs: {} } }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  const fakePort = await listen(fakeComfy);
  const runner = http.createServer(app);
  const runnerPort = await listen(runner);
  try {
    const form = new FormData();
    form.append('comfyUrl', `http://127.0.0.1:${fakePort}`);
    form.append('comfyInputDir', inputDir);
    form.append('workflowJson', JSON.stringify({
      text: { class_type: 'Text', inputs: { text: 'old' } },
      image1: { class_type: 'LoadImage', inputs: { image: 'old1.png' } },
      image2: { class_type: 'LoadImage', inputs: { image: 'old2.png' } },
    }));
    form.append('segmentsJson', JSON.stringify([
      { id: 'clip_01', number: 1, prompt: 'anime prompt one', synopsis: 'one' },
      { id: 'clip_02', number: 2, prompt: 'anime prompt two', synopsis: 'two' },
    ]));
    form.append('mappingJson', JSON.stringify({
      prompt: { nodeId: 'text', inputKey: 'text' },
      images: [
        { nodeId: 'image1', inputKey: 'image', uploadIndex: 0 },
        { nodeId: 'image2', inputKey: 'image', uploadIndex: 1 },
      ], timeoutMinutes: 1,
    }));
    form.append('images', new Blob([Buffer.from('picture one')], { type: 'image/png' }), 'girl.png');
    form.append('images', new Blob([Buffer.from('picture two')], { type: 'image/png' }), 'room.png');
    const accepted = await fetch(`http://127.0.0.1:${runnerPort}/api/run`, { method: 'POST', body: form });
    assert.equal(accepted.status, 202);
    let status;
    for (let index = 0; index < 40; index += 1) {
      status = await fetch(`http://127.0.0.1:${runnerPort}/api/status`).then((response) => response.json());
      if (!status.running && status.completed.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.errors.length, 0);
    assert.equal(status.completed.length, 2);
    assert.equal(queuedWorkflows.length, 2);
    assert.equal(queuedWorkflows[0].text.inputs.text, 'anime prompt one');
    assert.equal(queuedWorkflows[1].text.inputs.text, 'anime prompt two');
    assert.match(queuedWorkflows[0].image1.inputs.image, /ref1_girl\.png$/);
    assert.match(queuedWorkflows[0].image2.inputs.image, /ref2_room\.png$/);
    assert.equal(Object.values(queuedWorkflows[0]).some((node) => /audio/i.test(node.class_type)), false);
  } finally {
    await close(runner);
    await close(fakeComfy);
    await fsp.rm(temp, { recursive: true, force: true });
  }
});
