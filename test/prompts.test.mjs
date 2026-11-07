import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRubricRequest,
  buildRubricFallback,
  parseRubric,
  buildVerifyRequest,
  parseVerify,
  buildFusionPrompt,
  summarizeDelivery,
  extractJson,
} from '../lib/prompts.js';

/* ------------------------------------------------------------------ */
/* 1. heuristic fallback on a messy Chinese prompt                    */
/* ------------------------------------------------------------------ */

test('buildRubricFallback extracts Chinese prompt requirements', () => {
  const rubric = buildRubricFallback(
    '画一只橘猫，坐在窗台上，水彩风格，16:9，不要文字',
  );

  assert.ok(rubric.subject.includes('猫'), `subject: ${rubric.subject}`);
  assert.ok(rubric.scene.includes('窗台'), `scene: ${rubric.scene}`);
  assert.ok(rubric.style.includes('水彩'), `style: ${rubric.style}`);
  assert.equal(rubric.size, '16:9');
  assert.ok(
    rubric.negative.some((entry) => entry.includes('文字')),
    `negative: ${JSON.stringify(rubric.negative)}`,
  );
  assert.ok(rubric.items.length >= 4, `items: ${rubric.items.length}`);
  assert.equal(
    rubric.items.find((item) => item.id === 'size').checkable,
    'programmatic',
  );
  assert.equal(
    rubric.items.find((item) => item.id === 'negative').checkable,
    'programmatic',
  );
});

/* ------------------------------------------------------------------ */
/* 2. parseRubric on a fenced ```json block                           */
/* ------------------------------------------------------------------ */

test('parseRubric parses a fenced json block', () => {
  const raw = [
    'Here is the rubric:',
    '```json',
    JSON.stringify({
      subject: 'a red fox',
      count: 'one fox',
      style: 'watercolor',
      negative: ['text', 'logo'],
      items: [
        {
          id: 'subject',
          category: 'subject',
          requirement: 'a red fox',
          checkable: 'visual',
        },
        {
          id: 'negative',
          category: 'negative',
          requirement: 'no text, no logo',
          checkable: 'programmatic',
        },
      ],
    }),
    '```',
  ].join('\n');

  const rubric = parseRubric(raw);
  assert.equal(rubric.subject, 'a red fox');
  assert.equal(rubric.style, 'watercolor');
  assert.deepEqual(rubric.negative, ['text', 'logo']);
  assert.equal(rubric.items.length, 2);
  assert.equal(rubric.items[1].checkable, 'programmatic');
  assert.equal(rubric.action, '');
});

/* ------------------------------------------------------------------ */
/* 3. garbage input never throws, always yields an item               */
/* ------------------------------------------------------------------ */

test('parseRubric falls back on garbage input', () => {
  const rubric = parseRubric('this is not json at all {{{ broken');
  assert.ok(rubric.items.length >= 1, 'fallback must never return empty items');
  assert.equal(rubric.items[0].id, 'subject');
  assert.ok(rubric.subject.includes('not json'));

  const empty = parseRubric('');
  assert.ok(empty.items.length >= 1);
});

/* ------------------------------------------------------------------ */
/* 4. verify request covers every id and label                        */
/* ------------------------------------------------------------------ */

test('buildVerifyRequest mentions every rubric id and all labels', () => {
  const rubric = buildRubricFallback('画一只橘猫，水彩风格，16:9，不要文字');
  const request = buildVerifyRequest({ rubric, labels: ['A1', 'B1'] });
  const combined = `${request.system}\n${request.user}`;

  assert.equal(typeof request.system, 'string');
  assert.equal(typeof request.user, 'string');
  assert.ok(combined.includes('"images"'));
  assert.ok(combined.includes('overall'));

  for (const item of rubric.items) {
    assert.ok(combined.includes(item.id), `missing itemId ${item.id}`);
  }
  assert.ok(request.user.includes('A1, B1'));
  assert.ok(/1st label is the image at position 1/.test(request.user));
});

/* ------------------------------------------------------------------ */
/* 5. tolerant parseVerify: dropped label, defaulted label, table     */
/* ------------------------------------------------------------------ */

