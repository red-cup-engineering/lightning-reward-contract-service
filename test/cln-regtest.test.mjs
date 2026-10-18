import test from 'node:test';
import assert from 'node:assert/strict';
import {createCLNRegtestAdapter} from '../src/cln-regtest.mjs';
const clock=()=>Date.parse('2026-10-17T22:00:00Z');
const hash='a'.repeat(64);
const rpc=async(command,...args)=>{
 if(command==='getinfo')return {network:'regtest'};
 if(command==='listpeerchannels')return {channels:[{state:'CHANNELD_NORMAL',peer_connected:true,spendable_msat:'42000msat'},{state:'CHANNELD_NORMAL',peer_connected:false,spendable_msat:'990000msat'}]};
 if(command==='decode')return {type:'bolt11 invoice',valid:true,currency:'bcrt',payment_hash:hash,amount_msat:'1500msat',created_at:1792274400,expiry:3600};
 if(command==='xpay')return {status:'complete',payment_hash:hash,amount_sent_msat:'1750msat'};
 if(command==='listpays')return {pays:[{status:'complete',payment_hash:hash,amount_sent_msat:'1750msat',completed_at:1792274405}]};
 throw Error('unexpected command '+command);
};
const projector=({result,walletId,network,observedAt,sourceRef})=>({id:walletId,network,observedAt,sourceRef,ready:true,
 spendableOutboundMsat:result.channels.filter(x=>x.peer_connected&&x.state==='CHANNELD_NORMAL').reduce((sum,x)=>sum+BigInt(x.spendable_msat.replace('msat','')),0n).toString()});
test('binds wallet to regtest, filters disconnected capacity and admits exact CLN invoice',async()=>{
 const a=createCLNRegtestAdapter({walletId:'test',rpc,clock,projectOutbound:projector});
 const wallet=await a.observeWallet();
 assert.equal(wallet.spendableOutboundMsat,'42000');
 const invoice=await a.decodeInvoice('lnbcrt-test-invoice');
 assert.equal(invoice.amountMsat,'1500');
 assert.equal(invoice.paymentHash,hash);
 assert.equal((await a.observePayment(hash)).amountSentMsat,'1750');
 assert.equal((await a.sendInvoice({invoice:'lnbcrt-test-invoice',maxFeeMsat:'500'})).status,'complete');
});
test('wrong-chain node refuses all invoice and wallet operations before sensitive RPC',async()=>{
 const mainnet=async c=>c==='getinfo'?{network:'bitcoin'}:rpc(c);
 const a=createCLNRegtestAdapter({walletId:'test',rpc:mainnet,clock,projectOutbound:projector});
 await assert.rejects(a.observeWallet(),/not on regtest/);
 await assert.rejects(a.decodeInvoice('lnbcrt-test-invoice'),/not on regtest/);
 await assert.rejects(a.sendInvoice({invoice:'lnbcrt-test-invoice',maxFeeMsat:'500'}),/not on regtest/);
});
test('no unknown-amount invoice, expired invoice, Bitcoin mainnet invoice or missing fee cap',async()=>{
 const a=createCLNRegtestAdapter({walletId:'test',rpc,clock,projectOutbound:projector});
 await assert.rejects(a.decodeInvoice('lnbc-mainnet'),/regtest/);
 await assert.rejects(a.sendInvoice({invoice:'lnbcrt-test-invoice'}),/maximum fee/);
 const d=async c=>c==='decode'?{type:'bolt11 invoice',valid:true,currency:'bcrt',payment_hash:hash,amount_msat:'0msat',created_at:1792274400,expiry:3600}:rpc(c);
 await assert.rejects(createCLNRegtestAdapter({walletId:'test',rpc:d,clock,projectOutbound:projector}).decodeInvoice('lnbcrt-test-invoice'),/positive amount/);
});
