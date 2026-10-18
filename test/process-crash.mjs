import {DatabaseSync} from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
const observed=db.prepare('SELECT seq FROM wallet_observations ORDER BY seq DESC LIMIT 1').get();
db.prepare("INSERT INTO reward_orders(order_id,principal_id,plan_id,terms_ref,plan_json,max_reward_msat,max_fee_msat,status,reserved_at,admission_observation) VALUES('half-written','alice','free-8h','urn:partial','{}','8800','2000','reserved','2026-10-17T22:00:00Z',?)").run(observed.seq);
process.stdout.write('in-uncommitted-transaction\n');
// Parent sends SIGKILL before commit. No graceful close or rollback.
setInterval(()=>{},100000);
