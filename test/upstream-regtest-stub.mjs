import {compileFixedTermRewardCeiling,assessPrefundedLightningSale} from './fixture.mjs';
export {compileFixedTermRewardCeiling,assessPrefundedLightningSale};
/** Synthetic outgoing capacity for integration transport testing only. */
export function projectCoreLightningOutbound({result,walletId,network,observedAt,sourceRef}){
 const active=result.channels.filter(c=>c.state==='CHANNELD_NORMAL'&&c.peer_connected===true);
 const spendable=active.reduce((sum,c)=>sum+BigInt(String(c.spendable_msat).replace(/msat$/u,'')),0n);
 return {id:walletId,network,observedAt,sourceRef,ready:active.length>0,spendableOutboundMsat:spendable.toString()};
}
