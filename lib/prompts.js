/**
 * dsh-super-image / prompt & parsing layer (pure, dependency-free).
 *
 * Public API:
 *   buildRubricRequest(userPrompt)  -> { system, user }
 *   buildRubricFallback(userPrompt) -> Rubric
 *   parseRubric(text)               -> Rubric            (never throws)
 *   buildVerifyRequest(input)       -> { system, user }
 *   parseVerify(text, labels[, rubric]) -> VerifyResult  (never throws)
 *   buildFusionPrompt(input)        -> string            (English, <= ~180 words)
 *   summarizeDelivery(input)        -> string            (one Chinese sentence)
 *   extractJson(text)               -> string | null
 *
 * No imports, no Node built-ins, no Date / Math.random. Deterministic.
 */

/* ------------------------------------------------------------------ */
/* constants                                                          */
/* ------------------------------------------------------------------ */

const ITEM_IDS = Object.freeze([
  'subject',
  'count',
  'action',
  'scene',
  'style',
  'composition',
  'color',
  'text',
  'negative',
  'size',
]);

const STRING_FIELDS = Object.freeze([
  'subject',
  'count',
  'action',
  'scene',
  'style',
  'composition',
  'color',
  'text',
  'size',
]);

const CHECKABLE_VALUES = Object.freeze(['visual', 'programmatic', 'needs-human']);

const PROGRAMMATIC_IDS = Object.freeze(['negative', 'count', 'text', 'size']);

const CN_NUM = '零一二两三四五六七八九十百';
const MEASURE =
  '只|个|位|张|朵|条|匹|头|棵|辆|件|名|人|双|对|群|束|杯|盘|幅|座|栋|把|台|部|支|首|篇|则|道|片';

const CN_COUNT_RE = new RegExp(
  `([0-9]+|[${CN_NUM}]+)\\s*(${MEASURE})\\s*([\\u4e00-\\u9fa5A-Za-z]{0,3})`,
);

const EN_COUNT_RE =
  /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+([a-zA-Z][a-zA-Z-]*(?:s|es)?)\b/i;

const TEXT_HINT_RE =
  /写着|写有|写的是|文字|文案|字幕|标题|标语|\btext\b|\bwords?\b|\bcaption\b|\bsays\b/i;

/* Keyword lists, checked in this order (first hit wins). */
const CATEGORY_KEYWORDS = Object.freeze([
  [
    'style',
    [
      '风格',
      '画风',
      '水彩',
      '油画',
      '赛博',
      '像素',
      '写实',
      '动漫',
      '插画',
      '国画',
      '水墨',
      '素描',
      '彩铅',
      '扁平',
      '极简',
      '蒸汽波',
      'illustration',
      'watercolor',
      'watercolour',
      'cyberpunk',
      'anime',
      'oil painting',
      'pixel art',
      'realistic',
      'realism',
      'cartoon',
      'vector',
      'minimalist',
      'flat design',
      'style',
    ],
  ],
  [
    'composition',
    [
      '构图',
      '视角',
      '俯视',
      '仰视',
      '特写',
      '全身',
      '半身',
      '广角',
      '远景',
      '近景',
      'wide shot',
      'close-up',
      'closeup',
      "bird's eye",
      'bird eye',
      'low angle',
      'high angle',
      'full body',
      'composition',
      'framing',
      'viewpoint',
      'perspective',
      'from above',
      'from below',
    ],
  ],
  [
    'color',
    [
      '色彩',
      '色调',
      '光影',
      '暖色',
      '冷色',
      '霓虹',
      'lighting',
      'palette',
      'color',
      'colour',
      'neon',
      'pastel',
      'warm tone',
      'cool tone',
      'contrast',
      'monochrome',
      '黑白',
    ],
  ],
  [
    'scene',
    [
      '背景',
      '场景',
      '森林',
      '城市',
      '海边',
      '海滩',
      '街道',
      '街',
      '室内',
      'studio',
      'background',
      'scene',
      'setting',
      'forest',
      'city',
      'beach',
      'street',
      'indoor',
      'outdoor',
      'bedroom',
      'kitchen',
      'space',
      'desert',
      'mountain',
      'room',
      '窗台',
      '窗边',
      '阳台',
      '草地',
      '花园',
      '天空',
      '夜晚',
      '黄昏',
    ],
  ],
  [
    'action',
    [
      '姿态',
      '动作',
      '站',
      '坐',
      '跑',
      '飞',
      '拿',
      '抱',
      '跳',
      '躺',
      '走',
      '骑',
      'pose',
      'standing',
      'sitting',
      'running',
      'flying',
      'jumping',
      'holding',
      'walking',
      'lying',
      'dancing',
    ],
  ],
]);

