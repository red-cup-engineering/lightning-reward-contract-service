import {registerHooks} from 'node:module';
const fake=new URL('./upstream-regtest-stub.mjs',import.meta.url).href;
registerHooks({
 resolve(specifier,context,nextResolve){
  if(specifier==='@red-cup-engineering/capability-pricing-service/fixed-term-reward-ceiling'||
     specifier==='@red-cup-engineering/capability-pricing-service/prefunded-lightning-inventory')
   return {url:fake,shortCircuit:true};
  return nextResolve(specifier,context);
 }
});
