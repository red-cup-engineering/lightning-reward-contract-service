import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {defaultSettings} from './fixture.mjs';
const exec=promisify(execFile),now=Date.parse('2026-10-17T22:00:00Z');
const worker=resolve(import.meta.dirname,'process-reserve.mjs');
function seed(){
 const dir=mkdtempSync(join(tmpdir(),'yabcm-multi-'));const path=join(dir,'orders.sqlite');
 const store=createLightningRewardReservationStore(defaultSettings(path,()=>now));
 store.observeWallet({id:'payout-regtest',network:'regtest',ready:true,sourceRef:'urn:one-slot-wallet:regtest',observedAt:new Date(now).toISOString(),spendableOutboundMsat:'21000'});
 store.close();return {path,dir};
}
const reserve=(path,principal,id)=>exec(process.execPath,[worker,path,principal,id],{timeout:10000,maxBuffer:30000})
 .then(x=>JSON.parse(x.stdout),e=>({error:e.message}));
test('twelve separate Node processes racing for one funded reservation admit exactly one',async()=>{
 const {path,dir}=seed();
 try{
  const xs=await Promise.all(Array.from({length:12},(_,i)=>reserve(path,'player-'+i,'order-'+i)));
  assert.equal(xs.filter(x=>x.status==='reserved').length,1,JSON.stringify(xs));
  assert.equal(xs.filter(x=>x.status==='sold-out').length,11,JSON.stringify(xs));
  const after=createLightningRewardReservationStore(defaultSettings(path,()=>now));
  try{assert.equal(after.book().claims.length,1);}finally{after.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('twelve processes retrying same order commit once and receive idempotent result',async()=>{
 const {path,dir}=seed();
 try{
  const xs=await Promise.all(Array.from({length:12},()=>reserve(path,'player','same-order')));
  assert.equal(xs.filter(x=>x.status==='reserved').length,1,JSON.stringify(xs));
  assert.equal(xs.filter(x=>x.status==='existing').length,11,JSON.stringify(xs));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
