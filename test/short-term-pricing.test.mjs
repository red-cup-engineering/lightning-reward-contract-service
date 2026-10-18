import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {defaultSettings,exampleCatalog} from './fixture.mjs';
const now=Date.parse('2026-10-17T22:00:00Z');
const plan=Object.freeze({...exampleCatalog.plans[0],planId:'short-regtest',termsRef:'urn:yabcm:regtest:short-minute-v1',
 durationSeconds:60,actualRateMsatPerHour:'7200000',maxBaseRewardMsatPerHour:'7200000',
 maxClaimsPerUtcDay:3});
test('a 60-second contract reserves 60 seconds of its 7.2-million-msat hourly rate, not an extra hour',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yabcm-short-cap-'));
 try{
  const settings=defaultSettings(join(dir,'payout.db'),()=>now);
  const s=createLightningRewardReservationStore({...settings,sourceCatalog:{version:'short-test-v1',plans:[plan]}});
  try{
   s.observeWallet({id:settings.walletId,network:'regtest',ready:true,sourceRef:'urn:cln:short-plan:funded',
    observedAt:new Date(now).toISOString(),spendableOutboundMsat:'200000'});
   const result=s.reserve({orderId:'test-minute',principalId:'alice',planId:plan.planId});
   assert.equal(result.status,'reserved');
   assert.equal(result.maxRewardMsat,'120000');
   assert.equal(result.maxRoutingFeeMsat,'2000');
  }finally{s.close();}
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('an underfunded contract whose actual rate exceeds its whole-term ceiling refuses installation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yabcm-short-defective-'));
 try{
  const settings=defaultSettings(join(dir,'payout.db'),()=>now);
  assert.throws(()=>createLightningRewardReservationStore({...settings,
   sourceCatalog:{version:'short-test-defective',plans:[{...plan,actualRateMsatPerHour:'7400000'}]}}),
    /unbackable plan/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
