import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {defaultSettings} from './fixture.mjs';
const now=Date.parse('2026-10-17T22:00:00Z');
const open=path=>createLightningRewardReservationStore(defaultSettings(path,()=>now));
test('abrupt power/process loss inside an uncommitted WAL booking never manufactures a contractual obligation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'yabcm-crash-'));const path=join(dir,'wallet.db');
 try{
  const s=open(path);s.observeWallet({id:'payout-regtest',network:'regtest',ready:true,
   sourceRef:'urn:cln:regtest:fresh',observedAt:new Date(now).toISOString(),spendableOutboundMsat:'21000'});s.close();
  const child=spawn(process.execPath,[resolve(import.meta.dirname,'process-crash.mjs'),path],{stdio:['ignore','pipe','pipe']});
  await new Promise((done,fail)=>{
   let log='';const timer=setTimeout(()=>fail(Error('crash child timeout '+log)),5000);
   child.stdout.on('data',chunk=>{log+=chunk.toString();if(log.includes('in-uncommitted-transaction')){clearTimeout(timer);done();}});
   child.once('exit',code=>{clearTimeout(timer);fail(Error('unexpected child exit '+code+' '+log));});
  });
  child.kill('SIGKILL');
  await new Promise(resolve=>child.once('exit',resolve));
  const restored=open(path);
  try{
   assert.equal(restored.details('half-written'),null);
   assert.equal(restored.book().claims.length,0);
   assert.equal(restored.reserve({orderId:'safe-order',principalId:'alice',planId:'free-8h'}).status,'reserved');
  }finally{restored.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
