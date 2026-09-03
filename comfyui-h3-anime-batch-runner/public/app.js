import { ensureH3ReferenceImageSlots, findAutomaticImageSlots } from './workflow-inspector.js?v=5.1.2';

let workflow = null;
let nodes = [];
let project = null;
let segments = [];
let automaticImageSlots = [];
let referenceFiles = [];
let running = false;

const $ = (id) => document.getElementById(id);
const log = (message) => {
  const stamp = new Date().toLocaleTimeString('ja-JP');
  $('log').textContent += `[${stamp}] ${message}\n`;
  $('log').scrollTop = $('log').scrollHeight;
};

function nodeLabel(node) {
  return `${node.id} · ${node.title || node.classType}（編集可能 ${node.keys.filter((key) => !key.linked).length}）`;
}

function fillNodeSelect(select, includeEmpty = false) {
  select.innerHTML = includeEmpty ? '<option value="">未使用</option>' : '';
  for (const node of nodes) select.add(new Option(nodeLabel(node), node.id));
}

function fillKeySelect(nodeSelect, keySelect, allowedTypes = null) {
  const node = nodes.find((entry) => entry.id === nodeSelect.value);
  keySelect.innerHTML = '';
  for (const entry of node?.keys || []) {
    const wrongType = allowedTypes && !allowedTypes.includes(entry.type);
    const label = entry.linked ? `${entry.name} — 接続入力（上流で指定）` : wrongType ? `${entry.name} — ${entry.type}（型が不一致）` : `${entry.name} — ${entry.type}`;
    const option = new Option(label, entry.name);
    option.disabled = entry.linked || wrongType;
    keySelect.add(option);
  }
  const firstEditable = [...keySelect.options].find((option) => !option.disabled);
  if (firstEditable) keySelect.value = firstEditable.value;
  else keySelect.prepend(new Option('利用可能な入力なし', '', true, true));
}

function guessNode(patterns, keyPatterns = [], allowedTypes = null) {
  const isAllowed = (key) => !key.linked && (!allowedTypes || allowedTypes.includes(key.type));
  const byEditableKey = nodes.find((node) => node.keys.some((key) => isAllowed(key) && keyPatterns.includes(key.name.toLowerCase())));
  if (byEditableKey) return byEditableKey;
  return nodes.find((node) => {
    const haystack = `${node.classType} ${node.title}`.toLowerCase();
    return patterns.some((pattern) => haystack.includes(pattern)) && node.keys.some(isAllowed);
  });
}

function choose(select, node, preferredKeys = []) {
  if (node) select.value = node.id;
  select.dispatchEvent(new Event('change'));
  const keySelect = select.id === 'promptNode' ? $('promptKey') : $('filenameKey');
  const preferred = [...keySelect.options].find((option) => !option.disabled && preferredKeys.includes(option.value.toLowerCase()));
  if (preferred) keySelect.value = preferred.value;
}

function addMapping(containerId, label, suggestedNode = null, suggestedKey = null, allowedTypes = null) {
  const row = document.createElement('div');
  row.className = 'mapping-row';
  row.innerHTML = `<span>${label}</span><select class="node"></select><select class="key"></select><button type="button" class="danger">×</button>`;
  const nodeSelect = row.querySelector('.node');
  const keySelect = row.querySelector('.key');
  fillNodeSelect(nodeSelect, true);
  nodeSelect.addEventListener('change', () => fillKeySelect(nodeSelect, keySelect, allowedTypes));
  nodeSelect.value = suggestedNode?.id || '';
  fillKeySelect(nodeSelect, keySelect, allowedTypes);
  if (suggestedKey && [...keySelect.options].some((option) => option.value === suggestedKey && !option.disabled)) keySelect.value = suggestedKey;
  row.querySelector('button').onclick = () => row.remove();
  $(containerId).append(row);
}

function mappingRows(containerId) {
  return [...$(containerId).querySelectorAll('.mapping-row')].map((row) => ({
    nodeId: row.querySelector('.node').value,
    inputKey: row.querySelector('.key').value,
  })).filter((entry) => entry.nodeId && entry.inputKey);
}

function safeFilePart(value) {
  return String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'h3_anime';
}