const FIX_FALLBACKS = Object.freeze({
  subject: 'rebuild the main subject so it matches the requirement exactly',
  count: 'match the exact count in the requirement, adding or removing subjects as needed',
  action: 'repose the subject so the action matches the requirement',
  scene: 'replace the background and setting to match the required scene',
  style: 'restyle the entire image so the medium and rendering match the requirement',
  composition: 'reframe the shot so the viewpoint and framing match the requirement',
  color: 'correct the palette and lighting to match the requirement',
  text: 'render the required text legibly and exactly, with no spelling errors',
  negative: 'remove the excluded elements completely and repaint the affected area',
  size: 'output the image at the required aspect ratio and framing',
});

const ASPECT_NAMES = Object.freeze({
  subject: 'subject',
  count: 'count',
  action: 'pose',
  scene: 'setting',
  style: 'style',
  composition: 'framing',
  color: 'color and lighting',
  text: 'text',
  negative: 'clean background',
  size: 'aspect ratio',
});

/* ------------------------------------------------------------------ */
/* tiny utilities                                                     */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((part) => toText(part))
      .filter(Boolean)
      .join('，');
  }
  return '';
}

function charLen(text) {
  return Array.from(String(text)).length;
}

/** Clamp a string to `max` code points, appending an ellipsis when cut. */
function clip(text, max) {
  const chars = Array.from(String(text));
  if (chars.length <= max) return String(text);
  return chars.slice(0, max - 1).join('') + '…';
}

function sameLabel(a, b) {
  return toText(a).toLowerCase() === toText(b).toLowerCase();
}

function normalizeLabels(labels) {
  const list = Array.isArray(labels) ? labels : labels == null ? [] : [labels];
  const out = [];
  for (const value of list) {
    const label = toText(value);
    if (!label) continue;
    if (!out.some((existing) => sameLabel(existing, label))) out.push(label);
  }
  return out;
}

function pushUnique(list, value) {
  const text = toText(value);
  if (!text) return;
  if (list.some((existing) => existing.toLowerCase() === text.toLowerCase())) return;
  list.push(text);
}

function joinParts(parts) {
  if (!parts.length) return '';
  const sep = parts.some((part) => /[\u4e00-\u9fa5]/.test(part)) ? '，' : ', ';
  return parts.join(sep);
}

function hasKeyword(clause, keyword) {
  if (/[\u4e00-\u9fa5]/.test(keyword)) return clause.includes(keyword);
  let re = ASCII_KEYWORD_CACHE.get(keyword);
  if (!re) {
    re = new RegExp(
      `(?:^|[^a-z0-9])${escapeRegExp(keyword)}(?:[^a-z0-9]|$)`,
      'i',
    );
    ASCII_KEYWORD_CACHE.set(keyword, re);
  }
  return re.test(clause);
}

const ASCII_KEYWORD_CACHE = new Map();

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ */
/* extractJson                                                       */
/* ------------------------------------------------------------------ */

