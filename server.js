import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(os.tmpdir(), 'comfyui-h3-anime-runner');
const promptSkillDir = path.join(rootDir, 'skills', 'japanese-anime-ref2va-prompter');
const promptSchemaPath = path.join(promptSkillDir, 'references', 'output-schema.json');
await fsp.mkdir(runtimeDir, { recursive: true });
const logPath = path.join(runtimeDir, 'runner.log');

function writeLog(level, message, details = {}) {
  const row = JSON.stringify({ time: new Date().toISOString(), level, message, ...details });
  fs.appendFileSync(logPath, `${row}\n`, 'utf8');
}

const state = { running: false, cancelling: false, current: null, completed: [], errors: [], startedAt: null };
const sseClients = new Set();

function snapshot() {
  return { running: state.running, cancelling: state.cancelling, current: state.current, completed: state.completed, errors: state.errors, startedAt: state.startedAt };
}

function emit(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify({ ...data, state: snapshot() })}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function normalizeHttpUrl(value, fallback) {
  const parsed = new URL(value || fallback);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URLはhttpまたはhttpsを使用してください。');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeComfyUrl(value) {
  return normalizeHttpUrl(value, 'http://127.0.0.1:8188');
}

function clone(value) {
  return structuredClone(value);
}

function nodeAt(workflow, nodeId) {
  const node = workflow[String(nodeId)];
  if (!node || typeof node !== 'object' || !node.inputs) throw new Error(`Node ${nodeId} was not found in the API workflow.`);
  return node;
}

function isWorkflowLink(workflow, value) {
  return Array.isArray(value) && value.length === 2 && workflow[String(value[0])] && Number.isInteger(Number(value[1]));
}

function setInput(workflow, mapping, value, required = false) {
  if (!mapping?.nodeId || !mapping?.inputKey) {
    if (required) throw new Error('A required node mapping is missing.');
    return;
  }
  const node = nodeAt(workflow, mapping.nodeId);
  if (!(mapping.inputKey in node.inputs)) throw new Error(`Input ${mapping.inputKey} does not exist on node ${mapping.nodeId}.`);
  if (isWorkflowLink(workflow, node.inputs[mapping.inputKey])) {
    const [upstreamId, outputIndex] = node.inputs[mapping.inputKey];
    throw new Error(`Node ${mapping.nodeId}.${mapping.inputKey} is a connection from node ${upstreamId} output ${outputIndex}, not an editable text field.`);
  }
  const currentValue = node.inputs[mapping.inputKey];
  const currentType = currentValue === null ? 'null' : typeof currentValue;
  const nextType = value === null ? 'null' : typeof value;
  if (currentValue !== null && value !== null && currentType !== nextType) throw new Error(`Node ${mapping.nodeId}.${mapping.inputKey} is ${currentType}, but the controller tried to assign ${nextType}.`);
  node.inputs[mapping.inputKey] = value;
}

