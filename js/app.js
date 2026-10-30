/* Tag 选择器 · 前端主逻辑
 * 功能：分类词库点选 / 拖拽排序 / ±加权 / { } ⇄ ( ) 切换 / 正反输出 + 复制清空默认
 *       localStorage 持久化 / 中英显示切换 / R18 开关 / 搜索 / 自定义导入 / 右键 Danbooru / 随机抽取
 */
(() => {
'use strict';

const DEFAULT_NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, '
  + 'fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, '
  + 'watermark, username, blurry, bad feet';

const LS_KEY = 'tagselector.v1';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  index: [],          // [{name,file,nsfw,subs,entries}]
  cats: new Map(),    // name -> {sub: {en: cn}}
  loading: new Map(), // name -> Promise
  current: null,      // 当前分类
  selected: [],       // [{en, cn, w}]
  langEn: false,
  syntax: 'curly',    // curly:{ } | paren:( )
  nsfw: false,
  rand: null,         // {cats:{name:bool}, nsfw:bool}
  seed1girl: true,
  query: '',
};

/* ---------- 工具 ---------- */
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._tm); toast._tm = setTimeout(() => t.hidden = true, 1600);
}
function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      selected: state.selected, langEn: state.langEn, syntax: state.syntax,
      nsfw: state.nsfw, rand: state.rand, neg: $('#out-negative').value, current: state.current,
    }));
  } catch (e) { /* ignore */ }
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (Array.isArray(d.selected)) state.selected = d.selected.filter(x => x && x.en);
    state.langEn = !!d.langEn;
    state.syntax = d.syntax === 'paren' ? 'paren' : 'curly';
    state.nsfw = !!d.nsfw;
    if (d.rand) state.rand = d.rand;
    if (typeof d.current === 'string' && d.current) state.current = d.current;
    if (typeof d.neg === 'string' && d.neg.trim()) $('#out-negative').value = d.neg;
  } catch (e) { /* ignore */ }
}

/* ---------- 输出 ---------- */
function wrapWeight(en, w) {
  if (!w) return en;
  const up = state.syntax === 'paren' ? ['(', ')'] : ['{', '}'];
  if (w > 0) { let s = en; for (let i = 0; i < w; i++) s = up[0] + s + up[1]; return s; }
  let s = en; for (let i = 0; i < -w; i++) s = '[' + s + ']'; return s;
}
function renderOutput() {
  $('#out-positive').value = state.selected.map(x => wrapWeight(x.en, x.w)).join(', ');
}
function renderSelected() {
  const box = $('#selected-list'); box.innerHTML = '';
  $('#sel-count').textContent = state.selected.length + ' 条';
  if (!state.selected.length) {
    box.appendChild(el('div', 'empty', '还没有选中的 tag'));
  } else {
    state.selected.forEach((item, i) => {
      const chip = el('span', 'sel-chip');
      chip.draggable = true; chip.dataset.i = i; chip.dataset.en = item.en;
      const label = el('span', 'chip-label');
      label.innerHTML = (state.langEn ? esc(item.en) : esc(item.cn || item.en)
        + ' <span class="cn-part muted">' + esc(item.en) + '</span>');
      const w = el('span', 'w');
      const minus = el('button', '', '−'); minus.title = '降低权重（[]）';
      const lvl = el('span', 'lvl', item.w > 0 ? '+' + item.w : (item.w < 0 ? String(item.w) : '0'));
      const plus = el('button', '', '+'); plus.title = '提高权重（{ }）';
      minus.onclick = e => { e.stopPropagation(); item.w = Math.max(-3, item.w - 1); renderSelected(); renderOutput(); save(); };
      plus.onclick = e => { e.stopPropagation(); item.w = Math.min(3, item.w + 1); renderSelected(); renderOutput(); save(); };
      w.append(minus, lvl, plus);
      const del = el('button', 'del', '×'); del.title = '删除';
      del.onclick = e => { e.stopPropagation(); state.selected.splice(i, 1); renderSelected(); renderOutput(); save(); markPicked(); };
      chip.append(label, w, del);
      chip.oncontextmenu = ev => { ev.preventDefault(); previewMenu(ev, item, chip); };
      chip.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(i)); e.dataTransfer.effectAllowed = 'move'; chip.classList.add('drag-over'); });
      chip.addEventListener('dragend', () => chip.classList.remove('drag-over'));
      chip.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; chip.classList.add('drag-over'); });
      chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
      chip.addEventListener('drop', e => {
        e.preventDefault(); chip.classList.remove('drag-over');
        const from = +e.dataTransfer.getData('text/plain');
        if (Number.isInteger(from) && from !== i) {
          const [m] = state.selected.splice(from, 1);
          state.selected.splice(i, 0, m);
          renderSelected(); renderOutput(); save();
        }
      });
      box.appendChild(chip);
    });
    markConflicts();
  }
  document.body.classList.toggle('en-only', state.langEn);
}

