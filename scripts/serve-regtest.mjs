#!/usr/bin/env node
/**
 * Operator-only local Core Lightning regtest installation. MAINNET IS REFUSED.
 * No real paid ad partner, x402 purchase or monetary activation in this source.
 */
import {readFile,stat} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {createLightningRewardReservationStore} from '../src/reservation-store.mjs';
import {createCLNRegtestAdapter} from '../src/cln-regtest.mjs';
import {createRewardRegtestHttp} from '../src/http-regtest.mjs';
import {loadRegtestSiteAssets} from '../src/regtest-site-assets.mjs';
import {compileFixedTermRewardCeiling} from '@red-cup-engineering/capability-pricing-service/fixed-term-reward-ceiling';
import {assessPrefundedLightningSale,projectCoreLightningOutbound} from '@red-cup-engineering/capability-pricing-service/prefunded-lightning-inventory';
const {values}=parseArgs({options:{
 'catalog':{type:'string'}, 'db':{type:'string'},'wallet-id':{type:'string'},
 'lightning-dir':{type:'string'},'secret-file':{type:'string'},
 'safety-reserve-msat':{type:'string'},'external-reserve-msat':{type:'string'},
 'withdraw-minimum-msat':{type:'string'}, 'port':{type:'string'},'host':{type:'string'},
 'demo-dist':{type:'string'},
}});
function mandatory(name){const x=values[name];if(!x)throw Error('--'+name+' is required');return x;}
async function main(){
 const host=values.host??'127.0.0.1';
 if(host!=='127.0.0.1')throw Error('regtest service is loopback-only; use an authorized reverse proxy later');
 const port=Number(values.port??19878);
 if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('untrusted operator port');
 const secretPath=resolve(mandatory('secret-file'));
 const permissions=(await stat(secretPath)).mode&0o777;
 if(permissions!==0o600)throw Error('operator secret file must have 0600 permissions');
 const token=(await readFile(secretPath,'utf8')).trim();
 if(Buffer.byteLength(token,'utf8')<32)throw Error('operator token too weak');
 const catalog=JSON.parse(await readFile(resolve(mandatory('catalog')),'utf8'));
 const walletId=mandatory('wallet-id');
 const wallet=createCLNRegtestAdapter({walletId,lightningDir:mandatory('lightning-dir'),
  projectOutbound:projectCoreLightningOutbound});
 const store=createLightningRewardReservationStore({databasePath:resolve(mandatory('db')),
  walletId,network:'regtest',clock:Date.now,sourceCatalog:catalog,
  deriveCeiling:compileFixedTermRewardCeiling,quoteCapacity:assessPrefundedLightningSale,
  dedicatedWalletExclusive:true,
  reservedExternalMsat:mandatory('external-reserve-msat'),
  safetyReserveMsat:mandatory('safety-reserve-msat'),
  accountWithdrawalMinimumMsat:mandatory('withdraw-minimum-msat')});
 const verifyGrant=async({order,proof,purpose})=>{
  // This is the ONLY admitted grant type for a new source-only regtest run.
  // Paid/sponsored source plans cannot be activated with fabricated callbacks.
  if(order?.planId!=='regtest-free-contract'||order?.status!=='reserved'||
   purpose!==undefined||proof!==('manual-local-regtest-free:'+order.orderId))
   return {verified:false};
  return {verified:true,sourceRef:'urn:yabcm:operator-regtest-only-free-grant:'+order.orderId};
 };
 const staticDemoAssets=values['demo-dist'] ? await loadRegtestSiteAssets(values['demo-dist']) : null;
 const server=createRewardRegtestHttp({store,wallet,verifyGrant,operatorToken:token,staticDemoAssets});
 server.listen(port,host,()=>process.stdout.write(`Regtest-only reservation operator: http://${host}:${port}\n`));
 const shutdown=()=>server.close(()=>{store.close();process.exit(0)});
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
main().catch(error=>{process.stderr.write('Startup refused: '+String(error.message||error)+'\n');process.exitCode=2});
