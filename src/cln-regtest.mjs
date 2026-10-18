import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const msat = (v,label) => {
 const s=typeof v==='number'&&Number.isSafeInteger(v)?String(v):v;
 if(typeof s!=='string'||!/^(0|[1-9][0-9]*)(?:msat)?$/.test(s))throw new TypeError(`invalid ${label}`);
 return BigInt(s.replace(/msat$/, ''));
};
/**
 * Dedicated CLN daemon node, bound to regtest before any reads or effects.
 * The adapter refuses to interpret unverified customer JSON as RPC results.
 * No other code should be able to invoke mainnet using this adapter.
 */
export function createCLNRegtestAdapter({walletId, lightningDir, rpc = null, clock = Date.now,
  projectOutbound} = {}) {
 if(typeof walletId!=='string'||!walletId.trim())throw new Error('walletId required');
 if(typeof projectOutbound!=='function')throw new Error('Core Lightning outbound projector required');
 if(!rpc && (typeof lightningDir!=='string'||!lightningDir.startsWith('/')))
  throw new Error('absolute CLN_LIGHTNING_DIR or trusted RPC test adapter required');
 const call = rpc ?? (async(command,...args) => {
  const {stdout}=await exec('lightning-cli',['--regtest','--lightning-dir='+lightningDir,'-k',command,...args],
   {timeout:10000,maxBuffer:1024*1024});return JSON.parse(stdout);
 });
 async function checkedCall(command,...args){
  const info=await call('getinfo');
  if(info.network!=='regtest')throw new Error('CLN node not on regtest; financial action refused');
  if(info.warning_bitcoind_sync||info.warning_lightningd_sync)throw new Error('CLN node not synchronized');
  return await call(command,...args);
 }
 async function observeWallet(){
  const snapshot=await checkedCall('listpeerchannels');
  const observedAt=new Date(clock()).toISOString();
  // Original pricing projector must include peer_connected===true check.
  const digest=createHash('sha256').update(JSON.stringify(snapshot.channels)).digest('hex');
  return projectOutbound({result:snapshot,walletId,network:'regtest',observedAt,
    sourceRef:`urn:cln:regtest:${walletId}:${observedAt}:${digest}`});
 }
 async function decodeInvoice(invoice){
  if(typeof invoice!=='string'||!invoice.startsWith('lnbcrt')||invoice.length>1600)
   throw new Error('only finite-amount regtest BOLT11 invoices are supported');
  const d=await checkedCall('decode','string='+invoice);
  if(d.type!=='bolt11 invoice'||d.valid!==true||d.currency!=='bcrt'||!d.payment_hash)
   throw new Error('invalid regtest BOLT11 invoice');
  const amount=msat(d.amount_msat,'invoice amount');
  if(amount<=0n)throw new Error('invoice has no specified positive amount');
  const expires=Number(d.created_at)+Number(d.expiry);
  if(!Number.isSafeInteger(expires)||expires*1000<=clock())throw new Error('invoice expired');
  return {invoiceRef:invoice,paymentHash:d.payment_hash,amountMsat:amount.toString(),
    expiresAt:new Date(expires*1000).toISOString(),sourceRef:'urn:cln:regtest:decoded:'+d.payment_hash};
 }
 async function sendInvoice({invoice,maxFeeMsat}){
  if(!invoice.startsWith('lnbcrt'))throw new Error('regtest invoice required');
  const fee=msat(maxFeeMsat,'maximum fee');
  // xpay accepts maxfee exact msat argument by keyword; never use unbounded defaults.
  return checkedCall('xpay','invstring='+invoice,'maxfee='+fee.toString()+'msat');
 }
 async function observePayment(paymentHash){
  if(typeof paymentHash!=='string'||!/^([0-9a-f]{64})$/.test(paymentHash))
   throw new Error('invalid payment hash');
  const r=await checkedCall('listpays','payment_hash='+paymentHash);
  if(!r||!Array.isArray(r.pays))throw new Error('malformed CLN payment observation');
  const relevant=r.pays.filter(p=>p.payment_hash===paymentHash);
  if(relevant.length!==1)return {status:'pending',sourceRef:'urn:cln:regtest:unresolved:'+paymentHash};
  const p=relevant[0];
  if(!['complete','pending','failed'].includes(p.status))throw new Error('unknown CLN pay status');
  return {status:p.status,sourceRef:'urn:cln:regtest:payment:'+paymentHash+':'+(p.updated_index??p.completed_at??p.created_at),
    paymentHash,amountSentMsat:p.status==='complete'?msat(p.amount_sent_msat,'CLN amount sent').toString():null};
 }
 return Object.freeze({observeWallet,decodeInvoice,sendInvoice,observePayment});
}