/* 已选区冲突检测：同组（裁切/时间/天气/姿态/发色/瞳色/视角对）或禁用词高亮 */
function markConflicts() {
  const chips = $$('#selected-list .sel-chip');
  const info = chips.map(c => ({ chip: c, toks: new Set(tokenize(c.dataset.en || '')) }));
  const reasons = new Map();
  const add = (i, r) => { if (!reasons.has(i)) reasons.set(i, new Set()); reasons.get(i).add(r); };
  const groups = [['取景', GROUP_MAX1.crop], ['时间', GROUP_MAX1.time], ['天气', GROUP_MAX1.weather], ['姿态', GROUP_MAX1.pose]];
  for (const [label, set] of groups) {
    const hit = [];
    info.forEach((x, i) => { if ([...x.toks].some(t => set.has(t))) hit.push(i); });
    if (hit.length > 1) hit.forEach(i => add(i, label + '重复'));
  }
  const hair = info.map((x, i) => ({ i, c: [...x.toks].filter(t => COLOR_HAIR.test(t)) })).filter(o => o.c.length);
  if (hair.length > 1) hair.forEach(o => add(o.i, '发色重复'));
  const eyes = info.map((x, i) => ({ i, c: [...x.toks].filter(t => COLOR_EYES.test(t)) })).filter(o => o.c.length);
  if (eyes.length > 1) eyes.forEach(o => add(o.i, '瞳色重复'));
  for (let a = 0; a < info.length; a++) {
    for (let b = a + 1; b < info.length; b++) {
      for (const [x, y] of PAIR_CONFLICT) {
        if ((info[a].toks.has(x) && info[b].toks.has(y)) || (info[a].toks.has(y) && info[b].toks.has(x))) {
          add(a, '视角冲突'); add(b, '视角冲突');
        }
      }
    }
  }
  info.forEach((o, i) => {
    const bad = reasons.get(i);
    o.chip.classList.toggle('conflict', !!bad);
    if (bad) o.chip.title = '冲突：' + [...bad].join('、');
  });
}

/* ---------- 选中动作 ---------- */
function addTag(en, cn, cat) {
  if (state.selected.some(x => x.en === en)) { toast('已经在已选区了：' + en); return; }
  state.selected.push({ en, cn: cn || '', w: 0, cat });
  renderSelected(); renderOutput(); save(); markPicked();
}
function removeTag(en) {
  state.selected = state.selected.filter(x => x.en !== en);
  renderSelected(); renderOutput(); save(); markPicked();
}
function markPicked() {
  const set = new Set(state.selected.map(x => x.en));
  $$('.entry').forEach(n => n.classList.toggle('picked', set.has(n.dataset.en)));
}

/* ---------- 数据 ---------- */
async function loadCat(name) {
  if (state.cats.has(name)) return state.cats.get(name);
  if (state.loading.has(name)) return state.loading.get(name);
  const meta = state.index.find(c => c.name === name);
  if (!meta) throw new Error('未知分类 ' + name);
  const p = fetch('data/merged/' + encodeURIComponent(meta.file))
    .then(r => { if (!r.ok) throw new Error('加载失败 ' + meta.file + ' HTTP ' + r.status); return r.json(); })
    .then(j => { state.cats.set(name, j); state.loading.delete(name); return j; });
  state.loading.set(name, p);
  return p;
}
async function loadAll() {
  await Promise.all(state.index.filter(c => state.nsfw || !c.nsfw).map(c => loadCat(c.name).catch(() => null)));
}

