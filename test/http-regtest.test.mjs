import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {createRewardRegtestHttp} from '../src/http-regtest.mjs';
import {defaultSettings} from './fixture.mjs';
const start=Date.parse('2026-10-17T22:00:00Z');
const hash='a'.repeat(64),token='a super secret operator-only regtest token 12345';
async function withHarness(fn,{balance='21000',paymentStatus='complete'}={}){
 const dir=mkdtempSync(join(tmpdir(),'yabcm-http-'));
 const clock={ms:start};
 const store=createLightningRewardReservationStore(defaultSettings(join(dir,'liabilities.db'),()=>clock.ms));
 let payment=paymentStatus;
 let sendAttempts=0;
 const wallet={
  async observeWallet(){return {id:'payout-regtest',network:'regtest',ready:true,observedAt:new Date(clock.ms).toISOString(),sourceRef:'urn:regtest:wallet:'+clock.ms,spendableOutboundMsat:balance}},
  async decodeInvoice(invoice){if(invoice!=='lnbcrt-1500')throw Error('invalid invoice');return {invoiceRef:invoice,paymentHash:hash,amountMsat:'1500'}},
  async sendInvoice(){sendAttempts++;return {status:payment}},
  async observePayment(){return {status:payment,paymentHash:hash,amountSentMsat:payment==='complete'?'1750':null,sourceRef:'urn:regtest:wallet-payment:'+payment}},
 };
 const verifyGrant=async({proof,purpose,order})=>({verified:proof===`signed-regtest:${purpose??'activation'}:${order?.orderId}`,sourceRef:'urn:regtest:independent:'+proof});
 const srv=createRewardRegtestHttp({store,wallet,verifyGrant,operatorToken:token});
 srv.listen(0,'127.0.0.1');await once(srv,'listening');
 const base='http://127.0.0.1:'+srv.address().port;
 const get=async(route)=>{const r=await fetch(base+route);return {code:r.status,body:await r.json()}};
 const post=async(route,obj={},authorized=true)=>{
  const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',...(authorized?{authorization:'Bearer '+token}:{})},body:JSON.stringify(obj)});
  return {code:r.status,body:await r.json()};
 };
 try{await fn({store,wallet,clock,post,get,setPayment:x=>payment=x,getSendAttempts:()=>sendAttempts});}
 finally{await new Promise(resolve=>srv.close(resolve));store.close();rmSync(dir,{recursive:true,force:true});}
}
test('HTTP catalog is public but cannot leak balances or issue money; operators must authenticate',async()=>{
 await withHarness(async({get,post})=>{
  assert.equal((await get('/health')).code,200);
  const before=await get('/v1/catalog');assert.equal(before.body.mainnetSalesEnabled,false);
  assert.equal(before.body.entries[0].availability.available,false);
  assert.equal(JSON.stringify(before.body).includes('spendableOutboundMsat'),false);
  assert.equal((await post('/ops/wallet/refresh',{},false)).code,401);
  assert.equal((await post('/wallet/send',{amount:1500})).code,404);
  assert.equal((await post('/ops/wallet/refresh')).code,200);
  assert.equal((await get('/v1/catalog')).body.entries[0].availability.available,true);
 });
});
test('HTTP 12 simultaneous reservation calls receive exactly one real persisted hold',async()=>{
 await withHarness(async({post,store})=>{
  await post('/ops/wallet/refresh');
  const xs=await Promise.all(Array.from({length:12},(_,i)=>post('/ops/reserve',{orderId:'request-'+i,principalId:'p-'+i,planId:'free-8h'})));
  assert.equal(xs.filter(x=>x.body.status==='reserved').length,1);
  assert.equal(xs.filter(x=>x.body.status==='sold-out').length,11);
  assert.equal(store.book().claims.length,1);
 });
});
test('regtest lifecycle actually makes wallet-informed reservation, grant, server accrual, payout and closure',async()=>{
 await withHarness(async({post,store,clock,getSendAttempts})=>{
  await post('/ops/wallet/refresh');
  const newOrder=await post('/ops/reserve',{orderId:'o',principalId:'alice',planId:'free-8h'});
  assert.equal(newOrder.body.status,'reserved');assert.equal(newOrder.body.chargeAccepted,false);
  assert.equal((await post('/ops/activate',{orderId:'o',proof:'nonsense'})).code,403);
  assert.equal((await post('/ops/activate',{orderId:'o',proof:'signed-regtest:activation:o'})).body.state,'active');
  clock.ms+=8*3600000;
  assert.equal((await post('/ops/accrue',{orderId:'o'})).body.earnedMsat,'8800');
  assert.equal((await post('/ops/payout/prepare',{requestId:'p',principalId:'alice',invoice:'lnbcrt-1500',amountMsat:'8000',feeLimitMsat:'500'})).code,400);
  const prepared=await post('/ops/payout/prepare',{requestId:'p',principalId:'alice',invoice:'lnbcrt-1500',amountMsat:'1500',feeLimitMsat:'500'});
  assert.equal(prepared.body.status,'prepared');
  const sent=await post('/ops/payout/dispatch',{requestId:'p'});
  assert.equal(sent.body.state,'complete');assert.equal(getSendAttempts(),1);
  assert.equal((await post('/ops/payout/dispatch',{requestId:'p'})).code,400);
  assert.equal((await post('/ops/close',{orderId:'o',proof:'signed-regtest:term-closed:o'})).code,400);
  assert.equal(store.details('o').paidMsat,'1500');
  assert.equal(store.eventHistory('o').some(x=>x.event_type==='payout-share-final'),true);
 });
});
test('an uncertain dispatch holds payout and never resends automatically on repeated request',async()=>{
 await withHarness(async({post,clock,getSendAttempts})=>{
  await post('/ops/wallet/refresh');
  await post('/ops/reserve',{orderId:'o',principalId:'a',planId:'free-8h'});
  await post('/ops/activate',{orderId:'o',proof:'signed-regtest:activation:o'});
  clock.ms+=2*3600000;
  await post('/ops/accrue',{orderId:'o'});
  await post('/ops/payout/prepare',{requestId:'p',principalId:'a',invoice:'lnbcrt-1500',amountMsat:'1500',feeLimitMsat:'500'});
  const first=await post('/ops/payout/dispatch',{requestId:'p'});
  assert.equal(first.code,202);assert.equal(first.body.state,'unknown');
  const second=await post('/ops/payout/dispatch',{requestId:'p'});
  assert.equal(second.body.dispatch,'not-repeated');assert.equal(getSendAttempts(),1);
  assert.equal((await post('/ops/payout/reconcile',{requestId:'p'})).body.state,'unknown');
 },{paymentStatus:'pending'});
});
test('no one can declare an unreceived payment final merely by passing JSON in the operator API',async()=>{
 await withHarness(async({post})=>{
  assert.equal((await post('/ops/reconcile',{requestId:'fake',networkStatus:'complete'})).code,404);
  assert.equal((await post('/ops/payout/reconcile',{requestId:'fake',networkStatus:'complete'})).code,400);
 });
});
