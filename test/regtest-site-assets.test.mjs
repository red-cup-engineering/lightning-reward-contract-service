import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadRegtestSiteAssets} from '../src/regtest-site-assets.mjs';
const names=['index.html','assets/browser.mjs','assets/model.mjs','assets/contract-browser.mjs',
 'assets/contract-experience.mjs','assets/regtest-catalog-client.mjs','assets/style.css','api/status.json','robots.txt'];
async function built(run){
 const dir=mkdtempSync(join(tmpdir(),'yabcm-preview-static-'));
 mkdirSync(join(dir,'assets'));mkdirSync(join(dir,'api'));
 for(const file of names)writeFileSync(join(dir,file),file.endsWith('.json')?
 JSON.stringify({realRewardsEnabled:false,walletOrCustodyEnabled:false,x402PaymentsEnabled:false,playableDemo:true}):'test-content');
 try{return await run(dir)}finally{rmSync(dir,{recursive:true,force:true})}
}
test('operator can mount only the declared eight zero-money public YABCM routes',()=>built(async dir=>{
 const map=await loadRegtestSiteAssets(dir);
 assert.equal(map.size,9);
 assert.equal(map.get('/').contentType,'text/html; charset=utf-8');
 assert.equal(map.get('/assets/browser.mjs').contentType,'text/javascript; charset=utf-8');
 assert.equal(map.has('/ops/account'),false);
 assert.equal(map.has('/api/status.json'),true);
}));
test('site mounting rejects any compiled artifact claiming real financial operations',()=>built(async dir=>{
 writeFileSync(join(dir,'api/status.json'),JSON.stringify({realRewardsEnabled:true,
  walletOrCustodyEnabled:false,x402PaymentsEnabled:false,playableDemo:true}));
 await assert.rejects(loadRegtestSiteAssets(dir),/nonmonetary/);
}));
test('site mounting refuses symlinks escaping the selected asset root',()=>built(async dir=>{
 const destination=join(dir,'assets/browser.mjs');unlinkSync(destination);
 symlinkSync('/etc/hosts',destination);
 await assert.rejects(loadRegtestSiteAssets(dir),/escapes/);
}));
test('missing compiled JavaScript refuses incomplete site installation',()=>built(async dir=>{
 unlinkSync(join(dir,'assets/model.mjs'));
 await assert.rejects(loadRegtestSiteAssets(dir));
}));