/* ---------- 渲染分类 tab ---------- */
function renderTabs() {
  const nav = $('#tabs'); nav.innerHTML = '';
  state.index.filter(c => state.nsfw || !c.nsfw).forEach(c => {
    const b = el('button', 'tab' + (state.current === c.name ? ' active' : ''), c.name);
    b.appendChild(el('span', 'tab-n', String(c.entries)));
    b.title = c.subs + ' 个小分类 · ' + c.entries + ' 条';
    b.onclick = () => { state.current = c.name; state.query = ''; $('#search').value = ''; renderTabs(); renderDictionary(); save(); };
    nav.appendChild(b);
  });
}

/* ---------- 渲染词库 ---------- */
function entryCard(en, cn) {
  const d = el('div', 'entry');
  d.dataset.en = en;
  d.title = en + (cn && cn !== en ? ' · ' + cn : '');
  const left = el('span', 'en', state.langEn ? en : (cn || en));
  const right = el('span', 'cn', state.langEn ? '' : (cn && cn !== en ? cn : ''));
  const plus = el('span', 'plus', '+');
  d.append(left, right, plus);
  d.onclick = () => addTag(en, cn, state.current);
  d.oncontextmenu = ev => { ev.preventDefault(); previewMenu(ev, { en, cn }, d); };
  return d;
}

function renderAccordion(sub, entries, open) {
  const acc = el('div', 'acc' + (open ? ' open' : ''));
  const head = el('div', 'acc-head');
  const t = el('span', '', sub + ' ');
  const n = el('span', 'muted', '(' + Object.keys(entries).length + ')');
  const caret = el('span', 'caret', '▶');
  head.append(t, n, caret);
  head.onclick = () => acc.classList.toggle('open');
  const body = el('div', 'acc-body');
  Object.entries(entries).forEach(([en, cn]) => body.appendChild(entryCard(en, cn)));
  acc.append(head, body);
  return acc;
}

async function renderDictionary() {
  const box = $('#dictionary'); box.innerHTML = '';
  if (state.query.trim()) return renderSearch(box);
  if (!state.current) {
    const first = state.index.find(c => state.nsfw || !c.nsfw);
    if (first) state.current = first.name; else return;
  }
  box.appendChild(el('div', 'muted hint-line', '正在加载「' + state.current + '」…'));
  let data;
  try { data = await loadCat(state.current); }
  catch (e) { box.innerHTML = ''; box.appendChild(el('div', 'muted', '加载失败：' + e.message)); return; }
  box.innerHTML = '';
  const subs = Object.entries(data);
  subs.forEach(([sub, entries], i) => box.appendChild(renderAccordion(sub, entries, i === 0)));
  markPicked();
}

/* ---------- 搜索 ---------- */
async function renderSearch(box) {
  const q = state.query.trim().toLowerCase();
  box.appendChild(el('div', 'muted hint-line', '搜索中…'));
  await loadAll();
  const toks = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (const c of state.index) {
    const data = state.cats.get(c.name); if (!data) continue;
    for (const [sub, entries] of Object.entries(data)) {
      for (const [en, cn] of Object.entries(entries)) {
        const hay = (en + ' ' + cn + ' ' + sub + ' ' + c.name).toLowerCase();
        if (toks.every(t => hay.includes(t))) hits.push({ c: c.name, sub, en, cn });
        if (hits.length >= 400) break;
      }
      if (hits.length >= 400) break;
    }
    if (hits.length >= 400) break;
  }
  box.innerHTML = '';
  box.appendChild(el('div', 'muted hint-line', '命中 ' + hits.length + ' 条（最多显示 400）'));
  const grouped = new Map();
  for (const h of hits) {
    const key = h.sub;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(h);
  }
  grouped.forEach((list, sub) => {
    const acc = el('div', 'acc open');
    const head = el('div', 'acc-head');
    head.append(el('span', '', sub + ' '), el('span', 'muted', '(' + list.length + ')'), el('span', 'caret', '▶'));
    head.onclick = () => acc.classList.toggle('open');
    const body = el('div', 'acc-body');
    list.forEach(h => {
      const d = el('div', 'entry');
      d.dataset.en = h.en;
      d.append(el('span', 'en', state.langEn ? h.en : (h.cn || h.en)),
        el('span', 'cn', state.langEn ? '' : h.c),
        el('span', 'plus', '+'));
      d.onclick = () => addTag(h.en, h.cn, h.c);
      d.oncontextmenu = ev => { ev.preventDefault(); previewMenu(ev, h, d); };
      body.appendChild(d);
    });
    acc.append(head, body);
    box.appendChild(acc);
  });
  markPicked();
}