export function patchWorkflow(baseWorkflow, segment, config, assetPaths) {
  const workflow = clone(baseWorkflow);
  setInput(workflow, config.prompt, segment.prompt, true);
  for (let i = 0; i < (config.images || []).length; i += 1) {
    const mapping = config.images[i];
    const uploadIndex = Number.isInteger(Number(mapping.uploadIndex)) ? Number(mapping.uploadIndex) : i;
    if (!assetPaths.images[uploadIndex]) throw new Error(`Picture ${i + 1} has no staged image file.`);
    setInput(workflow, mapping, assetPaths.images[uploadIndex], true);
  }
  if (config.filename?.nodeId && config.filename?.inputKey) {
    const safeTitle = String(segment.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    setInput(workflow, config.filename, `${config.outputPrefix || 'h3_anime'}/${safeTitle}`);
  }
  for (const seedMap of config.seeds || []) {
    if (!seedMap.nodeId || !seedMap.inputKey) continue;
    setInput(workflow, seedMap, Number(config.baseSeed || 1) + Number(segment.index || 0));
  }
  return workflow;
}

async function stageReferenceImages(comfyInputDir, runId, imageFiles) {
  const subfolder = `h3_anime_${runId}`;
  const destination = path.join(comfyInputDir, subfolder);
  await fsp.mkdir(destination, { recursive: true });
  const images = [];
  for (let i = 0; i < imageFiles.length; i += 1) {
    const file = imageFiles[i];
    const safeName = path.basename(file.name).replace(/[^\p{L}\p{N}._-]+/gu, '_');
    const finalName = `ref${i + 1}_${safeName}`;
    await fsp.writeFile(path.join(destination, finalName), Buffer.from(await file.arrayBuffer()));
    images.push(`${subfolder}/${finalName}`);
  }
  return { subfolder, destination, images };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1200)}`);
  return data;
}

export function extractJsonObject(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI応答にJSONオブジェクトがありません。');
  try { return JSON.parse(text.slice(start, end + 1)); } catch (error) { throw new Error(`AI応答のJSONを解析できません: ${error.message}`); }
}

const PROMPT_SECTIONS = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'];
const VISUAL_TEXT_EXCLUSION = 'No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.';

function promptHasOrderedSections(prompt) {
  let cursor = -1;
  for (const section of PROMPT_SECTIONS) {
    const next = prompt.toLowerCase().indexOf(section, cursor + 1);
    if (next < 0) return false;
    cursor = next;
  }
  return true;
}

function timeLabel(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function hasSubtitleExclusion(prompt) {
  return [
    /\bno\s+(?:visible\s+)?(?:subtitles?|captions?)\b/i,
    /\b(?:subtitles?|captions?)\b[^.\n]{0,100}\b(?:prohibited|forbidden|excluded|absent|disabled|not allowed|must not|should not|do not|never|cannot)\b/i,
    /\b(?:do not|never|must not|should not)\s+(?:show|display|render|add|include|overlay|generate|present)\b[^.\n]{0,100}\b(?:subtitles?|captions?)\b/i,
    /\b(?:without|exclude|omit|avoid|disable)\b[^.\n]{0,100}\b(?:subtitles?|captions?)\b/i,
    /\b(?:subtitle|caption)-free\b/i,
    /(?:字幕|キャプション)[^。\n]{0,40}(?:禁止|表示しない|出さない|なし)/,
  ].some((pattern) => pattern.test(prompt));
}

function requestsVisibleSubtitles(prompt) {
  return [
    /\b(?:show|display|render|add|include|overlay|generate|present)\b[^.\n]{0,100}\b(?:subtitles?|captions?)\b/i,
    /\b(?:subtitles?|captions?)\b[^.\n]{0,100}\b(?:show|display|render|appear|overlay)\b/i,
    /(?:字幕|キャプション)[^。\n]{0,40}(?:表示|追加|描画|出す)/,
  ].some((pattern) => pattern.test(prompt));
}

function ensureVisualTextExclusion(prompt, id) {
  if (hasSubtitleExclusion(prompt)) return prompt;
  if (requestsVisibleSubtitles(prompt)) throw new Error(`${id}に字幕を表示する指示が混入しています。`);
  const marker = 'detailed_description:';
  const markerIndex = prompt.toLowerCase().indexOf(marker);
  if (markerIndex < 0) return prompt;
  const insertAt = markerIndex + marker.length;
  return `${prompt.slice(0, insertAt)}\n${VISUAL_TEXT_EXCLUSION}\n${prompt.slice(insertAt).replace(/^\s*/, '')}`;
}

export function validateAnimeProject(raw, request) {
  const totalDurationSeconds = Number(request.totalDurationSeconds);
  const segmentSeconds = Number(request.segmentSeconds);
  const referenceCount = Number(request.referenceCount);
  if (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0 || totalDurationSeconds > 300) throw new Error('全体秒数は1～300秒で指定してください。');
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0 || segmentSeconds > 15) throw new Error('1クリップ秒数は15秒以下で指定してください。');
  if (!Number.isInteger(referenceCount) || referenceCount < 1 || referenceCount > 9) throw new Error('参照画像は1～9枚必要です。');
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments)) throw new Error('AI応答にsegments配列がありません。');
  const expectedCount = Math.ceil(totalDurationSeconds / segmentSeconds);
  if (raw.segments.length !== expectedCount) throw new Error(`AIが${raw.segments.length}クリップを返しましたが、必要数は${expectedCount}です。`);
  if (!Array.isArray(raw.referenceAnalysis) || raw.referenceAnalysis.length !== referenceCount) throw new Error(`AIの参照画像分析が${raw.referenceAnalysis?.length || 0}件です。必要数は${referenceCount}件です。`);

  const allPrompts = [];
  const segments = raw.segments.map((entry, index) => {
    const startSeconds = index * segmentSeconds;
    const durationSeconds = Math.min(segmentSeconds, totalDurationSeconds - startSeconds);
    const id = `clip_${String(index + 1).padStart(2, '0')}`;
    let prompt = String(entry?.prompt || '').trim();
    if (!promptHasOrderedSections(prompt)) throw new Error(`${id}のプロンプトにH3の6セクションが揃っていません。`);
    if (/<Audio\s+\d+>/i.test(prompt)) throw new Error(`${id}に外部Audio参照が混入しています。`);
    prompt = ensureVisualTextExclusion(prompt, id);
    allPrompts.push(prompt);
    return {
      id, number: index + 1, startSeconds, durationSeconds,
      sourceRange: `${timeLabel(startSeconds)}–${timeLabel(startSeconds + durationSeconds)}`,
      synopsis: String(entry.synopsis || `クリップ${index + 1}`),
      dialoguePreview: String(entry.dialoguePreview || '日本語音声'),
      prompt,
    };
  });

  const combined = allPrompts.join('\n');
  for (let picture = 1; picture <= referenceCount; picture += 1) {
    if (!combined.includes(`<Picture ${picture}>`)) throw new Error(`<Picture ${picture}>が生成プロンプトで使用されていません。`);
  }
  if (!/<d>\[Japanese\][\s\S]+?<\/d>/i.test(combined)) throw new Error('日本語台詞タグ `<d>[Japanese] ...</d>` が生成されていません。');
  return {
    title: String(raw.title || request.title || 'Japanese Anime Project').trim(),
    totalDurationSeconds, segmentSeconds,
    referenceAnalysis: raw.referenceAnalysis,
    voiceCast: Array.isArray(raw.voiceCast) ? raw.voiceCast : [],
    continuityBible: String(raw.continuityBible || ''),
    segments,
  };
}

async function loadPromptSkill() {
  const [skill, schema] = await Promise.all([
    fsp.readFile(path.join(promptSkillDir, 'SKILL.md'), 'utf8'),
    fsp.readFile(path.join(promptSkillDir, 'references', 'output-schema.md'), 'utf8'),
  ]);
  return `${skill}\n\n${schema}`;
}

function validateCodexCommand(value) {
  let command = String(value || 'codex').trim();
  if (command.length >= 2 && command.startsWith('"') && command.endsWith('"')) command = command.slice(1, -1).trim();
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) throw new Error('Codex CLIコマンドが不正です。');
  return command;
}

export function buildCodexSearchCandidates(value, env = process.env, platform = process.platform) {
  const command = validateCodexCommand(value);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (pathApi.isAbsolute(command) || command.includes('/') || command.includes('\\')) return [command];
  const pathValue = env.PATH || env.Path || '';
  const pathDirs = pathValue.split(pathApi.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (platform === 'win32') {
    for (const npmDir of [env.APPDATA && pathApi.join(env.APPDATA, 'npm'), env.LOCALAPPDATA && pathApi.join(env.LOCALAPPDATA, 'npm')].filter(Boolean)) {
      if (!pathDirs.some((entry) => entry.toLowerCase() === npmDir.toLowerCase())) pathDirs.push(npmDir);
    }
  }
  const hasExtension = Boolean(pathApi.extname(command));
  const names = platform === 'win32' && !hasExtension ? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command] : [command];
  return [...new Set(pathDirs.flatMap((directory) => names.map((name) => pathApi.join(directory, name))))];
}

async function resolveCodexCommand(value) {
  const requested = validateCodexCommand(value);
  for (const candidate of buildCodexSearchCandidates(requested)) {
    try {
      await fsp.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(
    'Codex CLIが見つかりません。PowerShellで「npm install -g @openai/codex」を実行し、続けて「codex」を起動してChatGPTへログインしてください。' +
    'インストール済みの場合は「where.exe codex」で表示されたcodex.cmdのフルパスをWEB画面へ入力し、Runnerを再起動してください。',
  );
}

function validateCodexModel(value) {
  const model = String(value || '').trim();
  if (model && (!/^[A-Za-z0-9._:/-]+$/.test(model) || model.length > 200)) throw new Error('Codexモデル名が不正です。');
  return model;
}

function quoteWindowsArg(value) {
  const text = String(value);
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function spawnPortable(command, args, options) {
  if (process.platform !== 'win32') return spawn(command, args, options);
  if (/\.exe$/i.test(command)) return spawn(command, args, options);
  const commandLine = [command, ...args].map(quoteWindowsArg).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul & ${commandLine}`], options);
}

