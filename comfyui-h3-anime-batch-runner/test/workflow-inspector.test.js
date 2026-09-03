import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureH3ReferenceImageSlots,
  findAutomaticImageSlots,
  findConnectedImageMappings,
  resolveReferenceImageCount,
} from '../public/workflow-inspector.js';

test('uses exactly the number of dropped reference images', () => {
  assert.equal(resolveReferenceImageCount(4, 1), 1);
  assert.equal(resolveReferenceImageCount(4, 9), 9);
  assert.equal(resolveReferenceImageCount(4, 0), 4);
});

test('maps official zero-based H3 ref image inputs to Picture 1 and Picture 2', () => {
  const workflow = {
    '136': {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        'ref_images.ref_image_0': ['137', 0],
        'ref_images.ref_image_1': ['139', 0],
      },
    },
    '137': { class_type: 'LoadImage', inputs: { image: 'one.png' } },
    '139': { class_type: 'LoadImage', inputs: { image: 'two.png' } },
  };
  const mappings = findConnectedImageMappings(workflow);
  assert.equal(mappings.get(1).nodeId, '137');
  assert.equal(mappings.get(2).nodeId, '139');
});

test('generates missing LoadImage nodes and connects official H3 inputs', () => {
  const workflow = {
    '136': {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: { 'ref_images.ref_image_0': ['137', 0], prompt: ['10', 0] },
    },
    '137': { class_type: 'LoadImage', inputs: { image: 'one.png' }, _meta: { title: 'Load Image' } },
  };
  const result = ensureH3ReferenceImageSlots(workflow, 3);
  assert.equal(result.h3NodeId, '136');
  assert.equal(result.generated.length, 2);
  assert.deepEqual(result.slots.slice(0, 3).map((slot) => slot.nodeId), ['137', '138', '139']);
  assert.deepEqual(result.workflow['136'].inputs['ref_images.ref_image_1'], ['138', 0]);
  assert.deepEqual(result.workflow['136'].inputs['ref_images.ref_image_2'], ['139', 0]);
  assert.equal(result.workflow['138'].class_type, 'LoadImage');
  assert.equal(result.workflow['138'].inputs.image, '');
  assert.equal(workflow['138'], undefined, 'source workflow is not mutated');
});

test('generates all nine H3 reference image nodes without an existing loader', () => {
  const workflow = {
    h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { prompt: 'test' } },
  };
  const result = ensureH3ReferenceImageSlots(workflow, 9);
  assert.equal(result.generated.length, 9);
  assert.equal(result.slots.filter(Boolean).length, 9);
  for (let index = 0; index < 9; index += 1) {
    const link = result.workflow.h3.inputs[`ref_images.ref_image_${index}`];
    assert.ok(Array.isArray(link));
    assert.equal(result.workflow[String(link[0])].class_type, 'LoadImage');
  }
});

test('replaces a CONDITIONING reference link with a direct LoadImage node', () => {
  const workflow = {
    '136': {
      class_type: 'MiniMaxH3ReferenceToVideo',
      inputs: {
        'ref_images.ref_image_0': ['137', 0],
        'ref_images.ref_image_1': ['200', 0],
      },
    },
    '137': { class_type: 'LoadImage', inputs: { image: 'one.png' } },
    '150': { class_type: 'LoadImage', inputs: { image: 'wrong-upstream.png' } },
    '200': { class_type: 'ControlNetApplyAdvanced', inputs: { image: ['150', 0] } },
  };
  const result = ensureH3ReferenceImageSlots(workflow, 2);
  const picture2Link = result.workflow['136'].inputs['ref_images.ref_image_1'];
  assert.notEqual(String(picture2Link[0]), '200');
  assert.equal(picture2Link[1], 0);
  assert.equal(result.workflow[String(picture2Link[0])].class_type, 'LoadImage');
  assert.equal(result.slots[1].nodeId, String(picture2Link[0]));
});

test('a one-image run removes stale optional H3 reference connections', () => {
  const initial = {
    h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: {} },
  };
  const threePictures = ensureH3ReferenceImageSlots(initial, 3).workflow;
  const onePicture = ensureH3ReferenceImageSlots(threePictures, 1);
  assert.ok(onePicture.workflow.h3.inputs['ref_images.ref_image_0']);
  assert.equal(onePicture.workflow.h3.inputs['ref_images.ref_image_1'], undefined);
  assert.equal(onePicture.workflow.h3.inputs['ref_images.ref_image_2'], undefined);
  assert.equal(Object.values(onePicture.workflow).filter((node) => node.class_type === 'LoadImage').length, 1);
  assert.equal(onePicture.slots.filter(Boolean).length, 1);
});

