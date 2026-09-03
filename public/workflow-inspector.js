function isLink(workflow, value) {
  return Array.isArray(value)
    && value.length === 2
    && workflow[String(value[0])]
    && Number.isInteger(Number(value[1]));
}

function referenceNumber(text) {
  const value = String(text || '');
  const forward = value.match(/(?:picture|reference(?:[_\s-]*image)?|ref(?:[_\s-]*image)?|image)[_\s-]*(\d+)(?:$|[_\s-])/i);
  if (forward) return Number(forward[1]);
  const reverse = value.match(/(?:^|[_\s-])(\d+)[_\s-]*(?:picture|reference|ref|image)(?:$|[_\s-])/i);
  return reverse ? Number(reverse[1]) : null;
}

function officialH3ReferenceIndex(inputName) {
  const match = String(inputName || '').match(/^ref_images\.ref_image_(\d+)$/i);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isInteger(index) && index >= 0 && index < 9 ? index : null;
}

function isH3ReferenceNode(node) {
  const label = `${node?.class_type || ''} ${node?._meta?.title || ''}`;
  return /minimax.*h3.*reference.*video|h3.*reference.*video|h3.*r2v/i.test(label)
    || Object.keys(node?.inputs || {}).some((name) => officialH3ReferenceIndex(name) !== null);
}

function cloneWorkflow(workflow) {
  return JSON.parse(JSON.stringify(workflow || {}));
}

function nextNodeId(workflow) {
  const numericIds = Object.keys(workflow).map(Number).filter(Number.isFinite);
  if (numericIds.length) {
    let candidate = Math.max(...numericIds) + 1;
    while (workflow[String(candidate)]) candidate += 1;
    return String(candidate);
  }
  let suffix = 1;
  while (workflow[`h3_auto_load_image_${suffix}`]) suffix += 1;
  return `h3_auto_load_image_${suffix}`;
}

function directCoreLoadImage(workflow, value) {
  if (!isLink(workflow, value)) return null;
  const nodeId = String(value[0]);
  const node = workflow[nodeId];
  if (String(node?.class_type || '').toLowerCase() !== 'loadimage' || Number(value[1]) !== 0) return null;
  const inputKey = editableImageKey(node);
  return inputKey ? { nodeId, inputKey } : null;
}

function editableImageKey(node) {
  if (!node?.inputs) return null;
  const label = `${node.class_type || ''} ${node._meta?.title || ''}`.toLowerCase();
  if (/save|preview/.test(label)) return null;
  const preferredNames = ['image', 'filename', 'file', 'path', 'url', 'image_path', 'image_file', 'image_upload', 'image_url'];
  for (const [name, value] of Object.entries(node.inputs)) {
    if (typeof value === 'string' && preferredNames.includes(name.toLowerCase()) && /image|picture|load|upload/.test(label)) return name;
  }
  for (const [name, value] of Object.entries(node.inputs)) {
    if (typeof value === 'string' && /(?:image|picture|reference|ref).*(?:file|path|upload)?/i.test(name)) return name;
  }
  return null;
}

function traceImageLoader(workflow, startNodeId, visited = new Set()) {
  const nodeId = String(startNodeId);
  if (visited.has(nodeId)) return null;
  visited.add(nodeId);
  const node = workflow[nodeId];
  if (!node) return null;
  const inputKey = editableImageKey(node);
  if (inputKey) return { nodeId, inputKey };
  const upstreamLinks = Object.entries(node.inputs || {})
    .filter(([, value]) => isLink(workflow, value))
    .sort(([nameA], [nameB]) => {
      const a = /image|picture|pixels/i.test(nameA) ? 0 : 1;
      const b = /image|picture|pixels/i.test(nameB) ? 0 : 1;
      return a - b;
    });
  for (const [, value] of upstreamLinks) {
    const found = traceImageLoader(workflow, value[0], visited);
    if (found) return found;
  }
  return null;
}

