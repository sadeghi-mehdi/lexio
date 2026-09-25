// Generated test corpus for retrieval evaluation. Publisher PDFs cannot be
// committed, so these documents imitate a short paper, a long technical report,
// a table-heavy paper and a Japanese document. Filler text reuses the same
// domain words everywhere, which makes plain keyword matching hard on purpose.
// Planted facts sit on known pages, and each question lists the page(s) that
// must reach the model for a correct answer.

// Small deterministic random generator (mulberry32) so the corpus never changes.
let seed = 1234567;
const random = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (items) => items[Math.floor(random() * items.length)];

const subjects = [
  'The pavement condition survey', 'The asphalt surface layer', 'The crack detection model',
  'The inspection vehicle', 'The maintenance program', 'The field data set', 'The image segmentation step',
  'The road network', 'The monitoring campaign', 'The deterioration model', 'The concrete overlay',
];
const verbs = [
  'was evaluated against', 'was compared with', 'depends strongly on', 'was calibrated using',
  'shows a clear relation to', 'was reviewed together with', 'is sensitive to', 'was adjusted for',
];
const objects = [
  'traffic loading on the outer lane', 'seasonal temperature changes', 'the pavement distress index',
  'manual visual inspection records', 'image resolution and lighting', 'drainage conditions near the shoulder',
  'the age of the asphalt layer', 'crack width measurements', 'the annual maintenance budget',
  'surface roughness readings', 'moisture in the base course', 'the labeling protocol for cracks',
];
const tails = [
  'across all districts', 'during the second survey', 'for each road segment', 'in the validation set',
  'under wet conditions', 'within the study period', 'for the main corridors', 'after resurfacing',
];

// Filler page of roughly the requested length, built from random sentences.
function filler(length) {
  let text = '';
  while (text.length < length) {
    text += `${pick(subjects)} ${pick(verbs)} ${pick(objects)} ${pick(tails)}. `;
    if (random() < 0.15) text += '\n';
  }
  return text.trim();
}

// Builds a document from a page count and planted facts ({ page: text }).
// Facts are inserted in the middle of the filler, like a sentence in a paragraph.
function makeDocument(id, name, pageCount, facts, fillerLength = 1800) {
  const pages = new Map();
  for (let page = 1; page <= pageCount; page++) {
    const body = filler(fillerLength);
    const fact = facts[page];
    if (!fact) {
      pages.set(page, body);
      continue;
    }
    const cut = body.indexOf('. ', Math.floor(body.length / 2)) + 2;
    pages.set(page, `${body.slice(0, cut)}${fact} ${body.slice(cut)}`);
  }
  return { id, name, pages, facts };
}

const shortPaper = makeDocument('paper', 'Deep learning crack detection.pdf', 8, {
  1: 'Abstract. We propose CrackNet-S, a lightweight convolutional network for pixel-level crack segmentation on asphalt pavement images.',
  3: 'The training set contains 4,820 images captured with a line-scan camera mounted 672 mm above the pavement surface.',
  5: 'CrackNet-S reached an F1 score of 0.873 and an intersection over union of 0.781 on the held-out test images.',
  7: 'A limitation of this study is that thin hairline cracks under shadows were often missed; future work will add infrared imaging.',
});

const longReport = makeDocument('report', 'Statewide pavement management report.pdf', 120, {
  12: 'Section 2.3 Methodology. The pavement condition index was computed following ASTM D6433 using 100-foot sample units.',
  33: 'Expenditure for rehabilitation of the Riverside bridge deck totalled 2.3 million dollars in fiscal year 2021.',
  20: 'Table 2 lists the resilient modulus of mixture A at 25 °C.',
  21: 'Table 4 lists the resilient modulus of mixture C at 40 °C.',
  22: 'Table 5 lists the resilient modulus of the base course.',
  23: 'Table 6 lists the resilient modulus of the subgrade soil.',
  24: 'Table 7 lists the resilient modulus of mixture D after aging.',
  47: 'Table 3 lists the resilient modulus of mixture B at 25 °C as 3,450 MPa.',
  48: 'Table 1 summarizes traffic counts for each district.',
  60: 'Appendix A describes the calibration of the roughness profiler.',
  61: 'Appendix B describes the calibration of the ground penetrating radar.',
  62: 'Appendix C describes the calibration of the skid resistance trailer.',
  63: 'Appendix D describes the calibration of the weigh-in-motion scales.',
  65: 'Appendix E describes the calibration of the laser crack measurement system.',
  64: 'Appendix F describes the calibration of the falling weight deflectometer, including sensor spacing of 300 mm.',
  81: 'District 7 recorded the highest share of alligator cracking, affecting 18 percent of lane miles.',
  95: 'The agency recommends a crack sealing interval of three years for low-volume roads.',
  110: 'Rutting deeper than 12 mm was found on 6 percent of the interstate network.',
  // A term split across a line with a hyphen, as PDF text extraction returns it.
  118: 'The committee approved the micro-surfacing pilot and noted that rehabili-\ntation of the northern corridor starts next spring.',
});

