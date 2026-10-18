import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCLNRegtestAdapter} from '../src/cln-regtest.mjs';
const hash='a'.repeat(64);
const now=Date.parse('2026-10-17T22:00:00Z');
async function harness(fn){
 const dir=mkdtempSync(join(tmpdir(),'yabcm-cln-subprocess-'));
 const bin=join(dir,'bin');mkdirSync(bin);
 const script=join(bin,'lightning-cli'),log=join(dir,'calls.jsonl');
 const previous={PATH:process.env.PATH,YABCM_FAKE_CLN_LOG:process.env.YABCM_FAKE_CLN_LOG,
  YABCM_FAKE_CLN_NETWORK:process.env.YABCM_FAKE_CLN_NETWORK};
 const source=[
  '#!/usr/bin/env node',
  "const fs=require('node:fs');",
  "const args=process.argv.slice(2);",
  "fs.appendFileSync(process.env.YABCM_FAKE_CLN_LOG,JSON.stringify(args)+'\\n');",
  "if(!args.includes('--regtest')||!args.includes('-k'))process.exit(41);",
  "const cmd=args.find(x=>['getinfo','listpeerchannels','decode','xpay','listpays'].includes(x));",
  "if(cmd==='getinfo')process.stdout.write(JSON.stringify({network:process.env.YABCM_FAKE_CLN_NETWORK}));",
  "else if(cmd==='listpeerchannels')process.stdout.write(JSON.stringify({channels:[{state:'CHANNELD_NORMAL',peer_connected:true,spendable_msat:'2500000msat'}]}));",
  "else if(cmd==='decode'&&args.includes('string=lnbcrt1invoice'))process.stdout.write(JSON.stringify({type:'bolt11 invoice',valid:true,currency:'bcrt',payment_hash:'"+hash+"',amount_msat:'1500msat',created_at:"+Math.floor(now/1000-10)+",expiry:3600}));",
  "else if(cmd==='xpay'&&args.includes('maxfee=300msat'))process.stdout.write(JSON.stringify({status:'complete'}));",
  "else if(cmd==='listpays'&&args.includes('payment_hash="+hash+"'))process.stdout.write(JSON.stringify({pays:[{payment_hash:'"+hash+"',status:'complete',amount_sent_msat:'1700msat',created_at:1234}]}));",
  "else process.exit(42);"
 ].join('\n')+'\n';
 writeFileSync(script,source);chmodSync(script,0o700);
 process.env.PATH=bin+':'+previous.PATH;
 process.env.YABCM_FAKE_CLN_LOG=log;
 process.env.YABCM_FAKE_CLN_NETWORK='regtest';
 const adapter=createCLNRegtestAdapter({walletId:'regtest-wallet',lightningDir:join(dir,'node'),clock:()=>now,
  projectOutbound:({result,walletId,network,observedAt,sourceRef})=>({id:walletId,network,observedAt,sourceRef,
   ready:true,spendableOutboundMsat:result.channels[0].spendable_msat.replace('msat','')})});
 try {await fn({adapter,log})}
 finally{for(const [key,val] of Object.entries(previous)){if(val===undefined)delete process.env[key];else process.env[key]=val;}
  rmSync(dir,{recursive:true,force:true});}
}
test('spawned lightning-cli really passes -k, regtest and bounded named arguments',async()=>{
 await harness(async({adapter,log})=>{
  const w=await adapter.observeWallet();assert.equal(w.spendableOutboundMsat,'2500000');
  const d=await adapter.decodeInvoice('lnbcrt1invoice');assert.equal(d.amountMsat,'1500');
  await adapter.sendInvoice({invoice:'lnbcrt1invoice',maxFeeMsat:'300'});
  const p=await adapter.observePayment(hash);assert.equal(p.status,'complete');assert.equal(p.amountSentMsat,'1700');
  const calls=readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.ok(calls.length>=8);assert.ok(calls.every(args=>args.includes('-k')&&args.includes('--regtest')));
  assert.ok(calls.some(args=>args.includes('decode')&&args.includes('string=lnbcrt1invoice')));
  assert.ok(calls.some(args=>args.includes('xpay')&&args.includes('maxfee=300msat')));
  assert.ok(calls.some(args=>args.includes('listpays')&&args.includes('payment_hash='+hash)));
 });
});
test('actual subprocess path refuses a non-regtest getinfo before sensitive RPC',async()=>{
 await harness(async({adapter,log})=>{
  process.env.YABCM_FAKE_CLN_NETWORK='bitcoin';
  await assert.rejects(adapter.sendInvoice({invoice:'lnbcrt1invoice',maxFeeMsat:'300'}),/not on regtest/);
  const calls=readFileSync(log,'utf8').trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(calls.length,1);assert.ok(calls[0].includes('getinfo'));
 });
});
