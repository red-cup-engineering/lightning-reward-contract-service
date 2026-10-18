import {createServer} from 'node:http';
import {createHash,timingSafeEqual} from 'node:crypto';

const hash=s=>createHash('sha256').update(s).digest();
const policyHeaders={
 'content-type':'application/json; charset=utf-8',
 'cache-control':'no-store',
 'x-content-type-options':'nosniff',
 'referrer-policy':'no-referrer',
 'content-security-policy':"default-src 'none'; frame-ancestors 'none'",
};
function send(res,status,payload){res.writeHead(status,policyHeaders);res.end(JSON.stringify(payload)+'\n');}
async function bodyJson(req){
 let n=0,parts=[];
 for await(const c of req){n+=c.length;if(n>16384)throw new Error('request >16KiB');parts.push(c);}
 const value=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('JSON object required');
 return value;
}
function bearerOk(header,token){
 if(typeof header!=='string'||!header.startsWith('Bearer '))return false;
 return timingSafeEqual(hash(header.slice(7)),hash(token));
}
/**
 * Regtest-only operation receiver. No public payment or ad placement routes.
 * The operating adapter, rather than request JSON, supplies all wallet reads,
 * invoice verification and payment finality.
 */
export function createRewardRegtestHttp({store,wallet,verifyGrant,operatorToken}={}){
 if(typeof operatorToken!=='string'||Buffer.byteLength(operatorToken)<32)throw Error('operator token >=32 bytes required');
 if(!store||!wallet||typeof verifyGrant!=='function')throw Error('original wallet/book/receipt providers required');
 return createServer(async(req,res)=>{
  try{
   if(req.method==='GET'&&req.url==='/health')return send(res,200,{ok:true,network:'regtest',financialEffects:'disabled-by-default',safeForMainnet:false});
   if(req.method==='GET'&&req.url==='/v1/catalog')return send(res,200,{
    kind:'RewardContractCatalogRegtest.v1',mainnetSalesEnabled:false,
    entries:store.catalog().map(p=>({...p,availability:store.availableFor(p.id)}))});
   if(req.url.startsWith('/ops/')&&!bearerOk(req.headers.authorization,operatorToken))
    return send(res,401,{ok:false,refusal:'operator-authorization-required'});
   if(req.method!=='POST')return send(res,404,{ok:false,refusal:'not-found'});
   const route=req.url;
   // Intentionally no client service route that authorizes spend or earnings.
   if(!route.startsWith('/ops/'))return send(res,404,{ok:false,refusal:'not-found'});
   const x=await bodyJson(req);
   if(route==='/ops/wallet/refresh'){
    const observation=await wallet.observeWallet();
    const r=store.observeWallet(observation);
    return send(res,200,{ok:true,observationId:r.id,replay:r.replay,assurance:'trusted-regtest-node-observation-not-guaranteed-routing'});
   }
   if(route==='/ops/reserve')return send(res,200,{ok:true,...store.reserve({orderId:x.orderId,principalId:x.principalId,planId:x.planId})});
   if(route==='/ops/activate'){
    const proof=await verifyGrant({order:store.details(x.orderId),proof:x.proof});
    if(!proof||proof.verified!==true||typeof proof.sourceRef!=='string')
     return send(res,403,{ok:false,refusal:'no-independent-grant-receipt'});
    return send(res,200,{ok:true,...store.activate({orderId:x.orderId,receiptRef:proof.sourceRef})});
   }
   if(route==='/ops/accrue')return send(res,200,{ok:true,...store.accrue(x.orderId)});
   if(route==='/ops/account')return send(res,200,{ok:true,...store.accountDetails(x.principalId)});
   if(route==='/ops/payout/prepare'){
    // Decode the actual invoice with the trusted wallet, never trust client amount or hash.
    const decoded=await wallet.decodeInvoice(x.invoice);
    if(decoded.amountMsat!==x.amountMsat)throw new Error('invoice amount does not match customer request');
    return send(res,200,{ok:true,...store.preparePooledPayout({requestId:x.requestId,principalId:x.principalId,
     invoiceRef:decoded.invoiceRef,paymentHash:decoded.paymentHash,
     amountMsat:decoded.amountMsat,feeLimitMsat:x.feeLimitMsat})});
   }
   if(route==='/ops/payout/dispatch'){
    const p=store.payoutDetails(x.requestId);if(!p)throw Error('unknown payout');
    const claim=store.markPayoutInFlight(x.requestId);
    // A retransmission or unknown result must inspect listpays; it must NEVER
    // blindly call xpay twice after a crash or an ambiguous timeout.
    if(claim.replay)return send(res,202,{ok:true,state:claim.state,dispatch:'not-repeated',reconciliationRequired:true});
    let dispatchError=null;
    try{await wallet.sendInvoice({invoice:p.invoiceRef,maxFeeMsat:p.maxFeeMsat});}
    catch(e){dispatchError=String(e.message||e);}
    // Server never assumes failed dispatch means no payment. Query wallet finality.
    try{
     const observed=await wallet.observePayment(p.paymentHash);
     const r=store.reconcilePayout({requestId:p.requestId,paymentHash:p.paymentHash,
      networkStatus:observed.status,amountSentMsat:observed.amountSentMsat,receiptRef:observed.sourceRef});
     return send(res,r.state==='complete'?200:202,{ok:true,...r,dispatchError,reconciliationRequired:r.state!=='complete'});
    }catch(e){return send(res,202,{ok:true,state:'in-flight',dispatchError,reconciliationRequired:true,observationError:e.message});}
   }
   if(route==='/ops/payout/reconcile'){
    const p=store.payoutDetails(x.requestId);if(!p)throw Error('unknown payout');
    const observed=await wallet.observePayment(p.paymentHash);
    return send(res,200,{ok:true,...store.reconcilePayout({requestId:p.requestId,paymentHash:p.paymentHash,
      networkStatus:observed.status,amountSentMsat:observed.amountSentMsat,receiptRef:observed.sourceRef})});
   }
   if(route==='/ops/close'){
    const proof=await verifyGrant({order:store.details(x.orderId),proof:x.proof,purpose:'term-closed'});
    if(!proof?.verified)return send(res,403,{ok:false,refusal:'closure-not-independently-received'});
    return send(res,200,{ok:true,...store.releaseUnused(x.orderId,{finalityRef:proof.sourceRef})});
   }
   if(route==='/ops/void'){
    const proof=await verifyGrant({order:store.details(x.orderId),proof:x.proof,purpose:'payment-void'});
    if(!proof?.verified)return send(res,403,{ok:false,refusal:'no-independent-payment-void'});
    return send(res,200,{ok:true,...store.voidUnactivated(x.orderId,{proofRef:proof.sourceRef})});
   }
   if(route==='/ops/order')return send(res,200,{ok:true,order:store.details(x.orderId),events:store.eventHistory(x.orderId)});
   return send(res,404,{ok:false,refusal:'not-found'});
  }catch(e){return send(res,400,{ok:false,refusal:'invalid-operation-or-unreceived-evidence',message:String(e.message||e)});}
 });
}
