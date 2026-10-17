#!/usr/bin/env node
'use strict';
// Run against a private decrypted catalog; never writes catalog content or snippets.
// Usage: node tests/search-corpus.cjs /private/path/catalog.json
const fs = require('node:fs');
const crypto = require('node:crypto');
const {performance} = require('node:perf_hooks');
const Search = require('../docs/assets/search.js');

function referenceText(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}
function identity(doc) {
  // Stable opaque identifier only: no document titles, paths, or bodies in output.
  return crypto.createHash('sha256').update(String(doc.notion_page_id || doc.id || doc.relative_path || doc.title)).digest('hex').slice(0,16);
}
function requireCheck(condition, label) {
  if (!condition) throw new Error(`Acceptance failed: ${label}`);
}
function evaluate(catalog) {
  const documents = Array.isArray(catalog.documents) ? catalog.documents : Object.values(catalog.documents || {});
  const topics = Array.isArray(catalog.topics) ? catalog.topics : Object.values(catalog.topics || {});
  requireCheck(documents.length > 0, 'catalog has documents');
  const started = performance.now();
  const prepared = Search.prepare(documents, topics);
  const prepareMs = performance.now() - started;
  const cases = [];
  const run = query => {
    const begin = performance.now();
    const results = Search.searchDocuments(prepared, query);
    cases.push({query, matches:results.length, milliseconds:Number((performance.now()-begin).toFixed(2)),
      topIds:results.slice(0,3).map(identity)});
    return results;
  };
  const bothTitle = (doc, words) => words.every(word => referenceText(doc.title).includes(referenceText(word)));
  const metadataMatch = (doc, words) => words.every(word => referenceText(`${doc.title} ${doc.relative_path}`).includes(referenceText(word)));

  const opgw = run('OPGW 시설');
  requireCheck(documents.some(doc => bothTitle(doc,['OPGW','시설'])), 'OPGW fixture exists in corpus titles');
  requireCheck(opgw.length > 0 && bothTitle(opgw[0],['OPGW','시설']), 'OPGW 시설 ranks a matching title first');

  const mountain = run('팔공산 교체');
  requireCheck(documents.some(doc => bothTitle(doc,['팔공산','교체'])), '팔공산 fixture exists in corpus titles');
  requireCheck(mountain.slice(0,10).some(doc => bothTitle(doc,['팔공산','교체'])), '팔공산 교체 title is in top ten');

  const scada = run('SCADA 운영');
  requireCheck(documents.some(doc => metadataMatch(doc,['SCADA','운영'])), 'SCADA fixture exists in corpus metadata');
  requireCheck(scada.slice(0,10).some(doc => metadataMatch(doc,['SCADA','운영'])), 'SCADA 운영 metadata match is in top ten');
  const exactScadaTitles = documents.filter(doc => bothTitle(doc,['SCADA','운영']));
  if (exactScadaTitles.length) requireCheck(scada.slice(0,10).some(doc => bothTitle(doc,['SCADA','운영'])), 'SCADA 운영 title is in top ten');

  const sortedIdentities = rows => rows.map(identity).sort().join(',');
  for (const [acronym, compactAlias, spacedAlias] of [
    ['RTU','원격단말장치','원격 단말 장치'],
    ['OPGW','광섬유복합가공지선','광섬유 복합 가공 지선'],
  ]) {
    const baseline = run(acronym);
    const compactResults = run(compactAlias);
    const spacedResults = run(spacedAlias);
    requireCheck(baseline.length > 0, `${acronym} alias fixtures exist`);
    requireCheck(sortedIdentities(baseline) === sortedIdentities(compactResults), `${acronym} compact alias returns the same documents`);
    requireCheck(sortedIdentities(compactResults) === sortedIdentities(spacedResults), `${acronym} spaced alias returns the same documents`);
  }

  const absent = 'zxqvnonexistentcorpusprobe987654321';
  requireCheck(!JSON.stringify(catalog).toLowerCase().includes(absent), 'zero-hit probe is absent from input');
  requireCheck(run(`OPGW ${absent}`).length === 0, 'multiword AND excludes an absent second term');
  return {status:'PASS',documents:documents.length,topics:topics.length,
    bodyCharacters:documents.reduce((total,doc)=>total+String(doc.search_text || '').length,0),
    prepareMilliseconds:Number(prepareMs.toFixed(2)),cases,
    note:'Timings are observational, not browser latency guarantees. No source content is included.'};
}

module.exports = {evaluate};
if (require.main === module) {
  if (process.argv.length !== 3) {
    console.error('Usage: node tests/search-corpus.cjs /private/path/catalog.json');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(evaluate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))), null, 2)); }
    catch (error) {
      // JSON parser errors can contain source excerpts. Never echo their messages.
      console.error(error.message.startsWith('Acceptance failed:') ? error.message : 'Cannot evaluate catalog. Check file access and valid JSON.');
      process.exitCode = 1;
    }
  }
}