/* ---------- 右键菜单 ---------- */
function previewMenu(ev, item, anchor) {
  closePreviewMenu();
  const m = el('div', 'popover'); m.id = 'ctx-menu';
  m.style.left = Math.min(ev.clientX, window.innerWidth - 240) + 'px';
  m.style.top = Math.min(ev.clientY, window.innerHeight - 120) + 'px';
  m.style.width = '200px';
  const t = el('div', 'p-title', item.cn || item.en); m.appendChild(t);
  const row = el('div', 'p-row');
  const isSingle = !item.en.includes(',');
  if (isSingle) {
    const b1 = el('button', 'p-toggle on', 'Danbooru 预览');
    b1.onclick = () => { window.open('https://danbooru.donmai.us/posts?tags=' + encodeURIComponent(item.en), '_blank'); closePreviewMenu(); };
    row.appendChild(b1);
  }
  const b2 = el('button', 'p-toggle on', '复制 tag');
  b2.onclick = () => { copyText(item.en); closePreviewMenu(); };
  row.appendChild(b2);
  m.appendChild(row);
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('mousedown', closePreviewMenu, { once: true }), 0);
}
function closePreviewMenu() { const m = $('#ctx-menu'); if (m) m.remove(); }

/* ---------- 复制 ---------- */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制'); } catch (e2) { toast('复制失败，请手动选择'); }
    ta.remove();
  }
}

/* ---------- 随机引擎 ---------- */
const RANDOM_ORDER = [
  { cat: '人物构成', subs: ['组成', '年龄', '性格', '现实系职业', '幻想系职业'], maxSubs: 2, groups: [['现实系职业', '幻想系职业']] },
  { cat: '头发相关', subs: null },
  { cat: '脸部相关', subs: null },
  { cat: '表情情绪', subs: ['喜', '哀', '怒与厌', '惊与慌', '眼神细节', '嘴部细节', '其他'], maxSubs: 1 },
  { cat: '服装服饰', subs: ['卫衣', '外套', '主体服装', '细节穿搭短语', '裙', '裤', '鞋', '袜', '连衣裙', '裙子', '上衣', '下装', '制服', '便服', '汉服', '和服', '洛丽塔', '正装', '整体造型', '材质纹样'] },
  { cat: '配件配饰', subs: ['头部饰品', '颈胸饰', '手臂腰腿饰', '配饰短语'] },
  { cat: '动作姿态', subs: ['具体坐姿', '站姿', '坐姿', '躺姿', '姿势短语', '手部动作', '移动', '户外', '室内日常', '腿部姿势', '手臂姿势'] },
  { cat: '画面构图', subs: ['取景区域', '区域', '焦点', '构图技巧', '构图短语', '镜头角度', '角度', '远近'] },
  { cat: '光照风格', subs: ['打光技法', '影调', '打光短语', '光', '影'] },
  { cat: '氛围特效', subs: ['特效处理', '氛围营造', '色彩搭配'] },
  { cat: '布景', subs: ['前景元素', '后景元素', '天气时刻'] },
  { cat: '环境场所', subs: null },
];
const RAND_DEFAULT_OFF = new Set(['躯体元素', '物种生物', '画师', 'NSFW内容', '艺术风格']);
const NSFW_SUBS = new Set(['内衣', '情趣', '比基尼', '泳衣', '透视', '开口(身体部位tag也可达露出目的)']);