test('parseVerify tolerates unknown labels, missing labels and unknown itemIds', () => {
  const rubric = parseRubric(
    JSON.stringify({
      subject: 'cat',
      style: 'watercolor',
      text: 'HELLO',
      negative: ['text'],
      size: '16:9',
      items: [
        { id: 'subject', category: 'subject', requirement: 'a cat', checkable: 'visual' },
        { id: 'style', category: 'style', requirement: 'watercolor', checkable: 'visual' },
        { id: 'text', category: 'text', requirement: 'HELLO', checkable: 'programmatic' },
      ],
    }),
  );

  const answer = [
    'Sure, here is the audit:',
    '```json',
    JSON.stringify({
      images: [
        {
          label: 'A1',
          strengths: [{ itemId: 'style', note: 'nice wash' }],
          unmet: [
            { itemId: 'text', note: 'missing' },
            { itemId: 'mystery', note: 'should be dropped' },
          ],
          weak: [],
          overall: 78,
        },
        { label: 'Z9', strengths: [], unmet: [], weak: [], overall: 90 },
      ],
    }),
    '```',
  ].join('\n');

  const result = parseVerify(answer, ['A1', 'B1'], rubric);

  assert.equal(result.perImage.length, 2);
  assert.equal(result.perImage[0].label, 'A1');
  assert.equal(result.perImage[0].overall, 78);
  assert.equal(
    result.perImage[0].strengths.some((entry) => entry.itemId === 'mystery'),
    false,
  );
  assert.ok(
    !result.perImage[0].unmet.some((entry) => entry.itemId === 'mystery'),
    'unknown itemId must be dropped',
  );

  const b1 = result.perImage.find((image) => image.label === 'B1');
  assert.deepEqual(b1.strengths, []);
  assert.deepEqual(b1.unmet, []);
  assert.equal(b1.overall, 0);

  assert.equal(result.table.length, rubric.items.length, 'one row per rubric item');
  const styleRow = result.table.find((row) => row.itemId === 'style');
  const textRow = result.table.find((row) => row.itemId === 'text');
  assert.equal(styleRow.marks.A1, 'pass');
  assert.equal(styleRow.marks.B1, 'unknown');
  assert.equal(textRow.marks.A1, 'fail');
  assert.equal(textRow.requirement, 'HELLO');
  assert.ok(result.needsHuman.includes('subject'));
});

/* ------------------------------------------------------------------ */
/* 6. overall clamping                                                */
/* ------------------------------------------------------------------ */

test('parseVerify rounds and clamps overall to 0-100', () => {
  const high = parseVerify(
    JSON.stringify({
      images: [{ label: 'A1', strengths: [], unmet: [], weak: [], overall: 180 }],
    }),
    ['A1'],
  );
  const low = parseVerify(
    JSON.stringify({
      images: [{ label: 'A1', strengths: [], unmet: [], weak: [], overall: -42 }],
    }),
    ['A1'],
  );
  const nan = parseVerify(
    JSON.stringify({
      images: [{ label: 'A1', strengths: [], unmet: [], weak: [], overall: 'n/a' }],
    }),
    ['A1'],
  );

  assert.equal(high.perImage[0].overall, 100);
  assert.equal(low.perImage[0].overall, 0);
  assert.equal(nan.perImage[0].overall, 0);
  assert.ok(Number.isInteger(high.perImage[0].overall));
});

/* ------------------------------------------------------------------ */
/* 7. fusion prompt                                                   */
/* ------------------------------------------------------------------ */

