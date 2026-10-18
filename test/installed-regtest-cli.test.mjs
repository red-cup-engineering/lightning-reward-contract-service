import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
const root=resolve('.');
const invoice='lnbcrt1regtestsmokeinvoice',hash='a'.repeat(64);
const token='local-regtest-only-secret-token-not-a-real-wallet-xyz';
async function choosePort(){
 const srv=createServer().listen(0,'127.0.0.1');
 await once(srv,'listening');const port=srv.address().port;
 await new Promise(done=>srv.close(done));return port;
}
function fakeCli(path,log){
 const script=[
  '#!/usr/bin/env node',
  "const fs=require('node:fs');",
  "const args=process.argv.slice(2);",
  "fs.appendFileSync("+JSON.stringify(log)+",JSON.stringify(args)+'\\n');",
  "if(!args.includes('--regtest')||!args.includes('-k'))process.exit(41);",
  "const cmd=args.find(s=>['getinfo','listpeerchannels','decode','xpay','listpays'].includes(s));",
  "if(cmd==='getinfo')process.stdout.write(JSON.stringify({network:'regtest'}));",
  "else if(cmd==='listpeerchannels')process.stdout.write(JSON.stringify({channels:[{state:'CHANNELD_NORMAL',peer_connected:true,spendable_msat:'50000000msat'}]}));",
  "else if(cmd==='decode'&&args.includes('string=lnbcrt1regtestsmokeinvoice'))process.stdout.write(JSON.stringify({type:'bolt11 invoice',valid:true,currency:'bcrt',payment_hash:'"+hash+"',amount_msat:'2000msat',created_at:Math.floor(Date.now()/1000)-1,expiry:3600}));",
  "else if(cmd==='xpay'&&args.includes('maxfee=1000msat'))process.stdout.write(JSON.stringify({status:'complete'}));",
  "else if(cmd==='listpays'&&args.includes('payment_hash="+hash+"'))process.stdout.write(JSON.stringify({pays:[{payment_hash:'"+hash+"',status:'complete',amount_sent_msat:'2200msat',created_at:12345}]}));",
  "else process.exit(42);"
 ].join('\n')+'\n';
 writeFileSync(path,script);chmodSync(path,0o700);
}
async function runInstalled(use){
 const dir=mkdtempSync(join(tmpdir(),'yabcm-installed-regtest-'));
 const bin=join(dir,'bin');mkdirSync(bin);const calls=join(dir,'calls.jsonl');
 fakeCli(join(bin,'lightning-cli'),calls);
 const catalog={version:'regtest-short-integration-1',plans:[{
  planId:'regtest-free-contract',termsRef:'urn:yabcm:regtest:smoke-one-minute-v1',
  grantClass:'free',durationSeconds:60,actualRateMsatPerHour:'7200000',
  maxBaseRewardMsatPerHour:'7200000',maxTotalMultiplierBps:10000,
  maxExtraBonusMsat:'0',maxWithdrawals:2,maxRoutingFeeMsatEach:'1000',
  minimumPayoutMsat:'1000',maxClaimsPerUtcDay:3,minGapSeconds:0,nonOverlapping:true
 }]};
 writeFileSync(join(dir,'catalog.json'),JSON.stringify(catalog));
 writeFileSync(join(dir,'secret'),token);chmodSync(join(dir,'secret'),0o600);
 const port=await choosePort();
 const args=['--import','./test/upstream-regtest-hook.mjs','scripts/serve-regtest.mjs',
  '--catalog',join(dir,'catalog.json'),'--db',join(dir,'book.sqlite'),
  '--wallet-id','regtest-payout','--lightning-dir',join(dir,'node'),
  '--secret-file',join(dir,'secret'),'--safety-reserve-msat','10000',
  '--external-reserve-msat','0','--withdraw-minimum-msat','1000',
  '--host','127.0.0.1','--port',String(port)];
 const srv=spawn(process.execPath,args,{cwd:root,env:{...process.env,PATH:bin+':'+process.env.PATH},
  stdio:['ignore','pipe','pipe']});
 let log='';srv.stdout.on('data',c=>log+=c);srv.stderr.on('data',c=>log+=c);
 const base='http://127.0.0.1:'+port;
 try{
  let ready=false;
  for(let i=0;i<90;i++){
   if(srv.exitCode!==null)throw Error('CLI startup failed: '+log);
   try{const r=await fetch(base+'/health',{signal:AbortSignal.timeout(300)});if(r.ok){ready=true;break;}}catch{}
   await new Promise(done=>setTimeout(done,50));
  }
  if(!ready)throw Error('CLI health never answered: '+log);
  const get=async route=>{const r=await fetch(base+route);return {code:r.status,data:await r.json()}};
  const post=async(route,body={},authorized=true)=>{
   const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',
    ...(authorized?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
   return {code:r.status,data:await r.json()};
  };
  await use({get,post,calls});
 }finally{
  if(srv.exitCode===null){srv.kill('SIGTERM');await Promise.race([once(srv,'exit'),new Promise(done=>setTimeout(done,1000))]);}
  if(srv.exitCode===null)srv.kill('SIGKILL');
  rmSync(dir,{force:true,recursive:true});
 }
}
test('whole regtest CLI installation exercises HTTP, atomic booking, earned msat, invoice payment and new wallet snapshot',async()=>{
 await runInstalled(async({get,post,calls})=>{
  assert.equal((await get('/health')).code,200);
  assert.equal((await get('/v1/catalog')).data.entries[0].availability.available,false);
  assert.equal((await post('/ops/wallet/refresh',{},false)).code,401);
  assert.equal((await post('/ops/wallet/refresh')).code,200);
  assert.equal((await get('/v1/catalog')).data.entries[0].availability.available,true);
  const book=await post('/ops/reserve',{orderId:'o1',principalId:'alice',planId:'regtest-free-contract'});
  assert.equal(book.data.status,'reserved');assert.equal(book.data.chargeAccepted,false);
  assert.equal((await post('/ops/reserve',{orderId:'o1',principalId:'alice',planId:'regtest-free-contract'})).data.status,'existing');
  assert.equal((await post('/ops/activate',{orderId:'o1',proof:'invalid'})).code,403);
  assert.equal((await post('/ops/activate',{orderId:'o1',proof:'manual-local-regtest-free:o1'})).data.state,'active');
  await new Promise(r=>setTimeout(r,1300));
  const earned=await post('/ops/accrue',{orderId:'o1'});
  assert.ok(BigInt(earned.data.earnedMsat)>=2000n,JSON.stringify(earned));
  assert.ok(BigInt((await post('/ops/account',{principalId:'alice'})).data.currentlyClaimableMsat)>=2000n);
  const prepared=await post('/ops/payout/prepare',{requestId:'p1',principalId:'alice',
   invoice,amountMsat:'2000',feeLimitMsat:'1000'});
  assert.equal(prepared.data.status,'prepared',JSON.stringify(prepared));
  const paid=await post('/ops/payout/dispatch',{requestId:'p1'});
  assert.equal(paid.data.state,'complete',JSON.stringify(paid));
  assert.equal(paid.data.paidMsat,'2000');assert.equal(paid.data.feeMsat,'200');
  assert.equal((await get('/v1/catalog')).data.entries[0].availability.available,false,'pre-payment snapshot invalidated');
  assert.equal((await post('/ops/wallet/refresh')).code,200);
  assert.equal((await get('/v1/catalog')).data.entries[0].availability.available,true);
  const recorded=readFileSync(calls,'utf8').trim().split('\n').map(x=>JSON.parse(x));
  assert.ok(recorded.some(x=>x.includes('decode')&&x.includes('string='+invoice)));
  assert.ok(recorded.some(x=>x.includes('xpay')&&x.includes('maxfee=1000msat')));
  assert.ok(recorded.some(x=>x.includes('listpays')&&x.includes('payment_hash='+hash)));
 });
});
