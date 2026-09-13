import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFile } from '../../supabase/functions/_shared/askFiles.ts';
import { fileBlob, buildPdf } from './askFiles.js';

test('app images survive validation, reject paths, and count against the budget', () => {
  const image = { asset: 'vagabonde-logo', caption: 'Our company' };
  assert.deepEqual(checkFile({ kind: 'html', text: '<p>Hello</p>', images: [image] }).images, [image]);
  assert.deepEqual(checkFile({ kind: 'pdf', document: { title: 'Report', sections: [{ image }] } }).document.sections[0].image, image);
  for (const asset of ['https://evil.test/a.png', '../brand/wordmark.svg', 'toString']) {
    assert.throws(() => checkFile({ kind: 'html', text: 'Hi', images: [{ asset }] }), /asset/i);
  }
  assert.throws(() => checkFile({ kind: 'html', text: 'x'.repeat(199999), images: [image] }), /budget|most/i);
  assert.throws(() => checkFile({ kind: 'css', text: 'p{}', images: [image] }), /HTML|html/);
});

test('HTML embeds the bundled raster and escapes captions without fetching', async () => {
  const blob = await fileBlob(checkFile({ kind: 'html', text: '<html><body><p>Hello</p></body></html>', images: [{ asset: 'vagabonde-logo', caption: '<b>Company</b>' }] }));
  const html = await blob.text();
  assert.match(html, /data:image\/png;base64,/);
  assert.match(html, /&lt;b&gt;Company&lt;\/b&gt;/);
  assert.match(html, /max-width:100%/);
  assert.ok(blob.size <= 200000);
});

test('PDF embeds proportional logo bytes and writes the caption', async () => {
  const images = [], texts = [];
  class Pdf {
    internal = { pageSize: { getWidth: () => 612, getHeight: () => 792 } };
    setFont() {} setFontSize() {} setTextColor() {}
    splitTextToSize(t) { return [t]; }
    text(t) { texts.push(t); }
    addPage() {}
    addImage(...args) { images.push(args); }
    output() { return new Blob(['pdf']); }
  }
  await buildPdf(Pdf, { title: 'Report', sections: [{ image: { asset: 'vagabonde-logo', caption: 'Company' } }] });
  assert.equal(images.length, 1);
  assert.match(images[0][0], /^data:image\/png;base64,/);
  assert.equal(images[0][1], 'PNG');
  assert.ok(images[0][4] <= 516 && images[0][5] < images[0][4]);
  assert.ok(texts.includes('Company'));
});