const tablePaper = makeDocument('tables', 'Mixture design comparison.pdf', 10, {
  2: 'Table 1 shows the aggregate gradation used for all mixtures.',
  4: 'Table 2 reports the binder content of 5.2 percent for the control mixture.',
  6: 'Table 3 shows rut depth after 20,000 wheel passes: 4.1 mm for the polymer-modified mixture.',
  8: 'Figure 2 plots the fatigue life of the recycled mixture against strain level.',
}, 1200);

const japaneseDoc = {
  id: 'ja',
  name: '舗装点検報告書.pdf',
  pages: new Map([
    [1, '本報告書は市道の舗装点検結果をまとめたものである。調査は二〇二二年に実施した。'],
    [2, '車輪荷重の測定には荷重計を用い、最大値は四十九キロニュートンであった。'],
    [3, 'ひび割れ率は全区間の平均で十二パーセントであった。補修計画を次章に示す。'],
    [4, '補修費用の総額は三億円と見込まれる。優先順位は交通量に基づいて決定した。'],
  ]),
};
japaneseDoc.facts = Object.fromEntries(japaneseDoc.pages);

export const documents = [shortPaper, longReport, tablePaper, japaneseDoc];

// Each question names the documents in scope and the pages that must be sent.
// "kind" groups results so the test can report where retrieval is weak.
// mustInclude: every listed page is required. anyOf: one of them is enough.
export const questions = [
  { q: 'What F1 score did CrackNet-S achieve?', scope: ['paper'], mustInclude: [['paper', 5]], kind: 'exact' },
  { q: 'How high above the pavement was the camera mounted?', scope: ['paper'], mustInclude: [['paper', 3]], kind: 'exact' },
  { q: 'What are the limitations of the study?', scope: ['paper'], mustInclude: [['paper', 7]], kind: 'exact' },
  { q: 'How many images were used for training?', scope: ['paper'], mustInclude: [['paper', 3]], kind: 'exact' },
  { q: 'How was the pavement condition index computed?', scope: ['report'], mustInclude: [['report', 12]], kind: 'exact' },
  { q: 'What does Table 3 show?', scope: ['report'], mustInclude: [['report', 47]], kind: 'reference' },
  { q: 'What is in Appendix F?', scope: ['report'], mustInclude: [['report', 64]], kind: 'reference' },
  { q: 'Which district had the most alligator cracking?', scope: ['report'], mustInclude: [['report', 81]], kind: 'exact' },
  { q: 'How often should cracks be sealed on low-volume roads?', scope: ['report'], mustInclude: [['report', 95]], kind: 'exact' },
  { q: 'How much rutting was found on the interstate network?', scope: ['report'], mustInclude: [['report', 110]], kind: 'exact' },
  { q: 'What is the resilient modulus of mixture B?', scope: ['report'], mustInclude: [['report', 47]], kind: 'exact' },
  { q: 'What sensor spacing was used for the deflectometer?', scope: ['report'], mustInclude: [['report', 64]], kind: 'exact' },
  { q: 'When does rehabilitation of the northern corridor start?', scope: ['report'], mustInclude: [['report', 118]], kind: 'hyphenation' },
  { q: 'How much did it cost to repair the bridge deck?', scope: ['report'], mustInclude: [['report', 33]], kind: 'exact' },
  // No key word in common with page 33: only meaning-based search can find it.
  { q: 'How much money went into fixing the overpass?', scope: ['report'], mustInclude: [['report', 33]], kind: 'paraphrase' },
  { q: 'What price was paid for renovating the viaduct slab?', scope: ['report'], mustInclude: [['report', 33]], kind: 'paraphrase' },
  { q: 'Which part of the state had the worst fatigue fissures?', scope: ['report'], mustInclude: [['report', 81]], kind: 'paraphrase' },
  { q: 'What does Table 3 show?', scope: ['tables'], mustInclude: [['tables', 6]], kind: 'reference' },
  { q: 'What is shown in Table 1?', scope: ['tables'], mustInclude: [['tables', 2]], kind: 'reference' },
  { q: 'What does Figure 2 plot?', scope: ['tables'], mustInclude: [['tables', 8]], kind: 'reference' },
  { q: 'What binder content did the control mixture use?', scope: ['tables'], mustInclude: [['tables', 4]], kind: 'exact' },
  { q: '車輪荷重の最大値は？', scope: ['ja'], mustInclude: [['ja', 2]], kind: 'cjk' },
  { q: '補修費用はいくらですか', scope: ['ja'], mustInclude: [['ja', 4]], kind: 'cjk' },
  { q: 'ひび割れ率', scope: ['ja'], mustInclude: [['ja', 3]], kind: 'cjk' },
  // Questions across several documents.
  { q: 'What rut depth values are reported?', scope: ['report', 'tables'], mustInclude: [['report', 110], ['tables', 6]], kind: 'multi' },
  { q: 'What camera height was used for the crack images?', scope: ['paper', 'report', 'tables'], mustInclude: [['paper', 3]], kind: 'multi' },
  { q: 'What does Table 3 show in each document?', scope: ['report', 'tables'], mustInclude: [['report', 47], ['tables', 6]], kind: 'multi' },
  { q: 'Which F1 score and which crack sealing interval are mentioned?', scope: ['paper', 'report'], mustInclude: [['paper', 5], ['report', 95]], kind: 'multi' },
  { q: 'How were cracks measured in the study and in the report?', scope: ['paper', 'report'], anyOf: [['paper', 3], ['paper', 5], ['report', 81]], kind: 'multi' },
  { q: 'What mixture had 4.1 mm rut depth?', scope: ['paper', 'report', 'tables'], mustInclude: [['tables', 6]], kind: 'multi' },
  // Asked in English about a Japanese document. Neither keyword search nor an
  // English embedding model can bridge languages; kept to show the limit.
  { q: 'What is the total repair cost in the Japanese report?', scope: ['report', 'ja'], mustInclude: [['ja', 4]], kind: 'crosslingual' },
  { q: 'What calibration is described for the deflectometer and what camera was used?', scope: ['paper', 'report'], mustInclude: [['report', 64], ['paper', 3]], kind: 'multi' },
];

