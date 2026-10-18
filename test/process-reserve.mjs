import { createLightningRewardReservationStore } from '../src/reservation-store.mjs';
import { defaultSettings } from './fixture.mjs';
const [dbPath, principal, orderId] = process.argv.slice(2);
let service;
try {
 service=createLightningRewardReservationStore(defaultSettings(dbPath,()=>Date.parse('2026-10-17T22:00:00Z')));
 const result=service.reserve({orderId,principalId:principal,planId:'free-8h'});
 process.stdout.write(JSON.stringify(result)+'\n');
} catch(error) {
 process.stdout.write(JSON.stringify({error:error.message})+'\n');
 process.exitCode=1;
} finally { service?.close(); }