const COLOR_HAIR = /^(blonde|black|brown|white|red|pink|blue|green|purple|silver|grey|gray|orange|aqua|multicolored|two-tone|gradient|streaked|colored|platinum|auburn|hazel)_hair$/;
const COLOR_EYES = /^(blue|red|green|brown|purple|yellow|orange|pink|black|white|aqua|grey|gray|heterochromia|multicolored|two-tone|gradient|red|gold|silver|hazel)_eyes$/;
const GROUP_MAX1 = {
  crop: new Set(['upper_body', 'lower_body', 'full_body', 'close-up', 'cowboy_shot', 'head_out_of_frame', 'feet_out_of_frame', 'portrait', 'face_only']),
  time: new Set(['night', 'day', 'sunset', 'sunrise', 'dusk', 'dawn', 'noon', 'midday', 'twilight', 'blue_hour', 'golden_hour']),
  weather: new Set(['rain', 'snow', 'clear_sky', 'cloudy', 'fog', 'storm', 'wind']),
  pose: new Set(['standing', 'walking', 'running', 'lying', 'sitting', 'kneeling', 'jumping',
    'climbing', 'swimming', 'squatting', 'crawling', 'on_back', 'on_side', 'on_stomach', 'knees_to_chest']),
};
const PAIR_CONFLICT = [
  ['from_above', 'from_below'], ['from_behind', 'front_view'], ['from_side', 'front_view'],
  ['from_above', 'from_behind'], ['pov', 'from_behind'], ['pov', 'from_above'], ['pov', 'from_below'],
  ['looking_at_viewer', 'from_behind'], ['from_above', 'from_side'],
];
const BAN_TOKENS = new Set(['1boy', 'male', 'crowd', 'male_focus', 'monster', 'tentacles', 'zombie',
  'orc', 'goblin', 'werewolf', 'nude', 'nipples', 'pussy', 'penis', 'sex', 'cum', 'ahegao', 'nsfw',
  'toddler', 'child', 'female_child', 'loli', 'shota', 'oppai_loli', 'underage',
  'naughty', 'female_pervert', 'male_pervert', 'prostitute', 'dominatrix', 'stripper', 'strip_club',
  'bottomless', 'topless', 'naked', 'no_bra', 'no_panties', 'undressing', 'undressed', 'panties',
  'underwear', 'pubic_hair', 'areolae']);
const BAN_RE = /girls|boys/;                     // 多人词一律排除
const HAIRISH = /_hair$|^hair_|_locks$|_braid$|_bangs$/;

function tokenize(en) { return en.toLowerCase().split(',').map(s => s.trim().replace(/ /g, '_')).filter(Boolean); }
function randInt(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[randInt(arr.length)]; }
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function conflictWith(tokens, pickedTokens) {
  for (const t of tokens) { if (BAN_TOKENS.has(t) || (/girls|boys/.test(t)) || t.includes(':')) return true; }
  const pickedSet = pickedTokens;
  for (const t of tokens) {
    if (t === 'bald' && [...pickedSet].some(p => HAIRISH.test(p) && p !== 'bald')) return true;
    if (HAIRISH.test(t) && pickedSet.has('bald')) return true;
    if (GROUP_MAX1.crop.has(t) && [...pickedSet].some(p => GROUP_MAX1.crop.has(p))) return true;
    if (GROUP_MAX1.time.has(t) && [...pickedSet].some(p => GROUP_MAX1.time.has(p))) return true;
    if (GROUP_MAX1.weather.has(t) && [...pickedSet].some(p => GROUP_MAX1.weather.has(p))) return true;
    if (GROUP_MAX1.pose.has(t) && [...pickedSet].some(p => GROUP_MAX1.pose.has(p))) return true;
    if (COLOR_HAIR.test(t) && [...pickedSet].some(p => COLOR_HAIR.test(p) && p !== t)) return true;
    if (COLOR_EYES.test(t) && [...pickedSet].some(p => COLOR_EYES.test(p) && p !== t)) return true;
    for (const [a, b] of PAIR_CONFLICT) {
      if (t === a && pickedSet.has(b)) return true;
      if (t === b && pickedSet.has(a)) return true;
    }
  }
  return false;
}

function defaultRandCats() {
  const o = {};
  for (const c of state.index) o[c.name] = !RAND_DEFAULT_OFF.has(c.name);
  return o;
}