// Scores a retriever. It receives the documents in scope, the question and a
// character budget, and returns the text it would send for each page as
// [docId, page, text] triples. A page only counts when its planted fact
// survived into the sent text; a page cut off before the fact does not.
export function evaluateRetriever(retrieve, budget) {
  const byId = new Map(documents.map((document) => [document.id, document]));
  // Whitespace and line-break hyphens are ignored, so a retriever may rejoin
  // hyphenated words or reflow lines without losing credit.
  const normalize = (text) => text.replace(/-\n/g, '').replace(/\s+/g, ' ').trim();
  const results = questions.map((question) => {
    const scope = question.scope.map((id) => byId.get(id));
    const sent = new Map();
    for (const [doc, page, text] of retrieve(scope, question.q, budget)) {
      sent.set(`${doc}:${page}`, `${sent.get(`${doc}:${page}`) || ''} ${normalize(text)}`);
    }
    const found = ([doc, page]) => {
      const fact = normalize(byId.get(doc).facts[page]);
      return (sent.get(`${doc}:${page}`) || '').includes(fact);
    };
    const hit = question.mustInclude ? question.mustInclude.every(found) : question.anyOf.some(found);
    return { ...question, hit };
  });
  const kinds = {};
  for (const result of results) {
    kinds[result.kind] ??= { hit: 0, total: 0 };
    kinds[result.kind].total++;
    if (result.hit) kinds[result.kind].hit++;
  }
  return {
    recall: results.filter((result) => result.hit).length / results.length,
    kinds,
    misses: results.filter((result) => !result.hit).map((result) => result.q),
  };
}