function collectImageLoaders(workflow, startNodeId, results, visited = new Set()) {
  const nodeId = String(startNodeId);
  if (visited.has(nodeId)) return;
  visited.add(nodeId);
  const node = workflow[nodeId];
  if (!node) return;
  const inputKey = editableImageKey(node);
  if (inputKey) {
    results.push({ nodeId, inputKey });
    return;
  }
  const links = Object.entries(node.inputs || {})
    .filter(([, value]) => isLink(workflow, value))
    .sort(([nameA], [nameB]) => {
      const a = /image|picture|reference|ref|pixels/i.test(nameA) ? 0 : 1;
      const b = /image|picture|reference|ref|pixels/i.test(nameB) ? 0 : 1;
      return a - b;
    });
  for (const [, value] of links) collectImageLoaders(workflow, value[0], results, visited);
}

export function findConnectedImageMappings(workflow) {
  const choices = new Map();
  const consider = (number, mapping, score, source) => {
    if (!Number.isInteger(number) || number < 1 || number > 9 || !mapping) return;
    const previous = choices.get(number);
    if (!previous || score > previous.score) choices.set(number, { ...mapping, score, source });
  };

  for (const [targetId, node] of Object.entries(workflow || {})) {
    if (!node?.inputs) continue;
    const targetLabel = `${node.class_type || ''} ${node._meta?.title || ''}`;
    const targetBonus = /h3|r2v|reference.*video|video.*reference/i.test(targetLabel) ? 100 : 0;
    for (const [inputName, value] of Object.entries(node.inputs)) {
      const officialIndex = officialH3ReferenceIndex(inputName);
      const number = officialIndex === null
        ? referenceNumber(inputName) || (/image|picture|reference|ref/i.test(inputName) ? referenceNumber(targetLabel) : null)
        : officialIndex + 1;
      if (!number) continue;
      if (isLink(workflow, value)) {
        const mapping = traceImageLoader(workflow, value[0]);
        consider(number, mapping, 200 + targetBonus, `Node ${targetId}.${inputName}`);
      } else if (typeof value === 'string' && /image|picture|reference|ref/i.test(inputName)) {
        consider(number, { nodeId: targetId, inputKey: inputName }, 250 + targetBonus, `Node ${targetId}.${inputName} direct`);
      }
    }
  }

  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const inputKey = editableImageKey(node);
    if (!inputKey) continue;
    const number = referenceNumber(`${node._meta?.title || ''} ${node.class_type || ''}`);
    consider(number, { nodeId, inputKey }, 50, `Node ${nodeId} title`);
  }

  return new Map([...choices.entries()].map(([number, value]) => [number, {
    nodeId: value.nodeId,
    inputKey: value.inputKey,
    source: value.source,
  }]));
}

export function listEditableImageInputs(workflow) {
  const results = [];
  for (const [nodeId, node] of Object.entries(workflow || {})) {
    const inputKey = editableImageKey(node);
    if (inputKey) results.push({ nodeId, inputKey });
  }
  return results;
}

export function resolveReferenceImageCount(markdownPictureCount, selectedFileCount) {
  const selected = Math.max(0, Number(selectedFileCount) || 0);
  const markdown = Math.max(0, Number(markdownPictureCount) || 0);
  return selected > 0 ? selected : markdown;
}