function downloadJson(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function rebuildAutomaticImageSlots() {
  if (!workflow) automaticImageSlots = [];
  else if (referenceFiles.length) {
    const prepared = ensureH3ReferenceImageSlots(workflow, referenceFiles.length);
    workflow = prepared.workflow;
    automaticImageSlots = prepared.slots;
    if (prepared.generated.length) log(`Picture ${prepared.generated.map((entry) => entry.picture).join(', ')}用のLoadImageノードを自動生成し、H3へ接続しました。`);
  } else automaticImageSlots = findAutomaticImageSlots(workflow, 9);
  renderReferenceImages();
}

function renderReferenceImages() {
  $('referenceImageList').innerHTML = '';
  referenceFiles.forEach((entry, index) => {
    const slot = automaticImageSlots[index];
    const card = document.createElement('div');
    card.className = 'reference-card';
    const image = document.createElement('img');
    image.alt = `Picture ${index + 1}`;
    image.src = entry.url;
    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `Picture ${index + 1}`;
    const filename = document.createElement('small');
    filename.textContent = entry.file.name;
    const target = document.createElement('small');
    target.textContent = slot ? `${slot.generated ? '自動生成・接続' : '自動接続'}: Node ${slot.nodeId}.${slot.inputKey}` : workflow ? 'H3入力を準備中' : 'ワークフロー読込前';
    details.append(title, filename, target);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = '×';
    remove.onclick = () => {
      URL.revokeObjectURL(entry.url);
      referenceFiles.splice(index, 1);
      rebuildAutomaticImageSlots();
      project = null;
      segments = [];
      renderProject();
      log('参照画像が変わったため、AIプロンプトを再生成してください。');
    };
    card.append(image, details, remove);
    $('referenceImageList').append(card);
  });
  const detected = automaticImageSlots.slice(0, referenceFiles.length).filter(Boolean).length;
  $('imageSlotSummary').textContent = referenceFiles.length
    ? `Picture 1～${referenceFiles.length}を登録済み${workflow ? `。H3画像入力${detected}件を自動接続` : '。ワークフロー読込後に同じ順で自動接続'}。`
    : '参照画像を1～9枚追加してください。';
}

function addReferenceFiles(files) {
  const images = [...files].filter((file) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name));
  const available = 9 - referenceFiles.length;
  for (const file of images.slice(0, available)) referenceFiles.push({ file, url: URL.createObjectURL(file) });
  if (images.length > available) log(`参照画像は最大9枚です。${images.length - available}枚は追加されませんでした。`);
  rebuildAutomaticImageSlots();
}

function selectedSegments() {
  const ids = new Set([...document.querySelectorAll('.clip-check:checked')].map((box) => box.dataset.id));
  return segments.filter((segment) => ids.has(segment.id));
}

function showPrompt(segment) {
  const modal = document.createElement('div');
  modal.className = 'modal';
  const box = document.createElement('div');
  const heading = document.createElement('div');
  heading.className = 'section-row';
  const title = document.createElement('h2');
  title.textContent = `${segment.id} · ${segment.sourceRange}`;
  const close = document.createElement('button');
  close.className = 'ghost';
  close.textContent = '閉じる';
  const pre = document.createElement('pre');
  pre.textContent = segment.prompt;
  close.onclick = () => modal.remove();
  heading.append(title, close);
  box.append(heading, pre);
  modal.append(box);
  modal.onclick = (event) => { if (event.target === modal) modal.remove(); };
  document.body.append(modal);
}

function renderSegments() {
  $('clipList').innerHTML = '';
  if (!segments.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'AIで脚本・演技・台詞を生成してください。';
    $('clipList').append(empty);
    return;
  }
  for (const segment of segments) {
    const row = document.createElement('div');
    row.className = 'clip';
    const check = document.createElement('input');
    check.className = 'clip-check';
    check.type = 'checkbox';
    check.checked = true;
    check.dataset.id = segment.id;
    const id = document.createElement('span');
    id.className = 'clip-id';
    id.textContent = segment.id;
    const time = document.createElement('span');
    time.className = 'clip-time';
    time.textContent = `${segment.sourceRange} (${segment.durationSeconds}秒)`;
    const content = document.createElement('span');
    content.className = 'clip-dialogue';
    content.textContent = `${segment.synopsis}／${segment.dialoguePreview}`;
    content.title = content.textContent;
    const button = document.createElement('button');
    button.className = 'ghost';
    button.type = 'button';
    button.textContent = 'Prompt';
    button.onclick = () => showPrompt(segment);
    row.append(check, id, time, content, button);
    $('clipList').append(row);
  }
}

