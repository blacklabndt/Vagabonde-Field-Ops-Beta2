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

test('PDF fits different shared images and wrapped captions together after a page break', async () => {
  const images = [], texts = [], loads = [];
  let page = 1;
  class Pdf {
    internal = { pageSize: { getWidth: () => 612, getHeight: () => 792 } };
    setFont() {} setFontSize() {} setTextColor() {}
    splitTextToSize(t) { return String(t).split('\n'); }
    text(t, x, y) { texts.push({t,x,y,page}); }
    addPage() { page++; }
    addImage(...args) { images.push({args,page}); }
    output() { return new Blob(['pdf']); }
  }
  const loader = async path => { loads.push(path); return {data:path,format:'JPEG',width:600,height:1200,alias:path}; };
  await buildPdf(Pdf, {title:'Photos',sections:[
    {text:Array(40).fill('body').join('\n')},
    {image:{shared_path:'a.jpg',caption:'Line one\nLine two\nLine three'}},
    {image:{shared_path:'b.jpg',caption:'Another photo'}}
  ]}, {loadSharedImage:loader});
  assert.deepEqual(loads, ['a.jpg','b.jpg']);
  assert.equal(images.length, 2);
  assert.notEqual(images[0].args[6], images[1].args[6]);
  for (const image of images) {
    const [,format,x,y,w,h] = image.args;
    assert.equal(format, 'JPEG'); assert.equal(h/w, 2);
    assert.ok(x >= 48 && y >= 48 && x+w <= 564 && y+h <= 744);
  }
  const caption = texts.filter(t => t.t.startsWith('Line'));
  assert.ok(caption.every(t => t.page === images[0].page && t.y <= 744));
  assert.ok(images[0].page > 1);
});

test('PDF aborts if an image cannot be loaded', async () => {
  class Pdf {
    internal = {pageSize:{getWidth:()=>612,getHeight:()=>792}};
    setFont() {} setFontSize() {} setTextColor() {} text() {}
    splitTextToSize(t) { return [t]; }
  }
  await assert.rejects(buildPdf(Pdf, {title:'Photos',sections:[{image:{shared_path:'missing.png'}}]}, {
    loadSharedImage:async () => { throw new Error('missing.png is unavailable'); }
  }), /missing.png is unavailable/);
});