async function runCommand(command, args, { cwd, input = '', timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPortable(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxBytes = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`Codex CLIが${Math.round(timeoutMs / 60_000)}分以内に完了しませんでした。`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Codex CLIを起動できません: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const progress = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        const detail = progress || output || `終了コード ${code}${signal ? ` (${signal})` : ''}`;
        reject(new Error(`Codex CLI実行エラー: ${detail.slice(-3000)}`));
      } else resolve({ stdout: output, stderr: progress, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function buildCodexExecArgs({ model = '', schemaPath, outputPath, imagePaths = [] }) {
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', outputPath];
  if (model) args.push('--model', model);
  for (const imagePath of imagePaths) args.push('--image', imagePath);
  args.push('-');
  return args;
}

async function stageCodexImages(jobDir, imageFiles) {
  const imagePaths = [];
  for (let index = 0; index < imageFiles.length; index += 1) {
    const originalExtension = path.extname(imageFiles[index].name || '').toLowerCase();
    const extension = /^\.(png|jpe?g|webp|bmp|gif)$/.test(originalExtension) ? originalExtension : '.png';
    const imagePath = path.join(jobDir, `picture-${index + 1}${extension}`);
    await fsp.writeFile(imagePath, Buffer.from(await imageFiles[index].arrayBuffer()));
    imagePaths.push(imagePath);
  }
  return imagePaths;
}

function buildCodexPrompt(systemPrompt, request, imagePaths) {
  const pictureMap = imagePaths.map((imagePath, index) => `<Picture ${index + 1}> = attached image ${path.basename(imagePath)}`).join('\n');
  return `${systemPrompt}\n\n# Current task\nCreate the final JSON project from the input below. Inspect every attached image carefully. Use the exact attachment order shown in the picture map. Return only the JSON object required by the supplied schema.\n\n## Picture map\n${pictureMap}\n\n## Project input\n${JSON.stringify(request, null, 2)}`;
}

export async function testCodexCli(payload = {}) {
  const command = await resolveCodexCommand(payload.codexCommand);
  const result = await runCommand(command, ['--version'], { cwd: rootDir, timeoutMs: 15_000 });
  return { version: result.stdout || result.stderr || 'Codex CLI detected', command };
}

async function callPromptCodex(payload, imageFiles) {
  const command = await resolveCodexCommand(payload.codexCommand);
  const model = validateCodexModel(payload.codexModel);
  const timeoutMinutes = Math.min(60, Math.max(1, Number(payload.codexTimeoutMinutes) || 20));
  const systemPrompt = await loadPromptSkill();
  const request = {
    title: String(payload.title || '').trim(),
    roughStory: String(payload.roughStory || '').trim(),
    totalDurationSeconds: Number(payload.totalDurationSeconds),
    segmentSeconds: Number(payload.segmentSeconds),
    animeDirection: String(payload.animeDirection || 'polished Japanese TV anime'),
    dialogueDensity: String(payload.dialogueDensity || 'standard'),
    voiceDirection: String(payload.voiceDirection || '').trim(),
    referenceCount: imageFiles.length,
    hardConstraints: [
      'No external audio, MP3, SRT, subtitles, captions, lyric motion, visible text, or voice cloning.',
      `Every segment prompt must contain this exact sentence inside detailed_description: ${VISUAL_TEXT_EXCLUSION}`,
      'Generate original natural Japanese dialogue and character-matched professional Japanese animation voice performances.',
      'Use the requested duration and exact segment count.',
    ],
  };
  if (!request.roughStory) throw new Error('大まかなストーリーを入力してください。');
  const jobDir = await fsp.mkdtemp(path.join(runtimeDir, 'codex-job-'));
  try {
    const imagePaths = await stageCodexImages(jobDir, imageFiles);
    const outputPath = path.join(jobDir, 'anime-project.json');
    const args = buildCodexExecArgs({ model, schemaPath: promptSchemaPath, outputPath, imagePaths });
    const prompt = buildCodexPrompt(systemPrompt, request, imagePaths);
    const result = await runCommand(command, args, { cwd: jobDir, input: prompt, timeoutMs: timeoutMinutes * 60_000 });
    let output = '';
    try { output = await fsp.readFile(outputPath, 'utf8'); } catch { output = result.stdout; }
    const raw = extractJsonObject(output);
    return validateAnimeProject(raw, request);
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true });
  }
}

export function formatComfyExecutionError(data = {}, promptId = '') {
  const nodeId = data.node_id ?? data.node ?? 'unknown';
  const nodeType = data.node_type ?? data.class_type ?? 'unknown';
  const exceptionType = data.exception_type ?? 'ExecutionError';
  const exceptionMessage = data.exception_message ?? data.message ?? 'Unknown ComfyUI execution error.';
  return `ComfyUI node ${nodeId} (${nodeType}) — ${exceptionType}: ${exceptionMessage}${promptId ? ` [prompt ${promptId}]` : ''}`;
}

export function extractHistoryExecutionError(item, promptId = '') {
  const messages = item?.status?.messages;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      if (Array.isArray(entry) && entry[0] === 'execution_error') return formatComfyExecutionError(entry[1] || {}, promptId);
    }
  }
  return `ComfyUI execution failed for ${promptId || 'an unknown prompt'}.`;
}

