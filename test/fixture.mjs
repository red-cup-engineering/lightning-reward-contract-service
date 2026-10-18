const bigint = (s,name='msat')=>{if(typeof s!=='string'||!/^(0|[1-9][0-9]*)$/.test(s))throw new TypeError(name);return BigInt(s)};
const ceil=(a,b)=>(a+b-1n)/b;
/** Test-only stand-in with the same INPUT/OUTPUT contracts as source-owned pricing. */
export function compileFixedTermRewardCeiling(t){
 const duration=BigInt(t.durationSeconds), rate=bigint(t.maxBaseRewardMsatPerHour), multiplier=BigInt(t.maxTotalMultiplierBps);
 const reward=ceil(rate*duration*multiplier,3600n*10000n)+bigint(t.maxExtraBonusMsat);
 const fees=BigInt(t.maxWithdrawals)*bigint(t.maxRoutingFeeMsatEach);
 return {durationSeconds:String(duration),maxRewardMsat:String(reward),maxRoutingFeeMsat:String(fees),termsRef:t.termsRef};
}
export function assessPrefundedLightningSale({wallet,book,sale,policy}){
 const age=Date.parse(policy.asOf)-Date.parse(wallet.observedAt);
 if(!wallet.ready||wallet.id!==book.walletId||wallet.id!==sale.walletId||wallet.network!==policy.network||age<0||age>policy.maxSnapshotAgeMs)throw Error('wallet unavailable');
 const obligations=book.claims.reduce((s,x)=>s+bigint(x.maxRemainingRewardMsat)+bigint(x.maxRemainingFeeMsat),bigint(book.otherCommittedMsat));
 const available=bigint(wallet.spendableOutboundMsat)-obligations-bigint(policy.liquiditySafetyReserveMsat);
 const requested=bigint(sale.maxRewardMsat)+bigint(sale.maxRoutingFeeMsat);
 const ok=available>=requested;
 return {capacityFits:ok,state:ok?'capacity-quoted':'sold-out',revision:book.revision};
}
export const exampleCatalog=Object.freeze({version:'test-catalog-1',plans:[
 {planId:'free-8h',termsRef:'urn:yabcm:free-8h:v1',grantClass:'free',durationSeconds:28800,
  actualRateMsatPerHour:'1100',maxBaseRewardMsatPerHour:'1100',maxTotalMultiplierBps:10000,
  maxExtraBonusMsat:'0',maxWithdrawals:2,maxRoutingFeeMsatEach:'1000',minimumPayoutMsat:'1000',maxClaimsPerUtcDay:3,minGapSeconds:0,nonOverlapping:true},
 {planId:'offer-24h',termsRef:'urn:yabcm:offer-24h:v1',grantClass:'sponsored',durationSeconds:86400,
  actualRateMsatPerHour:'2000',maxBaseRewardMsatPerHour:'2000',maxTotalMultiplierBps:49000,
  maxExtraBonusMsat:'0',maxWithdrawals:2,maxRoutingFeeMsatEach:'1000',minimumPayoutMsat:'1000',maxClaimsPerUtcDay:24,minGapSeconds:0,nonOverlapping:false}
]});
export const defaultSettings=(dbpath,clock,walletId='payout-regtest')=>({databasePath:dbpath,walletId,clock,network:'regtest',
 sourceCatalog:exampleCatalog,deriveCeiling:compileFixedTermRewardCeiling,quoteCapacity:assessPrefundedLightningSale,
 dedicatedWalletExclusive:true,reservedExternalMsat:'0',safetyReserveMsat:'10000',maxWalletObservationAgeMs:60000});
