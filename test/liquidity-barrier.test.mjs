import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {defaultSettings} from './fixture.mjs';
const start=Date.parse('2026-10-17T22:00:00Z');
function scenario(run){
 const dir=mkdtempSync(join(tmpdir(),'yabcm-liquidity-')), clock={now:start};
 const settings=defaultSettings(join(dir,'book.sqlite'),()=>clock.now);
 const store=createLightningRewardReservationStore(settings);
 const observe=(source,spendable)=>store.observeWallet({id:settings.walletId,network:'regtest',
  ready:true,sourceRef:source,observedAt:new Date(clock.now).toISOString(),spendableOutboundMsat:spendable});
 const reserve=(id,actor)=>store.reserve({orderId:id,principalId:actor,planId:'free-8h'});
 try{return run({store,clock,observe,reserve})}finally{store.close();rmSync(dir,{force:true,recursive:true})}
}
function preparePaid(s){
 s.observe('urn:wallet:initial','34000');
 assert.equal(s.reserve('a','alice').status,'reserved');
 assert.equal(s.reserve('b','bob').status,'reserved');
 s.store.activate({orderId:'a',receiptRef:'urn:grant:a'});
 s.clock.now+=8*3600000;s.store.accrue('a');
 s.observe('urn:wallet:before-outgoing-payment','34000');
 s.store.preparePooledPayout({requestId:'p',principalId:'alice',invoiceRef:'lnbcrt-test',
  paymentHash:'hash-a',amountMsat:'8800',feeLimitMsat:'1000'});
 s.store.markPayoutInFlight('p');
}
const completed=s=>s.store.reconcilePayout({requestId:'p',paymentHash:'hash-a',
 networkStatus:'complete',amountSentMsat:'8950',receiptRef:'urn:cln:complete'});

test('REGRESSION: old pre-payment wallet quote cannot oversell the same sats',()=>scenario(s=>{
 preparePaid(s);completed(s);
 assert.equal(s.store.availableFor('free-8h').available,false);
 const r=s.reserve('c','charlie');
 assert.equal(r.status,'unavailable');
 assert.match(r.reason,/wallet-refresh-required/);
 assert.equal(s.store.book().claims.length,2);
 s.observe('urn:wallet:post-payment','25050');
 assert.equal(s.reserve('c','charlie').status,'sold-out');
}));

test('payment in flight blocks booking even if a node observation comes in meanwhile',()=>scenario(s=>{
 preparePaid(s);s.observe('urn:wallet:during-payment','34000');
 assert.match(s.reserve('c','charlie').reason,/payout-unresolved/);
 completed(s);
 assert.match(s.reserve('c','charlie').reason,/wallet-refresh-required/);
 s.observe('urn:wallet:after-final','25050');
 assert.equal(s.reserve('c','charlie').status,'sold-out');
}));

test('failed outgoing payments still require fresh wallet observation',()=>scenario(s=>{
 preparePaid(s);
 s.store.reconcilePayout({requestId:'p',paymentHash:'hash-a',networkStatus:'pending',receiptRef:'urn:cln:pending'});
 assert.equal(s.reserve('c','charlie').status,'unavailable');
 s.store.reconcilePayout({requestId:'p',paymentHash:'hash-a',networkStatus:'failed',receiptRef:'urn:cln:failed'});
 assert.match(s.reserve('c','charlie').reason,/wallet-refresh-required/);
 s.observe('urn:wallet:after-failure','34000');
 assert.equal(s.reserve('c','charlie').status,'sold-out');
}));

test('migrating a legacy SQLite book invalidates previous wallet snapshots',()=>{
 const dir=mkdtempSync(join(tmpdir(),'yabcm-liquidity-migrate-')),path=join(dir,'book.sqlite');
 try{
  const db=new DatabaseSync(path);
  db.exec("CREATE TABLE configuration(id INTEGER PRIMARY KEY CHECK(id=1),wallet_id TEXT NOT NULL,network TEXT NOT NULL);");
  db.exec("INSERT INTO configuration VALUES(1,'payout-regtest','regtest');");
  db.exec("CREATE TABLE wallet_observations(seq INTEGER PRIMARY KEY AUTOINCREMENT,wallet_id TEXT NOT NULL,network TEXT NOT NULL,source_ref TEXT NOT NULL,observed_at TEXT NOT NULL,usable_outbound_msat TEXT NOT NULL,ready INTEGER NOT NULL);");
  db.exec("INSERT INTO wallet_observations(wallet_id,network,source_ref,observed_at,usable_outbound_msat,ready) VALUES('payout-regtest','regtest','urn:legacy','2026-10-17T22:00:00Z','200000',1);");
  db.close();
  const s=createLightningRewardReservationStore(defaultSettings(path,()=>start));
  try{
   assert.equal(s.availableFor('free-8h').available,false);
   assert.match(s.reserve({orderId:'a',principalId:'alice',planId:'free-8h'}).reason,/wallet-refresh-required/);
   s.observeWallet({id:'payout-regtest',network:'regtest',ready:true,
    sourceRef:'urn:new:after-migration',observedAt:new Date(start).toISOString(),spendableOutboundMsat:'200000'});
   assert.equal(s.reserve({orderId:'a',principalId:'alice',planId:'free-8h'}).status,'reserved');
  }finally{s.close();}
 }finally{rmSync(dir,{force:true,recursive:true});}
});
