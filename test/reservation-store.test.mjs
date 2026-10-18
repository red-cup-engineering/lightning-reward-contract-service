import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {defaultSettings} from './fixture.mjs';
const start=Date.parse('2026-10-17T22:00:00Z');
function harness(fn,{balance='200000',prefix='wallet-'}={}){
 const dir=mkdtempSync(join(tmpdir(),prefix));const path=join(dir,'payout.sqlite');
 const clock={now:start};const config=defaultSettings(path,()=>clock.now);
 const open=()=>createLightningRewardReservationStore(config);
 let store=open();
 const observe=(value=balance,ref='urn:wallet:regtest:1')=>store.observeWallet({id:config.walletId,network:'regtest',ready:true,sourceRef:ref,observedAt:new Date(clock.now).toISOString(),spendableOutboundMsat:value});
 try{return fn({store,open,clock,observe,path,config,setStore:x=>store=x});}
 finally{try{store.close();}catch{} rmSync(dir,{recursive:true,force:true});}
}
test('fails closed until a wallet operator observes actual spendable outbound capacity',()=>harness(({store})=>{
 assert.equal(store.availableFor('free-8h').available,false);
 assert.deepEqual(store.reserve({orderId:'order-1',principalId:'alice',planId:'free-8h'}).status,'unavailable');
}));
test('binding wallet ownership and regtest network prohibits foreign book reuse',()=>harness(({store,open,config,path})=>{
 assert.throws(()=>createLightningRewardReservationStore({...config,network:'mainnet'}),/regtest only/);
 assert.throws(()=>createLightningRewardReservationStore({...config,dedicatedWalletExclusive:false}),/exclusive/);
 assert.throws(()=>createLightningRewardReservationStore({...config,walletId:'foreign-wallet'}),/another payout wallet/);
}));
test('first wallet observation permits exact max lifetime obligations before any external charge',()=>harness(({store,observe})=>{
 observe('200000');
 assert.equal(store.availableFor('free-8h').available,true);
 const result=store.reserve({orderId:'order-1',principalId:'alice',planId:'free-8h'});
 assert.equal(result.status,'reserved');assert.equal(result.chargeAccepted,false);
 assert.equal(result.maxRewardMsat,'8800');
 assert.equal(result.maxRoutingFeeMsat,'2000');
 assert.equal(store.book().claims[0].maxRemainingRewardMsat,'8800');
 assert.equal(store.eventHistory('order-1').map(x=>x.event_type).join(','),'reserved');
}));
test('only one live reservation fits when two requests compete for one wallet cap',()=>harness(({store,observe})=>{
 observe('21000'); // 10k cushion => 11k headroom, one free 10.8k contract
 const first=store.reserve({orderId:'p1',principalId:'a',planId:'free-8h'});
 const second=store.reserve({orderId:'p2',principalId:'b',planId:'free-8h'});
 assert.equal(first.status,'reserved');assert.equal(second.status,'sold-out');
 assert.equal(store.book().claims.length,1);
}));
test('replay never duplicates obligations and changed identity conflicts',()=>harness(({store,observe})=>{
 observe();
 assert.equal(store.reserve({orderId:'o1',principalId:'a',planId:'free-8h'}).status,'reserved');
 assert.equal(store.reserve({orderId:'o1',principalId:'a',planId:'free-8h'}).status,'existing');
 assert.throws(()=>store.reserve({orderId:'o1',principalId:'b',planId:'free-8h'}),/idempotency/);
 assert.equal(store.book().claims.length,1);
}));
test('SQLite WAL and transaction survive restart, preserving reserved rewards',()=>harness(({store,open,observe,setStore})=>{
 observe();store.reserve({orderId:'durable',principalId:'alice',planId:'free-8h'});store.close();
 const restored=open();setStore(restored);
 assert.equal(restored.details('durable').status,'reserved');
 assert.equal(restored.book().claims[0].intentId,'durable');
 assert.equal(restored.reserve({orderId:'durable',principalId:'alice',planId:'free-8h'}).status,'existing');
}));
test('contract not active until independent confirmation, then server accrues exactly from its start',()=>harness(({store,observe,clock})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 clock.now+=3600000;assert.equal(store.accrue('a').state,'reserved');
 store.activate({orderId:'a',receiptRef:'urn:trusted:free-grant:1'});
 clock.now+=3600000;
 const accrual=store.accrue('a');
 assert.equal(accrual.earnedMsat,'1100');
 assert.equal(store.accrue('a').earnedMsat,'1100');
 assert.equal(store.details('a').paidMsat,'0');
}));
test('all eight hours accrue, never more after expiry or browser clock controls',()=>harness(({store,observe,clock})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 store.activate({orderId:'a',receiptRef:'urn:trusted:free-grant:1'});
 clock.now+=9*3600000;
 assert.equal(store.accrue('a').earnedMsat,'8800');
 assert.equal(store.accrue('a').state,'earned');
 assert.equal(store.book().claims[0].maxRemainingRewardMsat,'8800');
}));
test('payout may only use earned credits, sufficient fee reserve and minimum invoice amount',()=>harness(({store,observe,clock})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 store.activate({orderId:'a',receiptRef:'urn:trusted:free-grant:1'});
 clock.now+=2*3600000;store.accrue('a');
 assert.throws(()=>store.preparePayout({requestId:'p1',orderId:'a',invoiceRef:'invoice1',paymentHash:'h1',amountMsat:'1000',feeLimitMsat:'3000'}),/fee capacity/);
 assert.throws(()=>store.preparePayout({requestId:'p1',orderId:'a',invoiceRef:'invoice1',paymentHash:'h1',amountMsat:'500',feeLimitMsat:'100'}),/below account withdrawal minimum/);
 const p=store.preparePayout({requestId:'p1',orderId:'a',invoiceRef:'invoice1',paymentHash:'h1',amountMsat:'2000',feeLimitMsat:'1000'});
 assert.equal(p.status,'prepared');
 assert.throws(()=>store.preparePayout({requestId:'p2',orderId:'a',invoiceRef:'invoice2',paymentHash:'h2',amountMsat:'1000',feeLimitMsat:'1000'}),/earned/);
}));
test('payout is held in flight until trusted finality, keeping users obligations booked',()=>harness(({store,observe,clock})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 store.activate({orderId:'a',receiptRef:'urn:trusted:free-grant:1'});
 clock.now+=8*3600000;store.accrue('a');
 store.preparePayout({requestId:'p1',orderId:'a',invoiceRef:'invoice1',paymentHash:'h1',amountMsat:'8800',feeLimitMsat:'1000'});
 assert.equal(store.markPayoutInFlight('p1').state,'in-flight');
 assert.equal(store.reconcilePayout({requestId:'p1',paymentHash:'h1',networkStatus:'pending',receiptRef:'urn:cln:pending'}).state,'unknown');
 assert.equal(store.book().claims[0].maxRemainingRewardMsat,'8800');
 assert.throws(()=>store.releaseUnused('a',{finalityRef:'urn:expired'}),/pending/);
 const final=store.reconcilePayout({requestId:'p1',paymentHash:'h1',networkStatus:'complete',amountSentMsat:'9050',receiptRef:'urn:cln:pay-complete'});
 assert.equal(final.state,'complete');assert.equal(final.feeMsat,'250');
 assert.equal(store.book().claims[0].maxRemainingRewardMsat,'0');
 assert.equal(store.book().claims[0].maxRemainingFeeMsat,'1750');
 assert.equal(store.releaseUnused('a',{finalityRef:'urn:trusted:term-final'}).status,'closed');
 assert.equal(store.book().claims.length,0);
}));
test('failed payout does not burn earned credit and is retriable only after final wallet failure',()=>harness(({store,observe,clock})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 store.activate({orderId:'a',receiptRef:'urn:trusted:free-grant:1'});
 clock.now+=2*3600000;store.accrue('a');
 store.preparePayout({requestId:'p1',orderId:'a',invoiceRef:'invoice1',paymentHash:'h1',amountMsat:'2000',feeLimitMsat:'1000'});
 store.markPayoutInFlight('p1');
 store.reconcilePayout({requestId:'p1',paymentHash:'h1',networkStatus:'failed',receiptRef:'urn:cln:failure'});
 assert.equal(store.details('a').paidMsat,'0');
 assert.equal(store.preparePayout({requestId:'p2',orderId:'a',invoiceRef:'invoice2',paymentHash:'h2',amountMsat:'2000',feeLimitMsat:'1000'}).status,'prepared');
}));
test('unactivated contract is NOT deleted without independent failure/refund proof',()=>harness(({store,observe})=>{
 observe('21000');store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 assert.throws(()=>store.releaseUnused('a',{finalityRef:'not-qualified'}),/cannot release pending/);
 assert.equal(store.availableFor('free-8h').available,false);
 assert.equal(store.voidUnactivated('a',{proofRef:'urn:merchant:independent-no-capture'}).status,'void');
 assert.equal(store.availableFor('free-8h').available,true);
}));
test('no operator can silently treat mainnet balances as dev regtest payouts',()=>harness(({store,observe,clock})=>{
 assert.throws(()=>store.observeWallet({id:'payout-regtest',network:'mainnet',ready:true,sourceRef:'urn:x',observedAt:new Date(clock.now).toISOString(),spendableOutboundMsat:'1000000'}),/wrong wallet\/chain/);
}));
test('expiry release recomputes and retains earned but unpaid rewards instead of treating them as unearned',()=>harness(({store,observe,clock})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 store.activate({orderId:'a',receiptRef:'urn:trusted:free-grant:1'});
 clock.now+=10*3600000;
 assert.throws(()=>store.releaseUnused('a',{finalityRef:'urn:time-finished'}),/earned but unpaid/);
 assert.equal(store.details('a').earnedMsat,'8800');
 assert.equal(store.book().claims[0].maxRemainingRewardMsat,'8800');
}));
test('payout replay with changed fee cap conflicts rather than silently mutating a payment',()=>harness(({store,observe,clock})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 store.activate({orderId:'a',receiptRef:'urn:trusted:free-grant:1'});
 clock.now+=2*3600000;store.accrue('a');
 const pay={requestId:'p1',orderId:'a',invoiceRef:'invoice1',paymentHash:'h1',amountMsat:'2000',feeLimitMsat:'1000'};
 store.preparePayout(pay);
 assert.throws(()=>store.preparePayout({...pay,feeLimitMsat:'2000'}),/idempotency/);
}));
test('account pools sub-sat and small rewards from three expiring contracts into one invoice',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yabcm-pool-'));let clock=start;
 const store=createLightningRewardReservationStore({...defaultSettings(join(dir,'pool.sqlite'),()=>clock),accountWithdrawalMinimumMsat:'20000'});
 try{
  for(let i=0;i<3;i++){
   store.observeWallet({id:'payout-regtest',network:'regtest',ready:true,sourceRef:'urn:wallet:sample:'+i,
    observedAt:new Date(clock).toISOString(),spendableOutboundMsat:'1000000'});
   assert.equal(store.reserve({orderId:'day-'+i,principalId:'alice',planId:'free-8h'}).status,'reserved');
   store.activate({orderId:'day-'+i,receiptRef:'urn:grant:day-'+i});
   clock+=8*3600000;store.accrue('day-'+i);
  }
  const acc=store.accountDetails('alice');assert.equal(acc.earnedMsat,'26400');
  assert.equal(acc.withdrawalMinimumMsat,'20000');
  const prepared=store.preparePooledPayout({requestId:'pooled-1',principalId:'alice',invoiceRef:'lnbcrt-21000',
   paymentHash:'hash-pooled-1',amountMsat:'21000',feeLimitMsat:'500'});
  assert.equal(prepared.status,'prepared');assert.equal(prepared.sourceContracts,3);
  assert.equal(store.accountDetails('alice').lockedPayoutMsat,'21000');
  assert.throws(()=>store.preparePooledPayout({requestId:'pooled-2',principalId:'alice',invoiceRef:'lnbcrt-21000b',
   paymentHash:'hash-pooled-2',amountMsat:'21000',feeLimitMsat:'500'}),/insufficient accumulated/);
  store.markPayoutInFlight('pooled-1');
  const payout=store.reconcilePayout({requestId:'pooled-1',paymentHash:'hash-pooled-1',networkStatus:'complete',
   amountSentMsat:'21250',receiptRef:'urn:cln:complete-pooled'});
  assert.equal(payout.state,'complete');
  assert.equal(store.accountDetails('alice').paidMsat,'21000');
  assert.equal(store.accountDetails('alice').currentlyClaimableMsat,'5400');
  assert.equal(store.details('day-0').paidMsat,'8800');
  assert.equal(store.details('day-1').paidMsat,'8800');
  assert.equal(store.details('day-2').paidMsat,'3400');
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('free plan enforcement is server-owned: cannot overlap or exceed three in UTC day',()=>harness(({store,observe,clock})=>{
 clock.now=Date.parse('2026-10-17T00:00:00Z');
 observe('1000000');
 const a=store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 assert.equal(a.status,'reserved');
 assert.equal(store.reserve({orderId:'b',principalId:'alice',planId:'free-8h'}).reason,'existing-contract-still-running');
 store.activate({orderId:'a',receiptRef:'urn:grant:a'});
 clock.now+=8*3600000;store.accrue('a');
 observe('1000000','urn:wallet:second');
 assert.equal(store.reserve({orderId:'b',principalId:'alice',planId:'free-8h'}).status,'reserved');
 store.activate({orderId:'b',receiptRef:'urn:grant:b'});
 clock.now+=8*3600000;store.accrue('b');
 observe('1000000','urn:wallet:third');
 assert.equal(store.reserve({orderId:'c',principalId:'alice',planId:'free-8h'}).status,'reserved');
 store.activate({orderId:'c',receiptRef:'urn:grant:c'});
 clock.now+=7*3600000;store.accrue('c');
 observe('1000000','urn:wallet:fourth');
 assert.equal(store.reserve({orderId:'d',principalId:'alice',planId:'free-8h'}).reason,'per-day-limit');
}));
test('contract references are permanently immutable across process restart',()=>harness(({store,path,config})=>{
 store.close();
 const tampered={...config,sourceCatalog:{...config.sourceCatalog,plans:config.sourceCatalog.plans.map(p=>p.planId==='free-8h'?{...p,actualRateMsatPerHour:'1000'}:p)}};
 assert.throws(()=>createLightningRewardReservationStore(tampered),/terms changed/);
}));
test('unexpected wallet depletion freezes new offers but preserves pre-existing customer obligations',()=>harness(({store,observe,clock})=>{
 observe('21000');
 store.reserve({orderId:'a',principalId:'a',planId:'free-8h'});
 clock.now+=1000;
 observe('1500','urn:cln:outbound-depleted');
 assert.equal(store.availableFor('free-8h').available,false);
 assert.equal(store.reserve({orderId:'b',principalId:'b',planId:'free-8h'}).status,'sold-out');
 assert.equal(store.book().claims.length,1);
 assert.equal(store.details('a').status,'reserved');
}));
test('recovery after regtest wallet dispatch state does not issue a second Lightning payment',()=>harness(({store,open,observe,clock,setStore})=>{
 observe();store.reserve({orderId:'a',principalId:'alice',planId:'free-8h'});
 store.activate({orderId:'a',receiptRef:'urn:regtest:grant'});
 clock.now+=2*3600000;store.accrue('a');
 store.preparePooledPayout({principalId:'alice',requestId:'p1',invoiceRef:'lnbcrt-test',paymentHash:'hash-1',amountMsat:'1500',feeLimitMsat:'500'});
 assert.equal(store.markPayoutInFlight('p1').state,'in-flight');
 store.close();const restored=open();setStore(restored);
 assert.equal(restored.payoutDetails('p1').state,'in-flight');
 assert.equal(restored.markPayoutInFlight('p1').replay,true);
 assert.equal(restored.accountDetails('alice').lockedPayoutMsat,'1500');
 assert.equal(restored.reconcilePayout({requestId:'p1',paymentHash:'hash-1',networkStatus:'pending',receiptRef:'urn:cln:pending'}).state,'unknown');
 assert.equal(restored.reconcilePayout({requestId:'p1',paymentHash:'hash-1',networkStatus:'complete',amountSentMsat:'1700',receiptRef:'urn:cln:confirmed'}).state,'complete');
 assert.equal(restored.accountDetails('alice').paidMsat,'1500');
}));