/** Complete an API-format MiniMax H3 graph for Picture 1..N. */
export function ensureH3ReferenceImageSlots(sourceWorkflow, count) {
  const required = Math.min(9, Math.max(0, Number(count) || 0));
  const workflow = cloneWorkflow(sourceWorkflow);
  const h3Entry = Object.entries(workflow).find(([, node]) => isH3ReferenceNode(node));
  if (!h3Entry || required === 0) {
    return { workflow, slots: findAutomaticImageSlots(workflow, 9), generated: [], h3NodeId: h3Entry?.[0] || null };
  }

  const [h3NodeId, h3Node] = h3Entry;
  h3Node.inputs ||= {};
  // The explicit requested count is authoritative. Remove optional reference
  // sockets beyond it so a previous multi-image preparation cannot leave an
  // empty LoadImage connected during a one-image run.
  for (let index = required; index < 9; index += 1) {
    const h3InputKey = `ref_images.ref_image_${index}`;
    const value = h3Node.inputs[h3InputKey];
    if (!value) continue;
    delete h3Node.inputs[h3InputKey];
    if (isLink(workflow, value)) {
      const upstreamId = String(value[0]);
      if (workflow[upstreamId]?._meta?.h3_batch_picture) delete workflow[upstreamId];
    }
  }
  const generated = [];
  for (let index = 0; index < required; index += 1) {
    const h3InputKey = `ref_images.ref_image_${index}`;
    const current = h3Node.inputs[h3InputKey];
    // Only a direct core LoadImage output is type-safe here. A graph may contain
    // a LoadImage farther upstream while its final output is CONDITIONING.
    const loader = directCoreLoadImage(workflow, current);
    if (loader) continue;

    const nodeId = nextNodeId(workflow);
    const inputKey = 'image';
    const newNode = {
      class_type: 'LoadImage',
      inputs: { image: '' },
      _meta: {
      title: `Load Image (auto Picture ${index + 1})`,
      h3_batch_picture: index + 1,
      },
    };
    workflow[nodeId] = newNode;
    h3Node.inputs[h3InputKey] = [nodeId, 0];
    generated.push({ picture: index + 1, nodeId, inputKey, h3InputKey });
  }

  const slots = Array(9).fill(null);
  for (let index = 0; index < 9; index += 1) {
    const h3InputKey = `ref_images.ref_image_${index}`;
    const value = h3Node.inputs[h3InputKey];
    if (!isLink(workflow, value)) continue;
    const loader = directCoreLoadImage(workflow, value) || traceImageLoader(workflow, value[0]);
    if (loader) {
      slots[index] = {
        ...loader,
        source: `Node ${h3NodeId}.${h3InputKey}`,
        generated: Boolean(workflow[loader.nodeId]?._meta?.h3_batch_picture),
      };
    }
  }
  const fallback = findAutomaticImageSlots(workflow, 9);
  for (let index = 0; index < slots.length; index += 1) slots[index] ||= fallback[index];
  return { workflow, slots, generated, h3NodeId };
}

export function findAutomaticImageSlots(workflow, limit = 9) {
  const slots = Array(Math.max(0, limit)).fill(null);
  const used = new Set();
  const mappingKey = (mapping) => `${mapping.nodeId}.${mapping.inputKey}`;
  const place = (index, mapping, source) => {
    if (!mapping || index < 0 || index >= slots.length) return;
    const key = mappingKey(mapping);
    if (used.has(key) || slots[index]) return;
    slots[index] = { ...mapping, source };
    used.add(key);
  };

  const numbered = findConnectedImageMappings(workflow);
  for (const [number, mapping] of numbered) place(number - 1, mapping, mapping.source || 'numbered connection');

  const connected = [];
  const targets = Object.entries(workflow || {}).filter(([, node]) => {
    if (!node?.inputs) return false;
    const label = `${node.class_type || ''} ${node._meta?.title || ''}`;
    return /h3|r2v|reference.*video|video.*reference/i.test(label)
      || Object.keys(node.inputs).some((name) => /image|picture|reference|ref/i.test(name));
  }).sort(([, nodeA], [, nodeB]) => {
    const a = /h3|r2v/i.test(`${nodeA.class_type || ''} ${nodeA._meta?.title || ''}`) ? 0 : 1;
    const b = /h3|r2v/i.test(`${nodeB.class_type || ''} ${nodeB._meta?.title || ''}`) ? 0 : 1;
    return a - b;
  });
  for (const [, node] of targets) {
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (!isLink(workflow, value) || !/image|picture|reference|ref/i.test(inputName)) continue;
      collectImageLoaders(workflow, value[0], connected);
    }
  }

  const allEditable = listEditableImageInputs(workflow).sort((a, b) => {
    const aNumber = Number(a.nodeId);
    const bNumber = Number(b.nodeId);
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
    return String(a.nodeId).localeCompare(String(b.nodeId), undefined, { numeric: true });
  });
  const candidates = [...connected, ...allEditable];
  for (const mapping of candidates) {
    const key = mappingKey(mapping);
    if (used.has(key)) continue;
    const emptyIndex = slots.findIndex((slot) => !slot);
    if (emptyIndex < 0) break;
    place(emptyIndex, mapping, connected.includes(mapping) ? 'connected graph order' : 'image node order');
  }
  return slots;
}