/**
 * Scan `text` for the first balanced JSON object, ignoring braces that
 * appear inside strings (honouring backslash escapes).
 * Returns the object source or null when no complete object exists.
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text) return null;
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Light repair pass for frequently-seen model JSON slip-ups. */
function repairJson(source) {
  return String(source)
    .replace(/^\uFEFF/, '')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseJsonObject(text) {
  const source = extractJson(typeof text === 'string' ? text : '');
  if (!source) return null;
  try {
    const value = JSON.parse(source);
    return isPlainObject(value) ? value : null;
  } catch {
    try {
      const value = JSON.parse(repairJson(source));
      return isPlainObject(value) ? value : null;
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* rubric shape helpers                                              */
/* ------------------------------------------------------------------ */

function emptyFields() {
  return {
    subject: '',
    count: '',
    action: '',
    scene: '',
    style: '',
    composition: '',
    color: '',
    text: '',
    negative: [],
    size: '',
  };
}

function defaultCheckable(itemId) {
  return PROGRAMMATIC_IDS.includes(itemId) ? 'programmatic' : 'visual';
}

function normalizeNegatives(value) {
  const list = Array.isArray(value)
    ? value
    : value == null
      ? []
      : String(value).split(/[,，;；、\n]/);
  const out = [];
  for (const entry of list) {
    let text = toText(entry);
    if (!text) continue;
    text = text
      .replace(/^(?:不要|没有|无|别|禁止|排除|避免|no\s+|without\s+|not\s+)/i, '')
      .trim();
    if (!text) continue;
    if (!out.some((existing) => existing.toLowerCase() === text.toLowerCase())) {
      out.push(text);
    }
  }
  return out;
}

function requirementFor(fields, itemId) {
  if (itemId === 'negative') {
    const negatives = Array.isArray(fields.negative) ? fields.negative : [];
    return negatives.length ? negatives.map((neg) => `no ${neg}`).join(', ') : '';
  }
  return toText(fields[itemId]);
}

function itemsFromFields(fields) {
  const items = [];
  for (const itemId of ITEM_IDS) {
    const requirement = requirementFor(fields, itemId);
    if (!requirement) continue;
    items.push({
      id: itemId,
      category: itemId,
      requirement,
      checkable: defaultCheckable(itemId),
    });
  }
  if (!items.length) {
    items.push({
      id: 'subject',
      category: 'subject',
      requirement: toText(fields.subject),
      checkable: 'visual',
    });
  }
  return items;
}

function sanitizeItems(rawItems, fields) {
  const items = [];
  if (!Array.isArray(rawItems)) return items;
  for (const raw of rawItems) {
    if (!isPlainObject(raw)) continue;
    const id = toText(raw.id ?? raw.itemId ?? raw.category);
    if (!ITEM_IDS.includes(id)) continue;
    if (items.some((item) => item.id === id)) continue;
    const category = ITEM_IDS.includes(toText(raw.category)) ? toText(raw.category) : id;
    const checkable = CHECKABLE_VALUES.includes(raw.checkable)
      ? raw.checkable
      : defaultCheckable(id);
    let requirement = toText(raw.requirement ?? raw.text ?? raw.note ?? raw.description);
    if (!requirement) requirement = requirementFor(fields, id);
    if (!requirement) continue;
    if (id === 'count' && /^[0-9０-９一二三四五六七八九十百千万两]+$/.test(requirement)) {
      requirement = `数量：${requirement}`;
    }
    items.push({ id, category, requirement, checkable });
  }
  return items;
}

/** Coerce any rubric-like value into the exact public Rubric shape. */
function normalizeRubricShape(input) {
  const source = isPlainObject(input) ? input : {};
  const fields = emptyFields();
  for (const key of STRING_FIELDS) fields[key] = toText(source[key]);
  fields.negative = normalizeNegatives(source.negative);

  let items = sanitizeItems(source.items, fields);
  if (!items.length) items = itemsFromFields(fields);

  return {
    subject: fields.subject,
    count: fields.count,
    action: fields.action,
    scene: fields.scene,
    style: fields.style,
    composition: fields.composition,
    color: fields.color,
    text: fields.text,
    negative: fields.negative.slice(),
    size: fields.size,
    items,
  };
}

/* ------------------------------------------------------------------ */
/* heuristic extraction                                              */
/* ------------------------------------------------------------------ */

function splitClauses(text) {
  return String(text)
    .split(/[,，;；\n\r。]+|\.(?:\s+|$)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function isNegativeClause(clause) {
  if (/^无(?:人|空)的/.test(clause)) return false;
  if (
    /^(?:不要|没有|无|别|禁止|排除|避免|去掉|去除|不出现|不希望)/.test(clause)
  ) {
    return true;
  }
  if (/^(?:not|no|without|exclude|excluding|avoid|remove)\b/i.test(clause)) {
    return true;
  }
  if (/\b(?:no|without|exclude|excluding|avoid)\b/i.test(clause)) return true;
  return /(?:不要|没有|禁止|排除|避免|去掉|去除|不希望)/.test(clause);
}

function stripNegation(clause) {
  let text = String(clause);
  const cn = text.match(/(?:不要|没有|别|禁止|排除|避免|去掉|去除|不希望|不出现)\s*/);
  if (cn && cn.index >= 0) {
    text = text.slice(cn.index + cn[0].length);
  } else {
    const en = text.match(/\b(?:not|no|without|exclude|excluding|avoid|remove)\b\s*/i);
    if (en) text = text.slice(en.index + en[0].length);
  }
  text = text.replace(/^(?:任何|出现|添加|带有|with|any|extra)\s*/i, '');
  return text.trim();
}

function looksLikeSizeClause(clause) {
  if (/^[\s0-9０-９:：x×/.,，]+$/.test(clause)) return true;
  if (
    /^(?:比例|尺寸|大小|画幅|aspect\s*ratio|size|ratio)\s*[:：]?\s*[0-9０-９\s:：x×/]+$/i.test(
      clause,
    )
  ) {
    return true;
  }
  return /^(?:竖版|横版|方图|竖构图|横构图|竖屏|横屏|portrait|landscape|square)$/i.test(
    clause.replace(/[，。.\s]/g, ''),
  );
}

function detectSize(raw) {
  const ratio = raw.match(/(?:^|[^\d])(\d{1,2})\s*[:：x×]\s*(\d{1,2})(?!\d)/);
  if (ratio) {
    const width = Number(ratio[1]);
    const height = Number(ratio[2]);
    if (width >= 1 && height >= 1 && width <= 64 && height <= 64) {
      return `${width}:${height}`;
    }
  }
  if (/竖版|竖构图|竖屏|portrait|vertical/i.test(raw)) return '9:16';
  if (/横版|横构图|横屏|landscape|horizontal/i.test(raw)) return '16:9';
  if (/方图|正方形|square/i.test(raw)) return '1:1';
  return '';
}

function detectCount(raw) {
  const cn = raw.match(CN_COUNT_RE);
  if (cn) {
    const numeral = cn[1];
    const measure = cn[2];
    let noun = cn[3] || '';
    const cut = noun.search(/[坐站跑飞躺走跳骑拿抱在的]/);
    if (cut > 0) noun = noun.slice(0, cut);
    const separator = /^[0-9]+$/.test(numeral) ? ' ' : '';
    return `${numeral}${separator}${measure}${noun}`;
  }
  const en = raw.match(EN_COUNT_RE);
  if (en) return `${en[1]} ${en[2]}`;
  return '';
}

function detectText(raw) {
  const quotedPatterns = [
    /(?:写着|写有|写的是|文字(?:是|为)?|文案(?:是|为)?|字幕(?:是|为)?|标题(?:是|为)?|标语(?:是|为)?|text|words?|caption|says)\s*[:：]?\s*[“"「『]([^”"」』]{1,80})[”"」』]/i,
    /[“「『]([^”」』]{1,80})[”」』]/,
    /"([^"\n]{1,80})"/,
  ];
  for (const pattern of quotedPatterns) {
    const match = raw.match(pattern);
    if (match && match[1] && match[1].trim()) return match[1].trim();
  }
  const afterColon = raw.match(
    /(?:文字|文案|字幕|标题|标语)\s*[:：]\s*([^\s，,。;；]{1,30})/,
  );
  if (afterColon && afterColon[1]) return afterColon[1].trim();
  const afterVerb = raw.match(/写着\s*([^\s，,。;；]{1,20})/);
  if (afterVerb && afterVerb[1]) return afterVerb[1].trim();
  return '';
}

function classifyClause(clause) {
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    for (const keyword of keywords) {
      if (hasKeyword(clause, keyword)) return category;
    }
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* rubric requests                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the LLM request that extracts the requirement rubric.
 * @param {string} userPrompt
 * @returns {{system: string, user: string}}
 */
export function buildRubricRequest(userPrompt) {
  const promptText = toText(userPrompt);
  const system = [
    "You are the requirement-rubric extractor of an image generation pipeline.",
    "Convert the user's drawing request into ONE strict, checkable requirement rubric.",
    'Return ONLY a single JSON object: no markdown, no code fences, no prose before or after.',
    '',
    'Schema:',
    '{"subject":"...","count":"...","action":"...","scene":"...","style":"...","composition":"...","color":"...","text":"...","negative":["..."],"size":"...","items":[{"id":"subject","category":"subject","requirement":"...","checkable":"visual"}]}',
    '',
    'Rules:',
    "- Keep the user's own wording for every field (Chinese stays Chinese); use \"\" for fields the request does not specify and [] when there is no negative list.",
    '- "id" must be exactly one of: subject, count, action, scene, style, composition, color, text, negative, size.',
    '- Only emit items that carry real content from the request; do not invent requirements.',
    '- "subject" is the main entity; "count" is a quantity phrase such as "2 只猫"; "text" is literal text that must appear in the image; "size" is an aspect ratio such as "16:9".',
    '- "negative" lists excluded elements as short nouns/phrases, without "no"/"不要" prefixes.',
    '- checkable is "programmatic" for negative, count, text and size; "visual" for everything else.',
    '- "requirement" restates the requirement so a vision model can verify it from the image.',
  ].join('\n');

  const user = [
    'User drawing request:',
    promptText,
    '',
    'Return the rubric JSON now.',
  ].join('\n');

  return { system, user };
}

/**
 * Deterministic heuristic rubric extractor (used when the model output is
 * unusable). Supports Chinese and English prompts.
 * @param {string} userPrompt
 * @returns {object} Rubric
 */
export function buildRubricFallback(userPrompt) {
  try {
    const raw = toText(userPrompt);
    const fields = emptyFields();

    if (!raw) {
      fields.items = [
        { id: 'subject', category: 'subject', requirement: '', checkable: 'visual' },
      ];
      return fields;
    }

    const normalized = raw
      .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/：/g, ':');

    const text = detectText(raw);
    const size = detectSize(normalized);
    const count = detectCount(normalized);

    const buckets = {
      subject: [],
      action: [],
      scene: [],
      style: [],
      composition: [],
      color: [],
    };
    const negatives = [];

    for (const clause of splitClauses(raw)) {
      const trimmed = clause.trim();
      if (!trimmed) continue;

      if (isNegativeClause(trimmed)) {
        pushUnique(negatives, stripNegation(trimmed));
        continue;
      }
      if (looksLikeSizeClause(trimmed)) continue;
      if (text && trimmed.includes(text)) continue;
      if (text && TEXT_HINT_RE.test(trimmed)) continue;

      const category = classifyClause(trimmed);
      if (category && buckets[category]) buckets[category].push(trimmed);
      else buckets.subject.push(trimmed);
    }

    fields.subject = joinParts(buckets.subject);
    fields.action = joinParts(buckets.action);
    fields.scene = joinParts(buckets.scene);
    fields.style = joinParts(buckets.style);
    fields.composition = joinParts(buckets.composition);
    fields.color = joinParts(buckets.color);
    fields.count = count;
    fields.size = size;
    fields.text = text;
    fields.negative = negatives;

    const hasAny =
      fields.subject ||
      fields.action ||
      fields.scene ||
      fields.style ||
      fields.composition ||
      fields.color ||
      fields.count ||
      fields.size ||
      fields.text ||
      fields.negative.length > 0;

    // "Never return empty items": no requirement matched at all -> the whole
    // trimmed prompt becomes the subject requirement.
    if (!hasAny) fields.subject = raw;

    return normalizeRubricShape(fields);
  } catch {
    return {
      subject: '',
      count: '',
      action: '',
      scene: '',
      style: '',
      composition: '',
      color: '',
      text: '',
      negative: [],
      size: '',
      items: [{ id: 'subject', category: 'subject', requirement: '', checkable: 'visual' }],
    };
  }
}

/* ------------------------------------------------------------------ */
/* rubric parsing                                                    */
/* ------------------------------------------------------------------ */

/**
 * Parse a model answer into a Rubric. Never throws: unparsable input falls
 * back to the deterministic heuristic extractor.
 * @param {string} text
 * @returns {object} Rubric
 */
export function parseRubric(text) {
  const raw = typeof text === 'string' ? text : text == null ? '' : String(text);
  try {
    if (!raw.trim()) return buildRubricFallback(raw);

    let data = parseJsonObject(raw);
    if (!data) return buildRubricFallback(raw);

    if (Array.isArray(data)) {
      data = data.find((entry) => isPlainObject(entry)) || null;
      if (!data) return buildRubricFallback(raw);
    }

    return normalizeRubricShape(data);
  } catch {
    return buildRubricFallback(raw);
  }
}

/* ------------------------------------------------------------------ */
/* verify requests                                                   */
/* ------------------------------------------------------------------ */

/**
 * Build the VLM verification request.
 * @param {{rubric: object, labels: string[]}} input
 * @returns {{system: string, user: string}}
 */
export function buildVerifyRequest(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const rubric = normalizeRubricShape(source.rubric);
  const labels = normalizeLabels(source.labels);

  const system = [
    'You are a strict visual requirement auditor.',
    'You receive a numbered requirement rubric and one or more generated images, each identified by a label.',
    'Judge every image against every rubric item by actually looking at the image. Never guess: if an item cannot be judged from the image, omit it from the arrays and list its itemId in "needsHuman".',
    'Return ONLY one JSON object: no markdown, no code fences, no prose.',
    '',
    'Schema:',
    '{"images":[{"label":"A1","strengths":[{"itemId":"style","note":"..."}],"unmet":[{"itemId":"text","note":"..."}],"weak":[],"overall":78}],"needsHuman":["size"]}',
    '',
    'Rules:',
    '- "label" must be one of the provided image labels, copied exactly.',
    '- "itemId" must be one of the provided rubric itemIds. Never invent itemIds.',
    '- strengths = satisfied and clearly visible; unmet = missing or violated; weak = present but only partially satisfied.',
    '- "overall" is an integer from 0 to 100 for the whole image.',
    '- Return exactly one entry per provided image, in the provided order.',
  ].join('\n');

  const rubricLines = rubric.items.length
    ? rubric.items.map(
        (item, index) =>
          `${index + 1}. itemId: ${item.id} | category: ${item.category} | checkable: ${item.checkable} | requirement: ${item.requirement}`,
      )
    : ['1. (no rubric items provided)'];

  const labelLine = labels.length
    ? `Image labels in order (the 1st label is the image at position 1, the 2nd label is the image at position 2, and so on): ${labels.join(', ')}`
    : 'Image labels: (none provided)';

  const user = [
    'Requirement rubric (use these exact itemIds):',
    ...rubricLines,
    '',
    labelLine,
    '',
    'Audit each image against every rubric item and return the JSON object now.',
  ].join('\n');

  return { system, user };
}

/* ------------------------------------------------------------------ */
/* verify parsing                                                    */
/* ------------------------------------------------------------------ */

function clampScore(value) {
  const numeric = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function readEntries(value, knownIds) {
  const out = [];
  if (!Array.isArray(value)) return out;
  for (const entry of value) {
    if (typeof entry === 'string') {
      const itemId = entry.trim();
      if (!itemId) continue;
      if (knownIds && !knownIds.includes(itemId)) continue;
      if (out.some((existing) => existing.itemId === itemId)) continue;
      out.push({ itemId, note: '' });
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const itemId = toText(entry.itemId ?? entry.id ?? entry.category);
    if (!itemId) continue;
    if (knownIds && !knownIds.includes(itemId)) continue;
    if (out.some((existing) => existing.itemId === itemId)) continue;
    out.push({ itemId, note: toText(entry.note ?? entry.reason ?? entry.evidence ?? entry.comment) });
  }
  return out;
}

function dedupeEntries(value) {
  return readEntries(value, null);
}

function emptyPerImage(labels) {
  return labels.map((label) => ({
    label,
    strengths: [],
    unmet: [],
    weak: [],
    overall: 0,
  }));
}

function assembleVerify(perImage, rubric, data) {
  const requirementById = new Map();
  if (rubric) {
    for (const item of rubric.items) requirementById.set(item.id, item.requirement);
  }
  if (data) {
    if (Array.isArray(data.items)) {
      for (const item of data.items) {
        const id = toText(item && (item.id ?? item.itemId));
        const requirement = toText(item && (item.requirement ?? item.text));
        if (id && requirement && !requirementById.has(id)) {
          requirementById.set(id, requirement);
        }
      }
    }
    if (Array.isArray(data.table)) {
      for (const row of data.table) {
        const id = toText(row && (row.itemId ?? row.id));
        const requirement = toText(row && (row.requirement ?? row.text));
        if (id && requirement && !requirementById.has(id)) {
          requirementById.set(id, requirement);
        }
      }
    }
  }

  const itemIds = [];
  if (rubric) {
    for (const item of rubric.items) itemIds.push(item.id);
  }
  for (const image of perImage) {
    for (const key of ['strengths', 'unmet', 'weak']) {
      for (const entry of image[key]) {
        if (!itemIds.includes(entry.itemId)) itemIds.push(entry.itemId);
      }
    }
  }

  const table = itemIds.map((itemId) => {
    const marks = {};
    for (const image of perImage) {
      const failed = image.unmet.some((entry) => entry.itemId === itemId);
      const weak = image.weak.some((entry) => entry.itemId === itemId);
      const passed = image.strengths.some((entry) => entry.itemId === itemId);
      marks[image.label] = failed ? 'fail' : weak ? 'weak' : passed ? 'pass' : 'unknown';
    }
    return {
      itemId,
      requirement: requirementById.get(itemId) || itemId,
      marks,
    };
  });

  const needsHuman = [];
  if (data && Array.isArray(data.needsHuman)) {
    for (const value of data.needsHuman) {
      const id = toText(value);
      if (id) pushUnique(needsHuman, id);
    }
  }
  for (const row of table) {
    const labels = Object.keys(row.marks);
    if (
      labels.length > 0 &&
      labels.every((label) => row.marks[label] === 'unknown')
    ) {
      pushUnique(needsHuman, row.itemId);
    }
  }

  return { perImage, table, needsHuman };
}

/**
 * Tolerant verification-answer parser. Never throws.
 *
 * @param {string} text
 * @param {string[]} labels expected image labels, in order
 * @param {object} [rubric] optional rubric; when supplied, itemIds outside it
 *   are rejected and every rubric item gets a table row
 * @returns {object} VerifyResult
 */
export function parseVerify(text, labels = [], rubric = null) {
  const expectedLabels = normalizeLabels(labels);
  let normalizedRubric = null;
  try {
    normalizedRubric = rubric ? normalizeRubricShape(rubric) : null;
  } catch {
    normalizedRubric = null;
  }

  try {
    const data = parseJsonObject(text);
    const knownIds = normalizedRubric
      ? normalizedRubric.items.map((item) => item.id)
      : null;

    const rawImages = Array.isArray(data && data.images)
      ? data.images
      : Array.isArray(data && data.perImage)
        ? data.perImage
        : [];

    const byLabel = new Map();
    for (const rawImage of rawImages) {
      if (!isPlainObject(rawImage)) continue;
      const label = toText(rawImage.label);
      const match = expectedLabels.find((expected) => sameLabel(expected, label));
      if (!match) continue; // unknown label -> dropped
      if (!byLabel.has(match)) byLabel.set(match, rawImage);
    }

    const perImage = expectedLabels.map((label) => {
      const rawImage = byLabel.get(label) || {};
      return {
        label,
        strengths: readEntries(rawImage.strengths, knownIds),
        unmet: readEntries(rawImage.unmet, knownIds),
        weak: readEntries(rawImage.weak, knownIds),
        overall: clampScore(rawImage.overall),
      };
    });

    return assembleVerify(perImage, normalizedRubric, data);
  } catch {
    return assembleVerify(emptyPerImage(expectedLabels), normalizedRubric, null);
  }
}

/* ------------------------------------------------------------------ */
/* fusion prompt                                                     */
/* ------------------------------------------------------------------ */

function requirementResolver(rubric) {
  return (itemId) => {
    if (rubric) {
      const item = rubric.items.find((entry) => entry.id === itemId);
      if (item && item.requirement) return item.requirement;
    }
    return String(itemId);
  };
}

function wordCount(text) {
  return String(text).split(/\s+/).filter(Boolean).length;
}

/**
 * Build the English edit/generation instruction for fusion.
 * @param {{rubric: object, base: object, others: object[], verify: object}} input
 * @returns {string}
 */
export function buildFusionPrompt(input = {}) {
  try {
    const source = isPlainObject(input) ? input : {};
    const rubric = normalizeRubricShape(source.rubric);
    const baseLabel = toText(source.base && source.base.label) || 'base';
    const others = (Array.isArray(source.others) ? source.others : []).filter(
      (entry) => isPlainObject(entry) && toText(entry.label) && !sameLabel(entry.label, baseLabel),
    );
    const perImage = Array.isArray(source.verify && source.verify.perImage)
      ? source.verify.perImage
      : [];
    const findImage = (label) =>
      perImage.find((entry) => isPlainObject(entry) && sameLabel(entry.label, label)) || {
        strengths: [],
        unmet: [],
        weak: [],
        overall: 0,
      };

    const reqOf = requirementResolver(rubric);
    const baseImage = findImage(baseLabel);
    const strengths = dedupeEntries(baseImage.strengths);
    const unmet = dedupeEntries(baseImage.unmet);

    const keep = [];
    for (const strength of strengths.slice(0, 6)) {
      const requirement = clip(reqOf(strength.itemId), 70);
      const quoted = `"${requirement}"`;
      if (!keep.includes(quoted)) keep.push(quoted);
    }

    const fixLines = [];
    const fixedIds = new Set();
    for (const entry of unmet) {
      fixedIds.add(entry.itemId);
      const requirement = clip(reqOf(entry.itemId), 70);
      const helper = others.find((other) => {
        const image = findImage(other.label);
        return Array.isArray(image.strengths) && image.strengths.some(
          (strength) => strength.itemId === entry.itemId,
        );
      });
      if (helper) {
        fixLines.push(
          `Fix ${requirement} — take the ${ASPECT_NAMES[entry.itemId] || entry.itemId} from image ${toText(helper.label)}.`,
        );
      } else {
        fixLines.push(
          `Fix ${requirement} — ${FIX_FALLBACKS[entry.itemId] || 'adjust the image so it matches the requirement'}.`,
        );
      }
    }

    const doNotChange = [];
    for (const strength of strengths) {
      if (fixedIds.has(strength.itemId)) continue;
      const requirement = clip(reqOf(strength.itemId), 28);
      if (requirement && !doNotChange.includes(requirement)) doNotChange.push(requirement);
    }

    const constraints = [];
    for (const negative of rubric.negative) constraints.push(`no ${negative}`);
    if (rubric.size) constraints.push(`output aspect ratio ${rubric.size}`);
    constraints.push(
      'Preserve subject identity and overall composition unless a fix requires changing it',
    );

    const render = () => {
      const lines = ['Edit the first reference image into the final deliverable.', ''];
      if (keep.length) lines.push(`Keep: ${keep.join('; ')}.`);
      lines.push(
        fixLines.length
          ? `Fix: ${fixLines.join(' ')}`
          : 'Fix: none — keep the current image as is.',
      );
      if (doNotChange.length) lines.push(`Do not change: ${doNotChange.join(', ')}.`);
      lines.push(`Constraints: ${constraints.join('; ')}.`);
      return lines.join('\n');
    };

    let prompt = render();
    let guard = 0;
    while (wordCount(prompt) > 180 && keep.length > 0 && guard < 10) {
      keep.pop();
      prompt = render();
      guard += 1;
    }
    guard = 0;
    while (wordCount(prompt) > 180 && doNotChange.length > 3 && guard < 10) {
      doNotChange.pop();
      prompt = render();
      guard += 1;
    }
    return prompt;
  } catch {
    return 'Edit the first reference image into the final deliverable.';
  }
}

/* ------------------------------------------------------------------ */
/* delivery summary                                                  */
/* ------------------------------------------------------------------ */

/**
 * One Chinese sentence describing the final delivery. Never throws.
 * @param {{rubric: object, finalLabel: string, verify: object}} input
 * @returns {string}
 */
export function summarizeDelivery(input = {}) {
  try {
    const source = isPlainObject(input) ? input : {};
    const rubric = normalizeRubricShape(source.rubric);
    const label = toText(source.finalLabel) || 'final';
    const perImage = Array.isArray(source.verify && source.verify.perImage)
      ? source.verify.perImage
      : [];
    const finalImage =
      perImage.find((entry) => isPlainObject(entry) && sameLabel(entry.label, label)) || {
        strengths: [],
        unmet: [],
        weak: [],
        overall: 0,
      };

    const unmet = dedupeEntries(finalImage.unmet);
    const strengths = dedupeEntries(finalImage.strengths);
    const n = unmet.length;
    const m = strengths.length;

    if (n === 0) {
      return clip(
        `最终图（${label}）已覆盖全部可验证需求，保留了 ${m} 项强项。`,
        120,
      );
    }

    const reqOf = requirementResolver(rubric);
    const names = [];
    for (const entry of unmet) {
      const requirement = reqOf(entry.itemId);
      if (requirement && !names.includes(requirement)) names.push(requirement);
    }
    const shown = names.slice(0, 3);

    const build = () =>
      `最终图（${label}）解决了 ${n} 项未满足项（${shown.join('、')}），保留了 ${m} 项已验证强项。`;

    let sentence = build();
    while (charLen(sentence) > 120 && shown.length > 1) {
      shown.pop();
      sentence = build();
    }
    if (charLen(sentence) > 120 && shown.length) {
      shown[0] = clip(shown[0], Math.max(4, charLen(shown[0]) - (charLen(sentence) - 120)));
      sentence = build();
    }
    return clip(sentence, 120);
  } catch {
    return '最终图已生成，但无法解析验证结果。';
  }
}