function renderProject() {
  segments = Array.isArray(project?.segments) ? project.segments : [];
  $('exportProject').disabled = !project;
  if (!project) {
    $('aiStatus').textContent = '未生成';
    $('castSummary').innerHTML = '';
    renderSegments();
    return;
  }
  $('aiStatus').textContent = `${project.title}／全${project.totalDurationSeconds}秒／${segments.length}クリップ／参照画像${project.referenceAnalysis?.length || referenceFiles.length}枚`;
  $('outputPrefix').value = safeFilePart(project.title);
  $('castSummary').innerHTML = '';
  for (const cast of project.voiceCast || []) {
    const item = document.createElement('article');
    const heading = document.createElement('strong');
    heading.textContent = `${cast.speakerId || ''} ${cast.characterName || cast.subjectId || 'Voice'}`.trim();
    const description = document.createElement('p');
    description.textContent = cast.voiceDirection || '';
    item.append(heading, description);
    $('castSummary').append(item);
  }
  renderSegments();
}

function projectGenerationForm() {
  if (!referenceFiles.length) throw new Error('参照画像を1枚以上D&Dしてください。');
  if (!$('roughStory').value.trim()) throw new Error('大まかなストーリーを入力してください。');
  const total = Number($('totalDurationSeconds').value);
  const segment = Number($('segmentSeconds').value);
  if (!Number.isFinite(total) || total < 1 || total > 300) throw new Error('全体秒数は1～300秒で指定してください。');
  if (!Number.isFinite(segment) || segment < 1 || segment > 15) throw new Error('1クリップ秒数は1～15秒で指定してください。');
  const form = new FormData();
  for (const [key, value] of Object.entries({
    codexCommand: $('codexCommand').value.trim(), codexModel: $('codexModel').value.trim(), codexTimeoutMinutes: $('codexTimeoutMinutes').value,
    title: $('projectTitle').value.trim(), roughStory: $('roughStory').value.trim(), totalDurationSeconds: total,
    segmentSeconds: segment, animeDirection: $('animeDirection').value, dialogueDensity: $('dialogueDensity').value,
    voiceDirection: $('voiceDirection').value.trim(),
  })) form.append(key, String(value));
  for (const entry of referenceFiles) form.append('images', entry.file, entry.file.name);
  return form;
}

function updateState(next) {
  running = next.running;
  $('startRun').disabled = running;
  $('cancelRun').disabled = !running;
  if (next.current) {
    const done = next.completed.length;
    const pct = next.current.total ? ((done + 0.15) / next.current.total) * 100 : 0;
    $('runTitle').textContent = `${next.current.id} を生成中`;
    $('runDetail').textContent = `${next.current.index} / ${next.current.total} · ${next.current.synopsis || ''}`;
    $('progressBar').style.width = `${pct}%`;
  } else if (!running && next.completed.length) {
    $('runTitle').textContent = next.errors.length ? 'エラーで停止' : '生成完了';
    $('runDetail').textContent = `${next.completed.length}クリップ完了`;
    $('progressBar').style.width = next.errors.length ? '0%' : '100%';
  } else if (!running) {
    $('runTitle').textContent = '待機中';
    $('progressBar').style.width = '0%';
  }
}

$('generateProject').onclick = async () => {
  $('generateProject').disabled = true;
  $('aiStatus').textContent = 'Codex CLIが参照画像を解析し、脚本・演技・台詞・声を設計中…';
  try {
    const response = await fetch('/api/generate-anime-project', { method: 'POST', body: projectGenerationForm() });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    project = result.project;
    renderProject();
    log(`Codex CLI生成完了: ${segments.length}クリップ、声${project.voiceCast?.length || 0}役。`);
  } catch (error) {
    $('aiStatus').textContent = `生成失敗: ${error.message}`;
    log(`AIプロンプト生成エラー: ${error.message}`);
  } finally {
    $('generateProject').disabled = false;
  }
};