test('uses numbered H3 image connections instead of LoadImage node ID order', () => {
  const workflow = {
    '20': { class_type: 'LoadImage', inputs: { image: 'picture-two.png' }, _meta: { title: 'Load Image' } },
    '90': { class_type: 'LoadImage', inputs: { image: 'picture-one.png' }, _meta: { title: 'Load Image' } },
    '100': {
      class_type: 'MiniMaxH3R2V',
      inputs: { image_1: ['90', 0], image_2: ['20', 0], prompt: ['5', 0] },
      _meta: { title: 'H3 Reference Video' },
    },
  };
  const mappings = findConnectedImageMappings(workflow);
  assert.deepEqual(mappings.get(1), { nodeId: '90', inputKey: 'image', source: 'Node 100.image_1' });
  assert.deepEqual(mappings.get(2), { nodeId: '20', inputKey: 'image', source: 'Node 100.image_2' });
});

test('traces a numbered image connection through processing nodes to LoadImage', () => {
  const workflow = {
    load: { class_type: 'LoadImage', inputs: { image: 'source.png' } },
    resize: { class_type: 'ImageScale', inputs: { image: ['load', 0], width: 1280 } },
    h3: { class_type: 'H3R2V', inputs: { reference_image_3: ['resize', 0] } },
  };
  const mappings = findConnectedImageMappings(workflow);
  assert.equal(mappings.get(3).nodeId, 'load');
  assert.equal(mappings.get(3).inputKey, 'image');
});

test('supports Picture numbers declared in LoadImage titles as a fallback', () => {
  const workflow = {
    '42': { class_type: 'LoadImage', inputs: { image: 'source.png' }, _meta: { title: 'Picture 4' } },
  };
  const mappings = findConnectedImageMappings(workflow);
  assert.equal(mappings.get(4).nodeId, '42');
});

test('does not treat image2video as Picture 2', () => {
  const workflow = {
    load: { class_type: 'LoadImage', inputs: { image: 'source.png' } },
    model: { class_type: 'Image2Video', inputs: { image2video: ['load', 0] } },
  };
  assert.equal(findConnectedImageMappings(workflow).size, 0);
});

test('maps a direct ref_image string input without a separate LoadImage node', () => {
  const workflow = {
    h3: {
      class_type: 'MiniMaxH3R2V',
      inputs: { ref_image_1: 'existing/reference.png', prompt: 'text' },
    },
  };
  const mappings = findConnectedImageMappings(workflow);
  assert.deepEqual(mappings.get(1), {
    nodeId: 'h3', inputKey: 'ref_image_1', source: 'Node h3.ref_image_1 direct',
  });
});

test('automatically orders all image loaders through an image batch connection', () => {
  const workflow = {
    first: { class_type: 'LoadImage', inputs: { image: 'one.png' } },
    second: { class_type: 'LoadImage', inputs: { image: 'two.png' } },
    batch: { class_type: 'ImageBatch', inputs: { image_1: ['first', 0], image_2: ['second', 0] } },
    h3: { class_type: 'MiniMaxH3R2V', inputs: { ref_images: ['batch', 0] } },
  };
  const slots = findAutomaticImageSlots(workflow, 9);
  assert.deepEqual(slots.slice(0, 2).map((slot) => slot.nodeId), ['first', 'second']);
});

test('automatic slots support nine connected LoadImage nodes', () => {
  const workflow = { h3: { class_type: 'H3R2V', inputs: {} } };
  for (let number = 1; number <= 9; number += 1) {
    workflow[`load${number}`] = { class_type: 'LoadImage', inputs: { image: `${number}.png` } };
    workflow.h3.inputs[`ref_image_${number}`] = [`load${number}`, 0];
  }
  const slots = findAutomaticImageSlots(workflow, 9);
  assert.equal(slots.filter(Boolean).length, 9);
  for (let index = 0; index < 9; index += 1) assert.equal(slots[index].nodeId, `load${index + 1}`);
});

test('automatic slots fall back to disconnected image loaders without manual mapping', () => {
  const workflow = {
    '30': { class_type: 'LoadImage', inputs: { image: 'third.png' } },
    '10': { class_type: 'LoadImage', inputs: { image: 'first.png' } },
    '20': { class_type: 'LoadImage', inputs: { image: 'second.png' } },
  };
  const slots = findAutomaticImageSlots(workflow, 9);
  assert.deepEqual(slots.slice(0, 3).map((slot) => slot.nodeId), ['10', '20', '30']);
});
