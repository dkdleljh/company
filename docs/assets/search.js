(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CompanySearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Deliberately narrow: spelling mistakes never produce unrelated fuzzy hits.
  const ALIASES = [
    ['opgw', '광섬유복합가공지선'],
    ['rtu', '원격단말장치'],
    ['scada', '원방감시제어'],
  ];
  const CATEGORY_FOLDERS = {
    'OPGW·광통신': ['OPGW 광통신'],
    'RTU·SCADA·EMS': ['RTU SCADA', 'RTU SCADA EMS', 'RTU DB 백업'],
    'TRS·DAS·ADMS': ['TRS', 'DAS ADMS', 'TRS DAS ADMS', 'TRS 환경감시'],
    '설계·공사·감리': ['설계 공사', '설계 메모'],
    '안전·점검·복구': ['점검 안전', '점검 안전 드론'],
    '전원·부대설비': ['전원설비'],
    'ICT 공통': ['업무기준 매뉴얼'],
  };

  function normalize(value) {
    return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR')
      .replace(/([a-z0-9])([가-힣])/g, '$1 $2')
      .replace(/([가-힣])([a-z0-9])/g, '$1 $2')
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  }
  const compact = value => normalize(value).replace(/ /g, '');
  const list = value => Array.isArray(value) ? value : value ? [value] : [];
  const categoriesOf = topic => [...new Set([...list(topic.category), ...list(topic.categories)])];
  const folderKey = value => compact(String(value || '').replace(/^\d+[_\s-]+/, ''));
  const categoryMappings = new Map();
  for (const [category, folders] of Object.entries(CATEGORY_FOLDERS)) {
    for (const folder of folders) categoryMappings.set(folderKey(folder), category);
  }

  function notionId(value) {
    const text = String(value || '').replace(/-/g, '');
    return text.match(/[a-f0-9]{32}/i)?.[0].toLowerCase() || '';
  }
  function sourceIds(relation) {
    return typeof relation === 'string' ? [relation] :
      [relation?.id, relation?.url, relation?.notion_page_id, relation?.relative_path];
  }
  function field(value, weight) {
    const text = normalize(value);
    return {text, compact:text.replace(/ /g, ''), weight};
  }
  function record(item, fields, categories, index) {
    return {item, fields, categories:new Set(categories.map(compact)), index,
      title:normalize(item.title), path:normalize(item.relative_path),
      tie:String(item.id || item.preview_id || item.notion_page_id || item.relative_path || '')};
  }

  function prepare(documents = [], topics = []) {
    const docs = Array.isArray(documents) ? documents : Object.values(documents || {});
    const topicRows = Array.isArray(topics) ? topics : Object.values(topics || {});
    const relationCategories = new Map();
    for (const topic of topicRows) {
      for (const relation of list(topic.source_relations)) {
        for (const source of sourceIds(relation).filter(Boolean)) {
          const key = notionId(source) || String(source);
          const existing = relationCategories.get(key) || new Set();
          categoriesOf(topic).forEach(category => existing.add(category));
          relationCategories.set(key, existing);
        }
      }
    }
    // Duplicate original files may share a large extracted body. Normalize that
    // body once per catalog, retaining separate records and their title weights.
    const bodyFields = new Map();
    function bodyField(value) {
      const source = String(value ?? '');
      if (!bodyFields.has(source)) bodyFields.set(source, field(source, 1));
      return bodyFields.get(source);
    }
    const preparedDocuments = docs.map((doc, index) => {
      const categories = new Set([...list(doc.category), ...list(doc.categories)]);
      for (const source of [doc.notion_page_id, doc.notion_url, doc.relative_path]) {
        const key = notionId(source) || String(source || '');
        for (const category of relationCategories.get(key) || []) categories.add(category);
      }
      const folders = String(doc.relative_path || '').split('/').slice(0, -1);
      for (const folder of [...list(doc.category), ...folders]) {
        const mapped = categoryMappings.get(folderKey(folder));
        if (mapped) categories.add(mapped);
      }
      return record(doc, [
        field(doc.title, 12),
        field(doc.relative_path, 7),
        field([...categories, doc.scope || '', ...list(doc.search_tokens)].join(' '), 3),
        bodyField(doc.search_text),
      ], [...categories], index);
    });
    const preparedTopics = topicRows.map((topic, index) => record(topic, [
      field(topic.title, 12), field(topic.summary, 7),
      field(categoriesOf(topic).join(' '), 3), field(topic.content_markdown, 1),
    ], categoriesOf(topic), index));
    return {documents:preparedDocuments, topics:preparedTopics};
  }

  function termMatches(field, term) {
    // Latin words/acronyms must be complete tokens (RTU must not match Virtuoso).
    // Korean compounds can vary in spacing, so compare their compact forms.
    if (/^[a-z0-9]+$/.test(term)) {
      // Inspect boundaries in place: padding a multi-megabyte body for each
      // query term otherwise allocates and scans a new copy on every keystroke.
      const text = field.text;
      let at = text.indexOf(term);
      while (at !== -1) {
        const end = at + term.length;
        if ((at === 0 || text.charCodeAt(at - 1) === 32) &&
            (end === text.length || text.charCodeAt(end) === 32)) return true;
        at = text.indexOf(term, at + 1);
      }
      return false;
    }
    return field.compact.includes(term.replace(/ /g, ''));
  }
  function queryTerms(query) {
    const tokens = normalize(query).split(' ').filter(Boolean);
    const groups = [];
    const seen = new Set();
    for (let i = 0; i < tokens.length; i++) {
      let alternatives = ALIASES.find(group => group.includes(tokens[i]));
      let end = i;
      // Merge only a complete, explicitly known Korean alias. This makes
      // "원격 단말 장치 운영" equivalent to "RTU 운영" without relaxing AND
      // semantics for unrelated words or splitting Latin acronym boundaries.
      if (!alternatives && /^[가-힣]+$/.test(tokens[i])) {
        let joined = tokens[i];
        for (let j = i + 1; j < tokens.length && /^[가-힣]+$/.test(tokens[j]); j++) {
          joined += tokens[j];
          if (!ALIASES.some(group => group.some(alias => alias.startsWith(joined)))) break;
          const match = ALIASES.find(group => group.includes(joined));
          if (match) { alternatives = match; end = j; break; }
        }
      }
      alternatives ||= [tokens[i]];
      const key = alternatives.join('\u0000');
      if (!seen.has(key)) { groups.push(alternatives); seen.add(key); }
      i = end;
    }
    return groups;
  }
  function relevance(row, terms, phrase) {
    let score = 0;
    for (const alternatives of terms) {
      let best = 0;
      for (const field of row.fields) {
        // Fields are ordered from highest to lowest weight. Once matched, lower
        // fields cannot improve this term's score and need not scan the body.
        if (alternatives.some(term => termMatches(field, term))) { best = field.weight; break; }
      }
      if (!best) return -1;
      score += best;
    }
    if (phrase) {
      const title = row.fields[0];
      if (title.compact === phrase.replace(/ /g, '')) score += 120;
      else if (title.text.includes(phrase)) score += 35;
      else if (title.compact.includes(phrase.replace(/ /g, ''))) score += 25;
    }
    return score;
  }
  function compare(a, b) {
    return a.localeCompare(b, 'ko-KR', {numeric:true});
  }
  function search(rows, query, options = {}) {
    const phrase = normalize(query), terms = queryTerms(query);
    const category = options.category && options.category !== '전체' ? compact(options.category) : '';
    const format = options.format && options.format !== '전체' ? normalize(options.format) : '';
    const results = [];
    for (const row of rows || []) {
      if (category && !row.categories.has(category)) continue;
      if (format && normalize(row.item.format || String(row.item.extension || '').replace(/^\./, '')) !== format) continue;
      const score = relevance(row, terms, phrase);
      if (score >= 0) results.push({row,score});
    }
    const sort = options.sort || 'relevance';
    results.sort((a,b) => {
      let primary = 0;
      if (sort === 'size-desc') primary = (Number(b.row.item.size_bytes) || 0) - (Number(a.row.item.size_bytes) || 0);
      else if (sort === 'path') primary = compare(a.row.path, b.row.path);
      else if (sort === 'relevance' && terms.length) primary = b.score - a.score;
      return primary || compare(a.row.title,b.row.title) || compare(a.row.path,b.row.path) ||
        compare(a.row.tie,b.row.tie) || a.row.index - b.row.index;
    });
    return results.map(result => result.row.item);
  }
  function searchDocuments(prepared, query = '', options = {}) {
    return search(prepared?.documents, query, options);
  }
  function searchTopics(prepared, query = '', options = {}) {
    return search(prepared?.topics, query, options);
  }
  return {normalize, prepare, searchDocuments, searchTopics};
});