$('testCodex').onclick = async () => {
  $('testCodex').disabled = true;
  $('codexBadge').textContent = '確認中…';
  $('codexBadge').classList.remove('ok');
  try {
    const response = await fetch('/api/test-codex', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codexCommand: $('codexCommand').value.trim() }),
    });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    if (result.command) $('codexCommand').value = result.command;
    $('codexBadge').textContent = result.version;
    $('codexBadge').classList.add('ok');
    log(`Codex CLIを確認しました: ${result.version}${result.command ? `（${result.command}）` : ''}`);
  } catch (error) {
    $('codexBadge').textContent = '確認失敗';
    log(`Codex CLI確認エラー: ${error.message}`);
  } finally {
    $('testCodex').disabled = false;
  }
};

$('exportProject').onclick = () => downloadJson(`${safeFilePart(project?.title)}_anime_project.json`, project);
$('importProject').onchange = async () => {
  try {
    const file = $('importProject').files[0];
    if (!file) return;
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.segments) || !imported.segments.length) throw new Error('segmentsがありません。');
    project = imported;
    renderProject();
    log(`生成JSONを読み込みました: ${segments.length}クリップ。`);
  } catch (error) {
    log(`生成JSON読込エラー: ${error.message}`);
  } finally {
    $('importProject').value = '';
  }
};