test('buildFusionPrompt fuses fixes, keeps and constraints', () => {
  const rubric = parseRubric(
    JSON.stringify({
      subject: 'a red fox',
      style: 'watercolor style',
      text: 'HELLO',
      negative: ['text', 'logo'],
      size: '16:9',
      items: [
        { id: 'subject', category: 'subject', requirement: 'a red fox in the forest', checkable: 'visual' },
        { id: 'style', category: 'style', requirement: 'watercolor style', checkable: 'visual' },
        { id: 'text', category: 'text', requirement: 'the word HELLO', checkable: 'programmatic' },
        { id: 'negative', category: 'negative', requirement: 'no text, no logo', checkable: 'programmatic' },
        { id: 'size', category: 'size', requirement: '16:9', checkable: 'programmatic' },
      ],
    }),
  );

  const verify = {
    perImage: [
      {
        label: 'A1',
        strengths: [{ itemId: 'subject', note: 'good fox' }],
        unmet: [
          { itemId: 'style', note: 'flat' },
          { itemId: 'text', note: 'text missing' },
        ],
        weak: [],
        overall: 70,
      },
      {
        label: 'B1',
        strengths: [{ itemId: 'style', note: 'great watercolor' }],
        unmet: [],
        weak: [],
        overall: 85,
      },
    ],
    table: [],
    needsHuman: [],
  };

  const prompt = buildFusionPrompt({
    rubric,
    base: { label: 'A1', provider: 'openai' },
    others: [{ label: 'B1', provider: 'comfyui' }],
    verify,
  });

  assert.ok(prompt.startsWith('Edit the first reference image into the final deliverable.'));
  assert.ok(prompt.includes('Keep:'));
  assert.ok(prompt.includes('"a red fox in the forest"'));
  assert.ok(prompt.includes('Fix:'));
  assert.ok(
    prompt.includes('take the style from image B1'),
    `expected style aspect from B1:\n${prompt}`,
  );
  assert.ok(prompt.includes('watercolor style'), 'other-image strength requirement present');
  assert.ok(prompt.includes('Do not change:'));
  assert.ok(prompt.includes('no text'));
  assert.ok(prompt.includes('no logo'));
  assert.ok(prompt.includes('aspect ratio 16:9'));
  assert.ok(prompt.includes('Preserve subject identity and overall composition'));
  assert.ok(!prompt.includes('Z9'), 'must not mention labels of images not present');

  const words = prompt.split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 190, `prompt too long: ${words} words`);
});

/* ------------------------------------------------------------------ */
/* 8. delivery summary                                                */
/* ------------------------------------------------------------------ */

test('summarizeDelivery covers both n=0 and n>0 sentences', () => {
  const rubric = buildRubricFallback('画一只橘猫，水彩风格，16:9');

  const withGaps = {
    perImage: [
      {
        label: 'A1',
        strengths: [
          { itemId: 'subject', note: 'cat' },
          { itemId: 'style', note: 'watercolor' },
        ],
        unmet: [{ itemId: 'size', note: 'cropped' }],
        weak: [],
        overall: 80,
      },
    ],
  };
  const solved = {
    perImage: [
      {
        label: 'A1',
        strengths: [
          { itemId: 'subject', note: 'cat' },
          { itemId: 'style', note: 'watercolor' },
        ],
        unmet: [],
        weak: [],
        overall: 92,
      },
    ],
  };

  const gapSentence = summarizeDelivery({
    rubric,
    finalLabel: 'A1',
    verify: withGaps,
  });
  assert.match(gapSentence, /最终图（A1）/);
  assert.match(gapSentence, /解决了 1 项未满足项/);
  assert.match(gapSentence, /保留了 2 项已验证强项/);
  assert.ok(Array.from(gapSentence).length <= 120);

  const okSentence = summarizeDelivery({ rubric, finalLabel: 'A1', verify: solved });
  assert.match(okSentence, /已覆盖全部可验证需求/);
  assert.match(okSentence, /保留了 2 项强项/);
  assert.ok(Array.from(okSentence).length <= 120);
});

/* ------------------------------------------------------------------ */
/* 9. extractJson ignores braces inside strings                       */
/* ------------------------------------------------------------------ */

test('extractJson handles braces inside strings and escapes', () => {
  const messy =
    'intro {"a":"brace } inside","b":{"c":"quote \\" and }"}} outro';
  assert.equal(
    extractJson(messy),
    '{"a":"brace } inside","b":{"c":"quote \\" and }"}}',
  );

  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson('{"a":1} trailing {"b":2}'), '{"a":1}');
  assert.equal(extractJson('```json\n{"a":{"b":[1,2]}}\n```'), '{"a":{"b":[1,2]}}');
});

/* ------------------------------------------------------------------ */
/* 10. rubric request contract                                        */
/* ------------------------------------------------------------------ */

test('buildRubricRequest produces a strict JSON-only instruction', () => {
  const request = buildRubricRequest('画一只橘猫，水彩风格，16:9');
  assert.equal(typeof request.system, 'string');
  assert.equal(typeof request.user, 'string');
  assert.ok(request.system.includes('ONLY a single JSON object'));
  assert.ok(request.system.includes('"items"'));
  assert.ok(request.system.includes('"programmatic" for negative, count, text and size'));
  assert.ok(request.user.includes('画一只橘猫，水彩风格，16:9'));
});
