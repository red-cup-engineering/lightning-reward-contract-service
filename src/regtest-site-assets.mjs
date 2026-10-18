import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
/**
 * Operator-provided, prebuilt Causeway demo files mounted READ ONLY on the
 * loopback regtest receiver. This is a development carrier, not cloud hosting
 * or a route for secret-bearing settlement operations in the browser.
 */
const routes=Object.freeze({
 '/':'index.html',
 '/assets/browser.mjs':'assets/browser.mjs',
 '/assets/model.mjs':'assets/model.mjs',
 '/assets/contract-browser.mjs':'assets/contract-browser.mjs',
 '/assets/contract-experience.mjs':'assets/contract-experience.mjs',
 '/assets/style.css':'assets/style.css',
 '/api/status.json':'api/status.json',
 '/robots.txt':'robots.txt',
});
const type=Object.freeze({html:'text/html; charset=utf-8',mjs:'text/javascript; charset=utf-8',
 css:'text/css; charset=utf-8',json:'application/json; charset=utf-8',txt:'text/plain; charset=utf-8'});
export async function loadRegtestSiteAssets(directory){
 const base=await realpath(resolve(directory));
 const entries=new Map();
 for(const [route,relative] of Object.entries(routes)){
  const path=join(base,relative);
  const actual=await realpath(path);
  if(!actual.startsWith(base+sep))throw Error('site resource escapes selected static root: '+route);
  const meta=await stat(actual);
  if(!meta.isFile()||meta.size<1||meta.size>1024*1024)throw Error('invalid static asset size or type: '+route);
  const data=await readFile(actual);
  const ext=relative.split('.').at(-1);
  entries.set(route,Object.freeze({contentType:type[ext],data}));
 }
 const status=JSON.parse(entries.get('/api/status.json').data.toString('utf8'));
 if(status.realRewardsEnabled!==false||status.walletOrCustodyEnabled!==false||
    status.x402PaymentsEnabled!==false||status.playableDemo!==true)
  throw Error('only explicitly nonmonetary demo site assets may be mounted in regtest');
 return entries;
}