$('testConnection').onclick = async () => {
  $('connectionBadge').textContent = '確認中…';
  try {
    const response = await fetch('/api/test-connection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comfyUrl: $('comfyUrl').value }) });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    $('connectionBadge').textContent = '接続済み';
    $('connectionBadge').classList.add('ok');
    log('ComfyUIへ接続しました。');
  } catch (error) {
    $('connectionBadge').textContent = '接続失敗';
    $('connectionBadge').classList.remove('ok');
    log(`接続失敗: ${error.message}`);
  }
};

$('workflowFile').onchange = async () => {
  try {
    workflow = JSON.parse(await $('workflowFile').files[0].text());
    const isLink = (value) => Array.isArray(value) && value.length === 2 && workflow[String(value[0])] && Number.isInteger(Number(value[1]));
    nodes = Object.entries(workflow).filter(([, node]) => node && typeof node === 'object' && node.inputs).map(([id, node]) => ({
      id, classType: node.class_type || 'Unknown', title: node._meta?.title || '',
      keys: Object.entries(node.inputs).map(([name, value]) => ({ name, linked: isLink(value), type: Array.isArray(value) ? 'array' : typeof value })),
    })).sort((a, b) => Number(a.id) - Number(b.id));
    if (!nodes.length) throw new Error('API形式のノードが見つかりません。通常のworkflow JSONではなくAPI形式を使用してください。');
    for (const [nodeId, keyId, empty] of [['promptNode', 'promptKey', false], ['filenameNode', 'filenameKey', true]]) {
      fillNodeSelect($(nodeId), empty);
      $(nodeId).onchange = () => fillKeySelect($(nodeId), $(keyId), ['string']);
      $(nodeId).dispatchEvent(new Event('change'));
    }
    choose($('promptNode'), guessNode(['textencode', 'prompt', 'text'], ['text', 'prompt', 'value'], ['string']), ['text', 'prompt', 'value']);
    choose($('filenameNode'), guessNode(['save', 'combine'], ['filename_prefix'], ['string']), ['filename_prefix']);
    $('mappingArea').classList.remove('hidden');
    $('seedMappings').innerHTML = '';
    const seedCandidates = nodes.filter((node) => node.keys.some((key) => !key.linked && key.type === 'number' && ['seed', 'noise_seed'].includes(key.name.toLowerCase())));
    for (const node of seedCandidates) addMapping('seedMappings', 'Seed', node, node.keys.find((key) => !key.linked && key.type === 'number' && ['seed', 'noise_seed'].includes(key.name.toLowerCase()))?.name, ['number']);
    rebuildAutomaticImageSlots();
    const detected = automaticImageSlots.slice(0, referenceFiles.length).filter(Boolean);
    $('workflowSummary').textContent = `${nodes.length}ノードを読み込みました。参照画像${referenceFiles.length}枚に対し画像入力${detected.length}件を自動接続しました。`;
    log(`ref2vaワークフローを読み込みました: ${nodes.length} nodes`);
  } catch (error) {
    workflow = null;
    automaticImageSlots = [];
    renderReferenceImages();
    log(`ワークフロー読込エラー: ${error.message}`);
  }
};

$('addSeedMapping').onclick = () => addMapping('seedMappings', 'Seed', null, null, ['number']);
$('selectReferenceImages').onclick = () => $('referenceImageFiles').click();
$('referenceImageFiles').onchange = () => { addReferenceFiles($('referenceImageFiles').files); $('referenceImageFiles').value = ''; };
const referenceDropZone = $('referenceDropZone');
for (const eventName of ['dragenter', 'dragover']) referenceDropZone.addEventListener(eventName, (event) => { event.preventDefault(); referenceDropZone.classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) referenceDropZone.addEventListener(eventName, (event) => { event.preventDefault(); referenceDropZone.classList.remove('dragging'); });
referenceDropZone.addEventListener('drop', (event) => addReferenceFiles(event.dataTransfer.files));
$('clearLog').onclick = () => { $('log').textContent = ''; };

$('startRun').onclick = async () => {
  try {
    if (!workflow) throw new Error('workflow_api.jsonを読み込んでください。');
    if (!project || !segments.length) throw new Error('AIで脚本・演技・台詞を生成してください。');
    if (!referenceFiles.length) throw new Error('参照画像を1枚以上D&Dしてください。');
    if (!$('comfyInput').value.trim()) throw new Error('ComfyUI inputフォルダーを指定してください。');
    const selected = selectedSegments();
    if (!selected.length) throw new Error('生成するクリップを選択してください。');
    const prepared = ensureH3ReferenceImageSlots(workflow, referenceFiles.length);
    workflow = prepared.workflow;
    automaticImageSlots = prepared.slots;
    if (!prepared.h3NodeId) throw new Error('MiniMax H3 Reference-to-Videoノードをワークフローから検出できませんでした。');
    const pictures = referenceFiles.map((entry, index) => {
      const slot = automaticImageSlots[index];
      if (!slot) throw new Error(`Picture ${index + 1}の画像入力を自動生成できませんでした。`);
      return { file: entry.file, nodeId: slot.nodeId, inputKey: slot.inputKey };
    });
    const mapping = {
      prompt: { nodeId: $('promptNode').value, inputKey: $('promptKey').value },
      filename: { nodeId: $('filenameNode').value, inputKey: $('filenameKey').value },
      images: pictures.map((picture, index) => ({ nodeId: picture.nodeId, inputKey: picture.inputKey, uploadIndex: index })),
      seeds: mappingRows('seedMappings'), baseSeed: Number($('baseSeed').value),
      timeoutMinutes: Number($('timeoutMinutes').value), outputPrefix: $('outputPrefix').value.trim(),
    };
    const form = new FormData();
    form.append('comfyUrl', $('comfyUrl').value.trim());
    form.append('comfyInputDir', $('comfyInput').value.trim());
    form.append('workflowJson', JSON.stringify(workflow));
    form.append('segmentsJson', JSON.stringify(selected));
    form.append('mappingJson', JSON.stringify(mapping));
    for (const picture of pictures) form.append('images', picture.file, picture.file.name);
    const response = await fetch('/api/run', { method: 'POST', body: form });
    const result = await response.json();
    if (!result.ok) throw new Error(result.error);
    log(`${selected.length}クリップを、参照画像${pictures.length}枚とH3ネイティブ音声で連続生成します。`);
  } catch (error) {
    if (error instanceof TypeError && /fetch/i.test(error.message)) log('ローカルサーバーへ接続できません。start_windows.batを再実行してください。');
    else log(`開始できません: ${error.message}`);
  }
};

$('cancelRun').onclick = async () => {
  await fetch('/api/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ comfyUrl: $('comfyUrl').value }) });
  log('停止を要求しました。');
};

const events = new EventSource('/api/events');
for (const type of ['state', 'run-started', 'clip-started', 'progress', 'clip-completed', 'run-completed', 'run-error', 'run-cancelled', 'cancelling']) {
  events.addEventListener(type, (event) => {
    const data = JSON.parse(event.data);
    updateState(data.state);
    if (type === 'clip-started') log(`${data.current.id}: 生成開始`);
    if (type === 'clip-completed') log(`${data.id}: 完了 (${data.promptId})`);
    if (type === 'run-completed') log('すべての生成が完了しました。');
    if (type === 'run-error') log(`生成エラー: ${data.message}`);
    if (type === 'run-cancelled') log('生成を停止しました。');
  });
}

renderReferenceImages();
renderProject();
fetch('/api/diagnostics').then((response) => response.json()).then((data) => log(`ローカルサーバー確認済み (${data.node})`)).catch(() => log('警告: ローカルサーバーの診断APIへ接続できません。'));