async function waitByHistory(comfyUrl, promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.cancelling) throw new Error('Cancelled by user.');
    const history = await fetchJson(`${comfyUrl}/history/${encodeURIComponent(promptId)}`);
    const item = history[promptId];
    if (item) {
      if (item.status?.status_str === 'error') throw new Error(extractHistoryExecutionError(item, promptId));
      if (item.status?.completed || item.outputs) return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Timed out waiting for prompt ${promptId}.`);
}

async function queueAndWait(comfyUrl, workflow, timeoutMs) {
  const clientId = crypto.randomUUID();
  const queued = await fetchJson(`${comfyUrl}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) });
  if (!queued.prompt_id) throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(queued.node_errors || queued)}`);
  const promptId = queued.prompt_id;
  return { promptId, history: await waitByHistory(comfyUrl, promptId, timeoutMs) };
}

async function executeRun(payload, files) {
  state.running = true;
  state.cancelling = false;
  state.current = null;
  state.completed = [];
  state.errors = [];
  state.startedAt = new Date().toISOString();
  emit('run-started');
  const comfyUrl = normalizeComfyUrl(payload.comfyUrl);
  const comfyInputDir = path.resolve(payload.comfyInputDir);
  const runId = Date.now().toString(36);
  try {
    const stat = await fsp.stat(comfyInputDir);
    if (!stat.isDirectory()) throw new Error('The ComfyUI input path is not a directory.');
    await fetchJson(`${comfyUrl}/system_stats`);
    const segments = JSON.parse(payload.segmentsJson);
    const workflow = JSON.parse(payload.workflowJson);
    const config = JSON.parse(payload.mappingJson);
    if (!Array.isArray(segments) || !segments.length) throw new Error('No segments were selected.');
    if (!files.images?.length || files.images.length > 9) throw new Error('Reference images must contain Picture 1 through Picture 9.');
    const staged = await stageReferenceImages(comfyInputDir, runId, files.images);
    if ((config.images || []).length !== staged.images.length) throw new Error('Reference image mapping count does not match uploaded images.');
    for (let i = 0; i < segments.length; i += 1) {
      if (state.cancelling) throw new Error('Cancelled by user.');
      const segment = { ...segments[i], index: Number(segments[i].number || i + 1) - 1 };
      state.current = { index: i + 1, total: segments.length, id: segment.id, synopsis: segment.synopsis };
      emit('clip-started', { current: state.current });
      const result = await queueAndWait(comfyUrl, patchWorkflow(workflow, segment, config, { images: staged.images }), Number(config.timeoutMinutes || 90) * 60_000);
      state.completed.push({ id: segment.id, promptId: result.promptId });
      emit('clip-completed', { id: segment.id, promptId: result.promptId });
    }
    emit('run-completed');
  } catch (error) {
    writeLog('error', error.message, { runId, clip: state.current?.id || null, stack: error.stack });
    state.errors.push({ clip: state.current?.id || null, message: error.message });
    emit(state.cancelling ? 'run-cancelled' : 'run-error', { message: error.message });
  } finally {
    state.running = false;
    state.current = null;
    emit('state');
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function toWebRequest(req) {
  const method = req.method || 'GET';
  const options = { method, headers: req.headers };
  if (!['GET', 'HEAD'].includes(method)) {
    options.body = Readable.toWeb(req);
    options.duplex = 'half';
  }
  return new Request(`http://${req.headers.host || '127.0.0.1'}${req.url}`, options);
}