async function randomPick() {
  await loadAll();
  const chosen = [];      // [{en, cn, cat}]
  const pinned = new Set();
  const useNsfw = state.rand && state.rand.nsfw;
  if (state.seed1girl) { chosen.push({ en: '1girl', cn: '一个女孩', cat: '人物构成' }); pinned.add('1girl'); }
  const enabled = (state.rand && state.rand.cats) || defaultRandCats();

  for (const spec of RANDOM_ORDER) {
    if (!enabled[spec.cat]) continue;
    const data = state.cats.get(spec.cat); if (!data) continue;
    let subs = Object.keys(data).filter(s => useNsfw || !NSFW_SUBS.has(s));
    if (spec.subs) subs = subs.filter(s => spec.subs.includes(s));
    if (!subs.length) continue;
    subs = shuffle(subs);
    // 随机跳过部分小分类（配饰类可以没有），至少抽 1 个，最多按规格限制
    const maxSubs = Math.min(subs.length, spec.maxSubs || (spec.cat === '画面构图' ? 2 : 2));
    let n = 1 + (subs.length > 1 && Math.random() < 0.5 ? 1 : 0);
    n = Math.min(n, maxSubs);
    let got = 0;
    for (const sub of subs) {
      if (got >= n) break;
      if (spec.groups && spec.groups.some(g => g.includes(sub)
        && chosen.some(c => c.cat === spec.cat && g.includes(c.sub)))) continue;
      const entries = Object.entries(data[sub]);
      if (!entries.length) continue;
      // 混合：短语优先 30%，普通 tag 70%
      const phrases = entries.filter(([en]) => en.includes(','));
      const pool = (phrases.length && Math.random() < 0.35) ? phrases : entries;
      const [en, cn] = pick(pool);
      const toks = tokenize(en);
      if (conflictWith(toks, new Set([...pinned, ...chosen.flatMap(c => tokenize(c.en))]))) continue;
      chosen.push({ en, cn, cat: spec.cat, sub });
      got++;
    }
  }
  // 服装主体：确保至少一件衣物（从 服装服饰 主体/细节 里优先补）
  if (enabled['服装服饰']) {
    const has = chosen.some(c => c.cat === '服装服饰');
    const data = state.cats.get('服装服饰');
    if (!has && data) {
      const subs = Object.keys(data).filter(s => !NSFW_SUBS.has(s) || useNsfw);
      if (subs.length) {
        const sub = pick(subs);
        const entries = Object.entries(data[sub]);
        if (entries.length) { const [en, cn] = pick(entries); chosen.push({ en, cn, cat: '服装服饰' }); }
      }
    }
  }
  const seen = new Set();
  state.selected = chosen.filter(c => {
    const key = c.en.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(c => ({ en: c.en, cn: c.cn, w: 0, cat: c.cat }));
  renderSelected(); renderOutput(); save(); markPicked();
  closeModal();
  toast('已生成 ' + state.selected.length + ' 条 tag');
}

/* ---------- 随机面板 ---------- */
function openModal() {
  const box = $('#rand-cats'); box.innerHTML = '';
  if (!state.rand) state.rand = { cats: defaultRandCats(), nsfw: false };
  if (!state.rand.cats) state.rand.cats = defaultRandCats();
  $('#chk-rand-nsfw').checked = !!state.rand.nsfw;
  const cats = state.index.filter(c => {
    if (c.name === 'NSFW内容') return false;
    if (c.name === '画师') return true;
    return true;
  });
  cats.forEach(c => {
    const label = el('label');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    cb.checked = !!state.rand.cats[c.name];
    cb.onchange = () => { state.rand.cats[c.name] = cb.checked; save(); label.classList.toggle('on', cb.checked); };
    label.classList.toggle('on', cb.checked);
    label.append(cb, el('span', '', c.name));
    box.appendChild(label);
  });
  $('#rand-modal').hidden = false;
}
function closeModal() { $('#rand-modal').hidden = true; }

/* ---------- 初始化 ---------- */
async function init() {
  load();
  if ($('#out-negative') && !$('#out-negative').value) $('#out-negative').value = DEFAULT_NEG;
  try {
    const r = await fetch('data/merged/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.index = await r.json();
  } catch (e) {
    const hint = location.protocol === 'file:'
      ? '（当前是 file:// 直接打开页面，浏览器禁止读取本地 JSON。请用本地 http 服务预览：在 tag 目录执行 python -m http.server 8000，然后访问 http://127.0.0.1:8000；部署到 GitHub Pages 后则自动正常）'
      : '（请确认 data/merged/index.json 存在）';
    $('#dictionary').innerHTML = '<div class="muted">词库加载失败：' + esc(e.message) + hint + '</div>';
    return;
  }
  const visible = c => state.nsfw || !c.nsfw;
  const saved = state.index.find(c => c.name === state.current && visible(c));
  state.current = saved ? saved.name
    : ((state.index.find(visible) || {}).name || null);
  $('#chk-nsfw').checked = state.nsfw;
  $('#btn-syntax').textContent = state.syntax === 'paren' ? '加权 ( )' : '加权 { }';
  renderTabs();
  await renderDictionary();
  renderSelected();
  renderOutput();
  bindEvents();
}

function bindEvents() {
  $('#btn-lang').onclick = () => {
    state.langEn = !state.langEn;
    renderSelected(); renderOutput();
    if (state.query) renderSearch($('#dictionary')); else renderDictionary();
    save();
  };
  $('#btn-copy-pos').onclick = () => copyText($('#out-positive').value);
  $('#btn-copy-neg').onclick = () => copyText($('#out-negative').value);
  $('#btn-clear-pos').onclick = () => { if (!state.selected.length) return; if (!confirm('清空已选 tag？')) return; state.selected = []; renderSelected(); renderOutput(); save(); markPicked(); };
  $('#btn-clear-neg').onclick = () => { $('#out-negative').value = ''; save(); };
  $('#btn-default-neg').onclick = () => { $('#out-negative').value = DEFAULT_NEG; save(); };
  $('#btn-syntax').onclick = () => {
    state.syntax = state.syntax === 'curly' ? 'paren' : 'curly';
    $('#btn-syntax').textContent = state.syntax === 'paren' ? '加权 ( )' : '加权 { }';
    renderOutput(); save();
  };
  $('#chk-nsfw').onchange = e => {
    state.nsfw = e.target.checked;
    if (!state.nsfw && state.current === 'NSFW内容') state.current = null;
    renderTabs(); renderDictionary(); save();
  };
  let t;
  $('#search').oninput = e => {
    clearTimeout(t);
    t = setTimeout(() => { state.query = e.target.value; renderDictionary(); }, 180);
  };
  $('#btn-custom-add').onclick = () => {
    const raw = $('#custom-input').value.trim(); if (!raw) return;
    const parts = raw.split(/[,\n，]/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    for (const en of parts) {
      if (state.selected.some(x => x.en === en)) continue;
      state.selected.push({ en, cn: '', w: 0, cat: '自定义' }); added++;
    }
    if (!added) toast('没有新增（已存在）');
    $('#custom-input').value = '';
    renderSelected(); renderOutput(); save(); markPicked();
    if (added) toast('已导入 ' + added + ' 条');
  };
  $('#custom-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-custom-add').click(); });
  $('#btn-toggle-all').onclick = () => {
    const accs = $$('#dictionary .acc');
    if (!accs.length) return;
    const anyClosed = accs.some(a => !a.classList.contains('open'));
    accs.forEach(a => a.classList.toggle('open', anyClosed));
    $('#btn-toggle-all').textContent = anyClosed ? '收起全部' : '展开全部';
  };
  $('#btn-random').onclick = openModal;
  $('#btn-rand-close').onclick = closeModal;
  $('#btn-rand-do').onclick = () => { state.rand.nsfw = $('#chk-rand-nsfw').checked; save(); randomPick(); };
  $('#chk-rand-nsfw').onchange = e => { if (!state.rand) state.rand = {}; state.rand.nsfw = e.target.checked; save(); };
  $('#rand-modal').addEventListener('click', e => { if (e.target.id === 'rand-modal') closeModal(); });
  $('#out-negative').addEventListener('input', save);
  window.addEventListener('beforeunload', save);
}

document.addEventListener('DOMContentLoaded', init);
})();

