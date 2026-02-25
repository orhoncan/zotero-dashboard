const assert = require('assert');
const formatting = require('../assets/js/features/formatting.js');

function run(name, fn) {
  try {
    fn();
    process.stdout.write(`OK  ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}\n${error.stack}\n`);
    process.exitCode = 1;
  }
}

run('splits glued numbered sections after URL', () => {
  const input = 'Foundation Models for Time Series (2025) — https://arxiv.org/abs/2504.04011 2. Transformer Derlemeleri';
  const out = formatting.postFormatAssistantOutput(input);
  assert.match(out, /2504\.04011\n\n2\. Transformer/);
});

run('converts 1) style numbering to markdown numbering', () => {
  const input = '1) Birinci madde\n2) İkinci madde';
  const out = formatting.postFormatAssistantOutput(input);
  assert.match(out, /^1\. Birinci madde/m);
  assert.match(out, /^2\. İkinci madde/m);
});

run('extracts DOI and URL cards', () => {
  const input = [
    '1. Foundation Models for Time Series (2025)',
    '- DOI: 10.48550/arXiv.2504.04011',
    '- URL: https://arxiv.org/abs/2504.04011',
  ].join('\n');
  const cards = formatting.extractSourceCardsFromText(input);
  assert.ok(cards.length >= 1, 'expected at least one source card');
  const hasDoi = cards.some((card) => String(card.doi || '').includes('10.48550/arxiv.2504.04011'));
  const hasUrl = cards.some((card) => String(card.url || '').includes('arxiv.org/abs/2504.04011'));
  assert.ok(hasDoi, 'expected DOI card');
  assert.ok(hasUrl, 'expected URL card');
});

run('extracts markdown link cards', () => {
  const input = '- [A Survey of Transformer Networks for Time Series Forecasting](https://www.sciencedirect.com/some-paper)';
  const cards = formatting.extractSourceCardsFromText(input);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'A Survey of Transformer Networks for Time Series Forecasting');
  assert.equal(cards[0].url, 'https://www.sciencedirect.com/some-paper');
});

run('deduplicates repeated sources', () => {
  const input = [
    '- DOI: 10.1234/abc.99',
    '- DOI: 10.1234/abc.99',
    '- URL: https://doi.org/10.1234/abc.99',
  ].join('\n');
  const cards = formatting.extractSourceCardsFromText(input);
  assert.equal(cards.length, 1);
});

run('keeps Turkish characters intact', () => {
  const input = 'Özet: Çalışmanın yöntemi, örneklem büyüklüğü ve bulgular değerlendirildi.';
  const out = formatting.postFormatAssistantOutput(input);
  assert.ok(out.includes('Çalışmanın yöntemi'));
});

run('strips inline Sources section when link list exists', () => {
  const input = [
    'Yukarıdaki kaynaklar web aramasıyla doğrulandı.',
    'Sources:',
    '',
    '[Performative Market Making](https://arxiv.org/abs/2508.04344)',
    '[Comparing algorithmic trading strategies](https://www.nber.org/w34054)',
    '',
    'Sonuç: Liste doğrulandı.',
  ].join('\n');
  const out = formatting.stripInlineSourceSection(input);
  assert.ok(!/^\s*Sources:\s*$/im.test(out), 'Sources header should be removed');
  assert.ok(!/Performative Market Making/.test(out), 'Inline source list should be removed');
  assert.ok(/Sonuç: Liste doğrulandı\./.test(out), 'Other content should stay');
});

run('merges same source from markdown link and DOI row', () => {
  const input = [
    '[SAGE Journals](https://journals.sagepub.com/doi/abs/10.1177/21576203251360571)',
    'DOI: 10.1177/21576203251360571',
  ].join('\n');
  const cards = formatting.extractSourceCardsFromText(input);
  assert.equal(cards.length, 1);
  assert.ok(String(cards[0].doi || '').includes('10.1177/21576203251360571'));
});

if (!process.exitCode) {
  process.stdout.write('All formatter regression tests passed.\n');
}