function formFields(form) {
  const output = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

function formImages(form) {
  const images = form.getAll('images').filter((value) => value && typeof value.arrayBuffer === 'function');
  if (images.length > 9) throw new Error('参照画像は最大9枚です。');
  for (const image of images) {
    if (image.size > 25 * 1024 * 1024) throw new Error(`${image.name}は25MBを超えています。`);
    if (image.type && !image.type.startsWith('image/')) throw new Error(`${image.name}は画像ファイルではありません。`);
  }
  return images;
}

const STATIC_FILES = new Map([
  ['/', [path.join(rootDir, 'public', 'index.html'), 'text/html; charset=utf-8']],
  ['/index.html', [path.join(rootDir, 'public', 'index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [path.join(rootDir, 'public', 'app.js'), 'text/javascript; charset=utf-8']],
  ['/workflow-inspector.js', [path.join(rootDir, 'public', 'workflow-inspector.js'), 'text/javascript; charset=utf-8']],
  ['/styles.css', [path.join(rootDir, 'public', 'styles.css'), 'text/css; charset=utf-8']],
  ['/PROMPT_SKILL.md', [path.join(promptSkillDir, 'SKILL.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SCHEMA.md', [path.join(promptSkillDir, 'references', 'output-schema.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SCHEMA.json', [promptSchemaPath, 'application/json; charset=utf-8']],
]);

async function serveStatic(pathname, res) {
  const item = STATIC_FILES.get(pathname);
  if (!item) return false;
  const body = await fsp.readFile(item[0]);
  res.writeHead(200, { 'content-type': item[1], 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

async function app(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      try {
        const probe = path.join(runtimeDir, `probe-${process.pid}`);
        await fsp.writeFile(probe, 'ok');
        await fsp.unlink(probe);
        return sendJson(res, 200, { ok: true, node: process.version, runtimeWritable: true, logPath });
      } catch (error) {
        return sendJson(res, 500, { ok: false, node: process.version, runtimeWritable: false, logPath, error: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sseClients.add(res);
      res.write(`event: state\ndata: ${JSON.stringify({ state: snapshot() })}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/test-connection') {
      const body = await toWebRequest(req).json();
      try {
        const stats = await fetchJson(`${normalizeComfyUrl(body.comfyUrl)}/system_stats`);
        return sendJson(res, 200, { ok: true, stats });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/test-codex') {
      const body = await toWebRequest(req).json();
      try {
        const detected = await testCodexCli(body);
        return sendJson(res, 200, { ok: true, ...detected });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/generate-anime-project') {
      const form = await toWebRequest(req).formData();
      const fields = formFields(form);
      const images = formImages(form);
      try {
        if (!images.length) throw new Error('参照画像を1枚以上D&Dしてください。');
        const generatedProject = await callPromptCodex(fields, images);
        writeLog('info', 'Anime prompt project generated with Codex CLI.', { model: fields.codexModel || 'configured-default', referenceCount: images.length, segments: generatedProject.segments.length });
        return sendJson(res, 200, { ok: true, project: generatedProject });
      } catch (error) {
        writeLog('error', 'Anime prompt generation failed.', { error: error.message });
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (state.running) return sendJson(res, 409, { ok: false, error: 'A batch is already running.' });
      const form = await toWebRequest(req).formData();
      const fields = formFields(form);
      const images = formImages(form);
      if (!images.length) return sendJson(res, 400, { ok: false, error: '参照画像を1枚以上D&Dしてください。' });
      executeRun(fields, { images });
      return sendJson(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const body = await toWebRequest(req).json();
      state.cancelling = true;
      try { await fetch(`${normalizeComfyUrl(body.comfyUrl)}/interrupt`, { method: 'POST' }); } catch {}
      emit('cancelling');
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    writeLog('error', 'HTTP request failed.', { error: error.message, stack: error.stack });
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message || 'Unexpected server error.' });
    else res.end();
  }
}

const port = Number(process.env.H3_RUNNER_PORT || 3030);
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  http.createServer(app).listen(port, '127.0.0.1', () => {
    writeLog('info', 'Server started.', { port, node: process.version });
    console.log(`ComfyUI H3 Anime Auto Director: http://127.0.0.1:${port}`);
    console.log(`Diagnostic log: ${logPath}`);
  });
}

export { app };
