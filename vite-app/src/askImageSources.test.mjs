import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFile } from '../../supabase/functions/_shared/askFiles.ts';
import { imageListArgs, imageListing, requireDiscoveredImages } from '../../supabase/functions/_shared/askFiles.ts';
import { toolsFor } from '../../supabase/functions/_shared/askTools.ts';
import { createInvestigation } from '../../supabase/functions/_shared/askInvestigation.ts';

const pdf = images => ({kind:'pdf', document:{title:'Pictures', sections:images.map(image=>({image}))}});
test('PDF accepts Files references only with a single source and bounded placements', () => {
  assert.deepEqual(checkFile(pdf([{shared_path:'Photos/site.jpg',caption:' Site '}])).document.sections[0].image, {shared_path:'Photos/site.jpg',caption:'Site'});
  for (const path of ['https://example.com/a.png','/a.png','../a.png','x/../a.png','x\\a.png','x//a.png','x/./a.png','a\u0000.png']) {
    assert.throws(()=>checkFile(pdf([{shared_path:path}])), /path/i);
  }
  assert.throws(()=>checkFile(pdf([{asset:'vagabonde-logo',shared_path:'x.png'}])), /source/i);
  assert.throws(()=>checkFile(pdf(Array(5).fill({asset:'vagabonde-logo'}))), /four|4/i);
  assert.throws(()=>checkFile({kind:'html',text:'Hello',images:[{shared_path:'x.png'}]}), /HTML|asset/i);
});
test('image discovery paginates raw entries and returns only bounded JPEG/PNG files', () => {
  assert.deepEqual(imageListArgs({}), {folder:'',offset:0});
  assert.throws(()=>imageListArgs({folder:'../x'}), /path/i);
  assert.throws(()=>imageListArgs({offset:-1}), /offset/i);
  const entries = Array.from({length:100},(_,i)=>({id:String(i),name:`${i}.pdf`,metadata:{mimetype:'application/pdf',size:100}}));
  entries[0]={id:null,name:'Photos'};
  entries[1]={id:'photo',name:'site.jpg',metadata:{mimetype:'image/jpeg',size:200}};
  entries[2]={id:'big',name:'big.png',metadata:{mimetype:'image/png',size:6*1024*1024}};
  const result=imageListing('Job',50,entries);
  assert.deepEqual(result.folders,[{name:'Photos',path:'Job/Photos'}]);
  assert.deepEqual(result.images,[{name:'site.jpg',shared_path:'Job/site.jpg',type:'image/jpeg',size:200}]);
  assert.equal(result.next_offset,150);
  assert.equal(imageListing('',0,[]).next_offset,null);
});
test('only images discovered during this caller request can reach a file response', () => {
  const file=checkFile(pdf([{shared_path:'Photos/site.jpg'}]));
  assert.throws(()=>requireDiscoveredImages(file,new Set()), /list_images/i);
  assert.doesNotThrow(()=>requireDiscoveredImages(file,new Set(['Photos/site.jpg'])));
  assert.doesNotThrow(()=>requireDiscoveredImages(checkFile(pdf([{asset:'vagabonde-logo'}])),new Set()));
  assert.ok(toolsFor(['files']).some(t=>t.name==='list_images'));
  assert.ok(!toolsFor(['chat']).some(t=>t.name==='list_images'));
});

test('runtime gate refuses image discovery without Files before calling storage', async () => {
  let reads=0;
  const investigation=createInvestigation(async()=>{ reads++; return {}; },toolsFor(['chat']).map(t=>t.name));
  assert.match((await investigation.runTool('list_images',{})).error,/not available/);
  assert.equal(reads,0);
});

test('discovery ignores folder marker, invalid metadata and paths while keeping legitimate dot filenames', () => {
  const row=(name,size=10,mimetype='image/png')=>({id:'id',name,metadata:{size,mimetype}});
  const result=imageListing('',0,[row('.keep'),row('.photo.png'),row('fake.gif',10,'image/gif'),row('empty.png',0),row('bad.png',NaN),row('parent/evil.png'),row('wrong\\path.png')]);
  assert.deepEqual(result.images.map(i=>i.shared_path),['.photo.png']);
});

test('shared photos use separate byte limits while captions count against text budget', () => {
  const file=pdf([{shared_path:'photo.jpg',caption:'x'.repeat(300)}]);
  file.document.sections.push({text:'x'.repeat(199690)});
  assert.doesNotThrow(()=>checkFile(file));
  file.document.sections[1].text+='x'.repeat(10);
  assert.throws(()=>checkFile(file),/most|budget/);
});
