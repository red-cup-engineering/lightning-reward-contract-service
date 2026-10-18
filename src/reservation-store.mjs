import { DatabaseSync } from 'node:sqlite';
import {createHash} from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A single dedicated payout-wallet contract liability *subledger*, not a general
 * ledger or wallet. The actual customer payment, source-priced offer, and Lightning
 * payout belong to their external original authorities. Test-regtest-only until
 * an operator owns exclusive node spending, reconciliation, policy and receipts.
 *
 * Admission uses an exclusive SQLite transaction and the existing Red Cup
 * pricing providers INJECTED by the caller. No second pricing law is embedded.
 */
const RE = /^(0|[1-9][0-9]*)$/u;
const integer = (v, label) => {
  if (typeof v !== 'string' || !RE.test(v) || v.length > 32)
    throw new TypeError(`${label}: exact decimal integer string required`);
  return BigInt(v);
};
const label = (v, name) => {
  if (typeof v !== 'string' || !v.trim() || v.length > 256 || /[\u0000-\u001f]/u.test(v))
    throw new TypeError(`${name}: short nonempty identifier required`);
  return v;
};
const utc = ms => new Date(ms).toISOString();
function nowMillis(clock) {
  const n = clock();
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('trusted clock invalid');
  return n;
}
function assertString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} required`);
  return value;
}

export function createLightningRewardReservationStore({databasePath, walletId, network = 'regtest',
  sourceCatalog, deriveCeiling, quoteCapacity, clock = Date.now,
  reservedExternalMsat, safetyReserveMsat, accountWithdrawalMinimumMsat='1000', maxWalletObservationAgeMs = 15000,
  dedicatedWalletExclusive = false} = {}) {
  if (network !== 'regtest') throw new Error('regtest only; no mainnet/signet authorization in this service');
  if (dedicatedWalletExclusive !== true) throw new Error('payout wallet must have exclusive operation ownership');
  label(walletId, 'walletId');
  integer(reservedExternalMsat, 'reservedExternalMsat');
  integer(safetyReserveMsat, 'safetyReserveMsat');
  if(integer(accountWithdrawalMinimumMsat,'accountWithdrawalMinimumMsat')===0n)throw new TypeError('withdrawal floor cannot be zero');
  if (!Number.isSafeInteger(maxWalletObservationAgeMs) || maxWalletObservationAgeMs < 0 || maxWalletObservationAgeMs > 60000)
    throw new TypeError('observation age must be bounded');
  if (typeof deriveCeiling !== 'function' || typeof quoteCapacity !== 'function')
    throw new TypeError('original pricing providers are required');
  if (!sourceCatalog || !Array.isArray(sourceCatalog.plans) || !sourceCatalog.plans.length)
    throw new TypeError('authoritative source catalog must be explicitly bound');
  label(sourceCatalog.version, 'catalog.version');
  const catalog = new Map();
  for (const p of sourceCatalog.plans) {
    label(p.planId, 'planId'); label(p.termsRef, 'termsRef');
    if (catalog.has(p.planId)) throw new Error('duplicate plan');
    const ceiling = deriveCeiling(p);
    const rewardCap = integer(ceiling.maxRewardMsat, 'ceiling.maxRewardMsat');
    const feeCap = integer(ceiling.maxRoutingFeeMsat, 'ceiling.maxRoutingFeeMsat');
    const rate = integer(p.actualRateMsatPerHour, 'actualRateMsatPerHour');
    const duration = Number(ceiling.durationSeconds);
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 366 * 86400)
      throw new Error('duration invalid');
    // An hourly rate is not a whole-term liability. Compare the term's
    // exact upper bound, rounded up, not a fictitious extra hour.
    const actualTermMax=(rate * BigInt(duration) + 3599n) / 3600n;
    if (rewardCap < actualTermMax || rewardCap === 0n)
      throw new Error('unbackable plan / insufficient term ceiling');
    if (!['free', 'sponsored', 'paid'].includes(p.grantClass)) throw new TypeError('grantClass unknown');
    const minPayout = integer(p.minimumPayoutMsat, 'minimumPayoutMsat');
    if(!Number.isSafeInteger(p.maxClaimsPerUtcDay)||p.maxClaimsPerUtcDay<1||p.maxClaimsPerUtcDay>1440)throw new TypeError('per-principal daily contract issue limit required');
    if(!Number.isSafeInteger(p.minGapSeconds)||p.minGapSeconds<0||p.minGapSeconds>366*86400)throw new TypeError('minGapSeconds required');
    if(typeof p.nonOverlapping!=='boolean')throw new TypeError('nonOverlapping must be declared by product');
    if (minPayout <= 0n) throw new TypeError('minimum payout must be positive');

    catalog.set(p.planId, Object.freeze({
      id:p.planId,termsRef:p.termsRef,sourceVersion:sourceCatalog.version,
      class:p.grantClass,durationSeconds:duration,actualRateMsatPerHour:rate.toString(),
      capRewardMsat:rewardCap.toString(),capFeesMsat:feeCap.toString(),
      minimumPayoutMsat:minPayout.toString(),maxClaimsPerUtcDay:p.maxClaimsPerUtcDay,
      minGapSeconds:p.minGapSeconds,nonOverlapping:p.nonOverlapping,
    }));
  }
  if (typeof databasePath !== 'string' || !databasePath.trim()) throw new Error('databasePath required');
  mkdirSync(dirname(databasePath), {recursive:true, mode:0o700});
  const db=new DatabaseSync(databasePath, {timeout:5000});
  chmodSync(databasePath,0o600); // user identifiers and financial reservations are confidential
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK(id=1),wallet_id TEXT NOT NULL,network TEXT NOT NULL,required_observation_seq INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS term_identities (terms_ref TEXT PRIMARY KEY,sha256 TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS wallet_observations (seq INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id TEXT NOT NULL, network TEXT NOT NULL, source_ref TEXT NOT NULL, observed_at TEXT NOT NULL,
    usable_outbound_msat TEXT NOT NULL, ready INTEGER NOT NULL CHECK(ready IN (0,1)));
  CREATE TABLE IF NOT EXISTS reward_orders (
    order_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, plan_id TEXT NOT NULL, terms_ref TEXT NOT NULL,
    plan_json TEXT NOT NULL, max_reward_msat TEXT NOT NULL,max_fee_msat TEXT NOT NULL,
    earned_msat TEXT NOT NULL DEFAULT '0',paid_msat TEXT NOT NULL DEFAULT '0',
    fee_spent_msat TEXT NOT NULL DEFAULT '0',released_reward_msat TEXT NOT NULL DEFAULT '0',
    released_fee_msat TEXT NOT NULL DEFAULT '0',status TEXT NOT NULL,
    reserved_at TEXT NOT NULL, activated_at TEXT, expires_at TEXT,
    admission_observation INTEGER NOT NULL REFERENCES wallet_observations(seq),
    activation_receipt TEXT UNIQUE, termination_receipt TEXT UNIQUE);
  CREATE TABLE IF NOT EXISTS payouts (
    request_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES reward_orders(order_id),
    principal_id TEXT NOT NULL,
    payment_hash TEXT NOT NULL UNIQUE, invoice_ref TEXT NOT NULL,
    amount_msat TEXT NOT NULL, max_fee_msat TEXT NOT NULL, fee_paid_msat TEXT,
    state TEXT NOT NULL, receipt_ref TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS payout_allocations (
    request_id TEXT NOT NULL REFERENCES payouts(request_id),
    order_id TEXT NOT NULL REFERENCES reward_orders(order_id),
    amount_msat TEXT NOT NULL, fee_msat TEXT NOT NULL,
    PRIMARY KEY(request_id,order_id));
  CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL, event_type TEXT NOT NULL, source_ref TEXT NOT NULL,
    at TEXT NOT NULL, metadata_json TEXT NOT NULL);
  `); // configuration values inserted with a bound statement below
  // Older release files have no observation-freshness watermark. Migrate
  // conservatively: invalidate EVERY historical wallet reading, because an
  // already-posted payout might have spent those funds before this upgrade.
  const columns=db.prepare('PRAGMA table_info(configuration)').all().map(c=>c.name);
  if(!columns.includes('required_observation_seq')){
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec('ALTER TABLE configuration ADD COLUMN required_observation_seq INTEGER NOT NULL DEFAULT 1');
      db.exec('UPDATE configuration SET required_observation_seq = (SELECT COALESCE(MAX(seq),0)+1 FROM wallet_observations)');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  // sqlite3 DatabaseSync exec cannot bind values: separate statement.
  db.prepare('INSERT OR IGNORE INTO configuration(id,wallet_id,network) VALUES(1,?,?)').run(walletId,network);
  const conf=db.prepare('SELECT wallet_id,network FROM configuration WHERE id=1').get();
  if (conf.wallet_id!==walletId || conf.network!==network) throw new Error('database belonged to another payout wallet or chain');
  // An original term reference may be retired, never silently redefined.
  const readTerms=db.prepare('SELECT sha256 FROM term_identities WHERE terms_ref=?');
  const saveTerms=db.prepare('INSERT INTO term_identities(terms_ref,sha256) VALUES(?,?)');
  for(const p of catalog.values()){
    const digest=createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const existing=readTerms.get(p.termsRef);
    if(existing&&existing.sha256!==digest)throw Error('contract terms changed without a new termsRef: '+p.termsRef);
    if(!existing)saveTerms.run(p.termsRef,digest);
  }
  const getOrder=db.prepare('SELECT * FROM reward_orders WHERE order_id=?');
  const getPayout=db.prepare('SELECT * FROM payouts WHERE request_id=?');
  const getLatestWallet=db.prepare('SELECT * FROM wallet_observations ORDER BY seq DESC LIMIT 1');
  const allOrders=db.prepare("SELECT * FROM reward_orders WHERE status IN ('reserved','active','earned','payout-in-flight')");
  const allPayouts=db.prepare("SELECT * FROM payouts WHERE state IN ('prepared','in-flight','unknown')");
  const appendEvent=db.prepare('INSERT INTO events(order_id,event_type,source_ref,at,metadata_json) VALUES(?,?,?,?,?)');
  function event(orderId,type,ref,meta={}) {
    appendEvent.run(orderId,type,label(ref,'event ref'),utc(nowMillis(clock)),JSON.stringify(meta));
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {const result=work();db.exec('COMMIT');return result;}
    catch(e){db.exec('ROLLBACK');throw e;}
  }
  // A wallet read made before an outgoing payment is never reused after
  // that payment changes the node's actual balance. Source timestamps are
  // insufficient: several wallet reads, dispatches and completions may share
  // the same millisecond. The database sequence is the authoritative barrier.
  function invalidateWalletSnapshot(){
    const row=db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next_seq FROM wallet_observations').get();
    db.prepare('UPDATE configuration SET required_observation_seq=? WHERE id=1').run(row.next_seq);
  }
  function snapshotFromDb() {
    const v=getLatestWallet.get();
    if (!v) throw new Error('wallet-unobserved');
    if(db.prepare("SELECT 1 FROM payouts WHERE state IN ('in-flight','unknown') LIMIT 1").get())
      throw new Error('payout-unresolved-sales-paused');
    const floor=db.prepare('SELECT required_observation_seq AS seq FROM configuration WHERE id=1').get().seq;
    if(v.seq<floor)throw new Error('wallet-refresh-required-after-outgoing-payment');
    return {id:v.wallet_id,network:v.network,sourceRef:v.source_ref,observedAt:v.observed_at,
      ready:v.ready===1,spendableOutboundMsat:v.usable_outbound_msat};
  }
  function currentBook() {
    const claims=allOrders.all().map(o=>({
      intentId:o.order_id,actor:o.principal_id,walletId,
      termsRef:o.terms_ref,state:o.status,
      maxRemainingRewardMsat:(integer(o.max_reward_msat,'stored reward') - integer(o.paid_msat,'stored paid')-integer(o.released_reward_msat,'stored released')).toString(),
      maxRemainingFeeMsat:(integer(o.max_fee_msat,'stored fee') - integer(o.fee_spent_msat,'stored paid fee')-integer(o.released_fee_msat,'stored fee released')).toString(),
    }));
    if(claims.some(c=>BigInt(c.maxRemainingRewardMsat)<0n||BigInt(c.maxRemainingFeeMsat)<0n))throw Error('book over-released or overpaid');
    const revision=db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq;
    return {walletId,revision:String(revision),otherCommittedMsat:reservedExternalMsat,claims};
  }
  function quoteFor(plan,{orderId,principalId},wallet,book,now) {
    return quoteCapacity({wallet,book,sale:{walletId,actor:principalId,intentId:orderId,
      termsRef:plan.termsRef,unit:'msat',maxRewardMsat:plan.capRewardMsat,
      maxRoutingFeeMsat:plan.capFeesMsat},
      policy:{network,asOf:utc(now),maxSnapshotAgeMs:maxWalletObservationAgeMs,
        liquiditySafetyReserveMsat:safetyReserveMsat}});
  }
  function availableFor(planId) {
    const plan=catalog.get(planId);
    if(!plan)throw Error('unknown plan');
    try {
      const q=quoteFor(plan,{orderId:'availability-probe',principalId:'public-readonly'},snapshotFromDb(),currentBook(),nowMillis(clock));
      return {planId,available:q.capacityFits===true,reason:q.state,sourceVersion:plan.sourceVersion,
        maximumCostMsat:(integer(plan.capRewardMsat,'cap')+integer(plan.capFeesMsat,'fees')).toString()};
    }catch{return {planId,available:false,reason:'temporarily-unavailable',sourceVersion:plan.sourceVersion};}
  }
  function observeWallet(snapshot) {
    // CALLER MUST be the authorized CLN adapter, NEVER a public HTTP argument.
    if (snapshot.id!==walletId||snapshot.network!==network)throw Error('wrong wallet/chain observation');
    label(snapshot.sourceRef,'wallet.sourceRef');
    if(typeof snapshot.ready!=='boolean')throw TypeError('wallet.ready must be Boolean');
    integer(snapshot.spendableOutboundMsat,'wallet.outbound');
    const observed=Date.parse(snapshot.observedAt);
    const now=nowMillis(clock);
    if(!Number.isFinite(observed)||observed>now||now-observed>maxWalletObservationAgeMs)
      throw Error('stale/future wallet observation');
    return transaction(()=>{
      const old=getLatestWallet.get();
      if(old&&Date.parse(old.observed_at)>observed)throw Error('out-of-order wallet observation');
      if(old&&old.source_ref===snapshot.sourceRef){
        if(old.usable_outbound_msat!==snapshot.spendableOutboundMsat||old.ready!==(snapshot.ready?1:0))
          throw Error('wallet source identity conflict');
        return {id:old.seq,replay:true};
      }
      const out=db.prepare('INSERT INTO wallet_observations(wallet_id,network,source_ref,observed_at,usable_outbound_msat,ready) VALUES(?,?,?,?,?,?)').run(
        walletId,network,snapshot.sourceRef,snapshot.observedAt,snapshot.spendableOutboundMsat,snapshot.ready?1:0);
      return {id:Number(out.lastInsertRowid),replay:false};
    });
  }
  function reserve({orderId,principalId,planId}={}) {
    label(orderId,'orderId');label(principalId,'principalId');
    const plan=catalog.get(planId);if(!plan)throw Error('unknown plan');
    return transaction(()=>{
      const prior=getOrder.get(orderId);
      if(prior){
        if(prior.principal_id!==principalId||prior.plan_id!==planId||prior.terms_ref!==plan.termsRef)
          throw Error('idempotency conflict');
        return {status:'existing',orderId,contractState:prior.status};
      }
      // This is NOT a browser clock: source rules are admitted under the same
      // serializable operation as the money reserve. Include held claims so a
      // retry cannot multiply a free plan before activation.
      const now=nowMillis(clock),today=Math.floor(now/86400000);
      const recent=db.prepare("SELECT status,reserved_at,expires_at FROM reward_orders WHERE principal_id=? AND plan_id=? AND status!='void' ORDER BY reserved_at DESC").all(principalId,planId);
      if(recent.filter(o=>Math.floor(Date.parse(o.reserved_at)/86400000)===today).length>=plan.maxClaimsPerUtcDay)
        return {status:'ineligible',reason:'per-day-limit',orderId};
      if(recent.some(o=>now-Date.parse(o.reserved_at)<plan.minGapSeconds*1000))
        return {status:'ineligible',reason:'cooldown',orderId};
      if(plan.nonOverlapping&&recent.some(o=>o.status==='reserved'||(o.expires_at&&Date.parse(o.expires_at)>now)))
        return {status:'ineligible',reason:'existing-contract-still-running',orderId};
      let wallet,q;
      try {wallet=snapshotFromDb();q=quoteFor(plan,{orderId,principalId},wallet,currentBook(),nowMillis(clock));}
      catch(e){return {status:'unavailable',reason:e.message,orderId};}
      if(q.capacityFits!==true||q.state!=='capacity-quoted')return {status:'sold-out',reason:q.state,orderId};
      const when=utc(nowMillis(clock));
      const observation=getLatestWallet.get().seq;
      db.prepare(`INSERT INTO reward_orders(order_id,principal_id,plan_id,terms_ref,plan_json,max_reward_msat,max_fee_msat,status,reserved_at,admission_observation)
        VALUES(?,?,?,?,?,?,?,'reserved',?,?)`).run(orderId,principalId,planId,plan.termsRef,JSON.stringify(plan),
        plan.capRewardMsat,plan.capFeesMsat,when,observation);
      event(orderId,'reserved',wallet.sourceRef,{maxRewardMsat:plan.capRewardMsat,maxFeesMsat:plan.capFeesMsat,bookRevision:q.revision});
      return {status:'reserved',orderId,termsRef:plan.termsRef,maxRewardMsat:plan.capRewardMsat,
        maxRoutingFeeMsat:plan.capFeesMsat,chargeAccepted:false};
    });
  }
  function activate({orderId,receiptRef}={}) {
    label(orderId,'orderId');label(receiptRef,'receiptRef');
    // Receiver MUST independently validate merchant/advertiser/grant authority.
    return transaction(()=>{
      const o=getOrder.get(orderId);if(!o)throw Error('unknown order');
      if(o.status==='active'||o.status==='earned'){
        if(o.activation_receipt===receiptRef)return {state:o.status,replay:true};
        throw Error('activation receipt conflict');
      }
      if(o.status!=='reserved')throw Error('order not awaiting proof');
      const p=JSON.parse(o.plan_json);
      const now=nowMillis(clock),expires=now+p.durationSeconds*1000;
      db.prepare("UPDATE reward_orders SET status='active',activated_at=?,expires_at=?,activation_receipt=? WHERE order_id=?")
        .run(utc(now),utc(expires),receiptRef,orderId);
      event(orderId,'activated',receiptRef,{expiresAt:utc(expires)});
      return {state:'active',replay:false,expiresAt:utc(expires)};
    });
  }
  // Call only inside an exclusive SQLite transaction. Paid/earned balances are
  // moved from reserved terms, never independently minted by the UI.
  function materializeOrder(orderId) {
    label(orderId,'orderId');
      const o=getOrder.get(orderId);if(!o)throw Error('unknown order');
      if(!['active','earned','payout-in-flight'].includes(o.status))return {state:o.status,earnedMsat:o.earned_msat};
      const p=JSON.parse(o.plan_json),now=nowMillis(clock);
      const starts=Date.parse(o.activated_at),ends=Date.parse(o.expires_at);
      const elapsedMs=Math.max(0,Math.min(ends,now)-starts);
      const newly=BigInt(elapsedMs)*integer(p.actualRateMsatPerHour,'term rate')/3600000n;
      const max=integer(o.max_reward_msat,'reward cap');
      const final=newly<max?newly:max;
      const prior=integer(o.earned_msat,'earned');
      if(final<prior)throw Error('clock/regression would decrease earned reward');
      const nextStatus=now>=ends&&o.status!=='payout-in-flight'?'earned':o.status;
      if(final!==prior||nextStatus!==o.status){
        db.prepare('UPDATE reward_orders SET earned_msat=?,status=? WHERE order_id=?').run(final.toString(),nextStatus,orderId);
        event(orderId,'accrued','urn:source-owned:server-clock',{from:prior.toString(),to:final.toString(),status:nextStatus});
      }
      return {state:nextStatus,earnedMsat:final.toString(),pendingMsat:(final-integer(o.paid_msat,'paid')).toString()};
  }
  function accrue(orderId) {
    return transaction(() => materializeOrder(orderId));
  }
  function materializePrincipal(principalId) {
    const ids=db.prepare("SELECT order_id FROM reward_orders WHERE principal_id=? AND status IN ('active','earned','payout-in-flight')").all(principalId);
    for(const row of ids)materializeOrder(row.order_id);
  }
  /** A human's actual Lightning payout collects fractional earned rewards from
   * multiple finite contracts. All credited msat must remain attributable to
   * the source contract; do not require each tiny plan to beat an invoice fee.
   * A decoded invoice remains externally verified by the CLN adapter.
   */
  function preparePooledPayout({requestId,principalId,invoiceRef,paymentHash,amountMsat,feeLimitMsat}={}) {
    label(requestId,'requestId');label(principalId,'principalId');
    label(invoiceRef,'invoiceRef');label(paymentHash,'paymentHash');
    const amount=integer(amountMsat,'payout amount');const fee=integer(feeLimitMsat,'fee limit');
    if(amount<integer(accountWithdrawalMinimumMsat,'withdrawal floor'))throw Error('below account withdrawal minimum');
    return transaction(()=>{
      materializePrincipal(principalId);
      const before=getPayout.get(requestId);
      if(before){
        if(before.principal_id!==principalId||before.payment_hash!==paymentHash||before.amount_msat!==amountMsat||before.invoice_ref!==invoiceRef||before.max_fee_msat!==feeLimitMsat)
          throw Error('payout idempotency conflict');
        return {status:before.state,requestId,replay:true};
      }
      const orders=db.prepare("SELECT * FROM reward_orders WHERE principal_id=? AND status IN ('active','earned') ORDER BY reserved_at,order_id").all(principalId);
      if(orders.length===0)throw Error('principal has no payable active or earned contracts');
      const activeAllocs=db.prepare("SELECT a.order_id,a.amount_msat,a.fee_msat FROM payout_allocations a JOIN payouts p ON p.request_id=a.request_id WHERE p.state IN ('prepared','in-flight','unknown')").all();
      const assigned=new Map();
      for(const a of activeAllocs){
        const old=assigned.get(a.order_id)||{reward:0n,fee:0n};
        assigned.set(a.order_id,{reward:old.reward+integer(a.amount_msat,'active reserved payout'),fee:old.fee+integer(a.fee_msat,'active reserved fee')});
      }
      let due=amount,feeDue=fee;
      const allocations=[];
      for(const o of orders){
        const existing=assigned.get(o.order_id)||{reward:0n,fee:0n};
        const possibleReward=integer(o.earned_msat,'earned')-integer(o.paid_msat,'paid')-existing.reward;
        const possibleFee=integer(o.max_fee_msat,'max fee')-integer(o.fee_spent_msat,'fee paid')-existing.fee;
        if(possibleReward<0n||possibleFee<0n)throw Error('principal credit/fee pool overallocated');
        const reward=due<possibleReward?due:possibleReward;
        const reserveFee=feeDue<possibleFee?feeDue:possibleFee;
        if(reward!==0n||reserveFee!==0n)allocations.push({orderId:o.order_id,amount:reward,fee:reserveFee});
        due-=reward;feeDue-=reserveFee;
        if(due===0n&&feeDue===0n)break;
      }
      if(due!==0n)throw Error('insufficient accumulated earned account balance');
      if(feeDue!==0n)throw Error('insufficient fully backed withdrawal fee capacity');
      const first=allocations[0].orderId;
      db.prepare("INSERT INTO payouts(request_id,order_id,principal_id,payment_hash,invoice_ref,amount_msat,max_fee_msat,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'prepared',?,?)")
        .run(requestId,first,principalId,paymentHash,invoiceRef,amountMsat,feeLimitMsat,utc(nowMillis(clock)),utc(nowMillis(clock)));
      const add=db.prepare('INSERT INTO payout_allocations(request_id,order_id,amount_msat,fee_msat) VALUES(?,?,?,?)');
      for(const a of allocations){
        add.run(requestId,a.orderId,a.amount.toString(),a.fee.toString());
        event(a.orderId,'payout-share-prepared','urn:source-owned:account-withdrawal-claim',{requestId,amountMsat:a.amount.toString(),maxFeeMsat:a.fee.toString()});
      }
      return {status:'prepared',requestId,replay:false,sourceContracts:allocations.length};
    });
  }
  function preparePayout({requestId,orderId,invoiceRef,paymentHash,amountMsat,feeLimitMsat}={}) {
    const o=getOrder.get(label(orderId,'orderId'));
    if(!o)throw Error('unknown order');
    return preparePooledPayout({requestId,principalId:o.principal_id,invoiceRef,paymentHash,amountMsat,feeLimitMsat});
  }
  function markPayoutInFlight(requestId) {
    return transaction(()=>{
      const p=getPayout.get(label(requestId,'requestId'));if(!p)throw Error('unknown payout');
      if(p.state==='in-flight'||p.state==='unknown')return {state:p.state,replay:true};
      if(p.state!=='prepared')throw Error('payout not prepared');
      db.prepare("UPDATE payouts SET state='in-flight',updated_at=? WHERE request_id=?").run(utc(nowMillis(clock)),requestId);
      invalidateWalletSnapshot();
      const owners=db.prepare('SELECT order_id FROM payout_allocations WHERE request_id=?').all(requestId);
      for(const a of owners){
        db.prepare("UPDATE reward_orders SET status='payout-in-flight' WHERE order_id=?").run(a.order_id);
        event(a.order_id,'payout-dispatch-intent','urn:source-owned:wallet-outbox',{requestId,paymentHash:p.payment_hash});
      }
      return {state:'in-flight',replay:false};
    });
  }
  function reconcilePayout({requestId,paymentHash,networkStatus,amountSentMsat,receiptRef}={}) {
    // Trusted wallet listpays result ONLY; a client must never call this with self-declared status.
    label(requestId,'requestId');label(paymentHash,'paymentHash');label(receiptRef,'receiptRef');
    if(!['complete','failed','pending'].includes(networkStatus))throw Error('invalid payment result');
    return transaction(()=>{
      const pay=getPayout.get(requestId);if(!pay)throw Error('unknown payout');
      if(pay.payment_hash!==paymentHash)throw Error('payment identity mismatch');
      if(pay.state==='complete'||pay.state==='failed'){
        if(pay.state===networkStatus&&pay.receipt_ref===receiptRef)return {state:pay.state,replay:true};
        throw Error('terminal payout conflict');
      }
      if(!['in-flight','unknown'].includes(pay.state))throw Error('payout not sent to wallet');
      if(networkStatus==='pending'){
        db.prepare("UPDATE payouts SET state='unknown',updated_at=? WHERE request_id=?").run(utc(nowMillis(clock)),requestId);
        event(pay.order_id,'payout-unresolved',receiptRef,{requestId});
        return {state:'unknown',replay:false};
      }
      if(networkStatus==='failed'){
        db.prepare("UPDATE payouts SET state='failed',receipt_ref=?,updated_at=? WHERE request_id=?").run(receiptRef,utc(nowMillis(clock)),requestId);
        const owners=db.prepare('SELECT order_id FROM payout_allocations WHERE request_id=?').all(requestId);
        for(const a of owners){
          const other=db.prepare("SELECT 1 FROM payout_allocations a JOIN payouts p ON p.request_id=a.request_id WHERE a.order_id=? AND p.state IN ('prepared','in-flight','unknown') LIMIT 1").get(a.order_id);
          if(!other){const o=getOrder.get(a.order_id);db.prepare('UPDATE reward_orders SET status=? WHERE order_id=?').run(Date.parse(o.expires_at)<=nowMillis(clock)?'earned':'active',o.order_id);}
          event(a.order_id,'payout-failed',receiptRef,{requestId});
        }
        invalidateWalletSnapshot();
        return {state:'failed',replay:false};
      }
      const gross=integer(amountSentMsat,'network actual amountSentMsat');
      const requested=integer(pay.amount_msat,'pay amount');
      if(gross<requested)throw Error('network payment amount smaller than requested');
      const paidFee=gross-requested;
      if(paidFee>integer(pay.max_fee_msat,'payout fee limit'))throw Error('real fee exceeded reserved payout cap: emergency reconciliation');
      const owners=db.prepare('SELECT * FROM payout_allocations WHERE request_id=? ORDER BY order_id').all(requestId);
      const assignedFees=owners.reduce((sum,a)=>sum+integer(a.fee_msat,'assigned fee'),0n);
      if(paidFee>assignedFees)throw Error('fee exceeded aggregate reserved contributions');
      let paidTotal=0n,remainingFee=paidFee;
      for(const a of owners){
        const o=getOrder.get(a.order_id);
        const part=integer(a.amount_msat,'allocation amount');
        const feeForOrder=remainingFee<integer(a.fee_msat,'allocation fee')?remainingFee:integer(a.fee_msat,'allocation fee');
        remainingFee-=feeForOrder;paidTotal+=part;
        const paid=integer(o.paid_msat,'already paid')+part;
        const fees=integer(o.fee_spent_msat,'already spent fee')+feeForOrder;
        if(paid>integer(o.max_reward_msat,'max pay')||fees>integer(o.max_fee_msat,'max fee'))throw Error('financial ceiling exceeded');
        db.prepare('UPDATE reward_orders SET paid_msat=?,fee_spent_msat=?,status=? WHERE order_id=?')
          .run(paid.toString(),fees.toString(),Date.parse(o.expires_at)<=nowMillis(clock)?'earned':'active',o.order_id);
        event(o.order_id,'payout-share-final',receiptRef,{requestId,paidMsat:part.toString(),feeMsat:feeForOrder.toString()});
      }
      if(paidTotal!==requested||remainingFee!==0n)throw Error('payout allocation sum mismatch');
      db.prepare("UPDATE payouts SET state='complete',fee_paid_msat=?,receipt_ref=?,updated_at=? WHERE request_id=?")
        .run(paidFee.toString(),receiptRef,utc(nowMillis(clock)),requestId);
      invalidateWalletSnapshot();
      return {state:'complete',replay:false,paidMsat:requested.toString(),feeMsat:paidFee.toString()};
    });
  }
  function releaseUnused(orderId,{finalityRef}={}) {
    label(orderId,'orderId');label(finalityRef,'finalityRef');
    // Bring server-owned earnings through end of term before any residual is released.
    accrue(orderId);
    return transaction(()=>{
      const o=getOrder.get(orderId);if(!o)throw Error('unknown order');
      if(o.status==='closed')return {status:'closed',replay:true};
      if(o.status==='reserved')throw Error('cannot release pending purchase without independent void/refund finality');
      if(Date.parse(o.expires_at)>nowMillis(clock))throw Error('contract not expired');
      if(db.prepare("SELECT 1 FROM payout_allocations a JOIN payouts p ON p.request_id=a.request_id WHERE a.order_id=? AND p.state IN ('prepared','in-flight','unknown') LIMIT 1").get(orderId))throw Error('pending payout prevents release');
      const earned=integer(o.earned_msat,'earned'), paid=integer(o.paid_msat,'paid');
      if(earned!==paid)throw Error('earned but unpaid reward prevents close');
      const releaseReward=integer(o.max_reward_msat,'max')-paid;
      const releaseFee=integer(o.max_fee_msat,'fees')-integer(o.fee_spent_msat,'spent');
      db.prepare("UPDATE reward_orders SET status='closed',released_reward_msat=?,released_fee_msat=?,termination_receipt=? WHERE order_id=?")
        .run(releaseReward.toString(),releaseFee.toString(),finalityRef,orderId);
      event(orderId,'closed',finalityRef,{unusedRewardMsat:releaseReward.toString(),unusedFeesMsat:releaseFee.toString()});
      return {status:'closed',releasedRewardMsat:releaseReward.toString(),releasedFeeMsat:releaseFee.toString()};
    });
  }
  function voidUnactivated(orderId,{proofRef}={}) {
    label(orderId,'orderId');label(proofRef,'proofRef');
    // Proved external no-capture or fully reversed payment only.
    return transaction(()=>{
      const o=getOrder.get(orderId);if(!o)throw Error('unknown order');
      if(o.status==='void')return {status:'void',replay:true};
      if(o.status!=='reserved')throw Error('cannot void activated contract');
      db.prepare("UPDATE reward_orders SET status='void',released_reward_msat=max_reward_msat,released_fee_msat=max_fee_msat,termination_receipt=? WHERE order_id=?").run(proofRef,orderId);
      event(orderId,'void',proofRef);
      return {status:'void',replay:false};
    });
  }
  function accountDetails(principalId){
    label(principalId,'principalId');
    return transaction(()=>{
      materializePrincipal(principalId);
      const orders=db.prepare('SELECT * FROM reward_orders WHERE principal_id=? ORDER BY order_id').all(principalId);
    const earned=orders.reduce((sum,o)=>sum+integer(o.earned_msat,'earned'),0n);
    const paid=orders.reduce((sum,o)=>sum+integer(o.paid_msat,'paid'),0n);
    const inFlight=db.prepare("SELECT a.amount_msat FROM payout_allocations a JOIN payouts p ON p.request_id=a.request_id WHERE p.principal_id=? AND p.state IN ('prepared','in-flight','unknown')").all(principalId).reduce((sum,p)=>sum+integer(p.amount_msat,'pending'),0n);
    return {principalId,earnedMsat:earned.toString(),paidMsat:paid.toString(),lockedPayoutMsat:inFlight.toString(),
      currentlyClaimableMsat:(earned-paid-inFlight).toString(),contracts:orders.length,withdrawalMinimumMsat:accountWithdrawalMinimumMsat};
    });
  }
  function details(orderId){
    const o=getOrder.get(label(orderId,'orderId'));if(!o)return null;
    return {orderId:o.order_id,principalId:o.principal_id,planId:o.plan_id,status:o.status,
      termsRef:o.terms_ref,createdAt:o.reserved_at,activatedAt:o.activated_at,expiresAt:o.expires_at,
      maxRewardMsat:o.max_reward_msat,earnedMsat:o.earned_msat,paidMsat:o.paid_msat,
      feeCapMsat:o.max_fee_msat,feeSpentMsat:o.fee_spent_msat,
      releasedRewardMsat:o.released_reward_msat};
  }
  function payoutDetails(requestId){
    const p=getPayout.get(label(requestId,'requestId'));
    if(!p)return null;
    return {requestId:p.request_id,orderId:p.order_id,paymentHash:p.payment_hash,invoiceRef:p.invoice_ref,
      amountMsat:p.amount_msat,maxFeeMsat:p.max_fee_msat,state:p.state};
  }
  function eventHistory(orderId){return db.prepare('SELECT * FROM events WHERE order_id=? ORDER BY seq').all(orderId).map(row=>({...row,metadata:JSON.parse(row.metadata_json)}));}
  return {db,close(){db.close();},catalog:()=>[...catalog.values()],availableFor,observeWallet,
    reserve,activate,accrue,preparePayout,preparePooledPayout,markPayoutInFlight,reconcilePayout,
    releaseUnused,voidUnactivated,details,accountDetails,payoutDetails,eventHistory,book:currentBook};
}
