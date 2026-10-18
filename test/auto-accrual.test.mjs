import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {defaultSettings} from './fixture.mjs';
const START=Date.parse('2026-10-17T00:00:00Z');
function harness(fn){
 const dir=mkdtempSync(join(tmpdir(),'yabcm-auto-accrual-'));let now=START;
 const store=createLightningRewardReservationStore(defaultSettings(join(dir,'book.sqlite'),()=>now));
 const advance=ms=>{now+=ms};
 const refresh=(id='one')=>store.observeWallet({id:'payout-regtest',network:'regtest',ready:true,
  sourceRef:'urn:wallet:auto-accrual:'+id,observedAt:new Date(now).toISOString(),spendableOutboundMsat:'500000'});
 try{return fn({store,advance,refresh})}finally{store.close();rmSync(dir,{recursive:true,force:true})}
}
test('account balance materializes elapsed term directly without an operator accrual job',()=>harness(({store,advance,refresh})=>{
 refresh();assert.equal(store.reserve({orderId:'one',principalId:'alice',planId:'free-8h'}).status,'reserved');
 store.activate({orderId:'one',receiptRef:'urn:grant:one'});
 advance(2*3600000);
 const first=store.accountDetails('alice');
 assert.equal(first.earnedMsat,'2200');
 assert.equal(first.currentlyClaimableMsat,'2200');
 assert.equal(store.details('one').earnedMsat,'2200');
 const n=store.eventHistory('one').length;
 const again=store.accountDetails('alice');
 assert.equal(again.earnedMsat,'2200');
 assert.equal(store.eventHistory('one').length,n,'idempotent read cannot double credit');
}));
test('pool withdrawal realizes all elapsed free-contract intervals without per-order accrue requests',()=>harness(({store,advance,refresh})=>{
 for(let i=0;i<3;i++){
  refresh('day-'+i);
  assert.equal(store.reserve({orderId:'day-'+i,principalId:'alice',planId:'free-8h'}).status,'reserved');
  store.activate({orderId:'day-'+i,receiptRef:'urn:grant:day-'+i});
  advance(8*3600000);
 }
 assert.equal(store.details('day-2').earnedMsat,'0','nothing explicitly accrued');
 const p=store.preparePooledPayout({requestId:'pooled',principalId:'alice',invoiceRef:'lnbcrt-20000',
  paymentHash:'hash-pooled',amountMsat:'20000',feeLimitMsat:'500'});
 assert.equal(p.status,'prepared');
 assert.equal(p.sourceContracts,3);
 assert.equal(store.details('day-2').earnedMsat,'8800');
 assert.equal(store.accountDetails('alice').lockedPayoutMsat,'20000');
 assert.equal(store.accountDetails('alice').currentlyClaimableMsat,'6400');
 assert.throws(()=>store.preparePooledPayout({requestId:'duplicate',principalId:'alice',invoiceRef:'lnbcrt-20000b',
  paymentHash:'hash-duplicate',amountMsat:'20000',feeLimitMsat:'500'}),/insufficient accumulated/);
}));
test('unactivated reserved plan never gains credit from an account or payout read',()=>harness(({store,refresh,advance})=>{
 refresh();store.reserve({orderId:'held',principalId:'alice',planId:'free-8h'});
 advance(10*3600000);
 assert.equal(store.accountDetails('alice').earnedMsat,'0');
 assert.throws(()=>store.preparePooledPayout({requestId:'bad',principalId:'alice',invoiceRef:'fake',
  paymentHash:'hash',amountMsat:'1000',feeLimitMsat:'100'}),/no payable/);
 assert.equal(store.details('held').status,'reserved');
}));
