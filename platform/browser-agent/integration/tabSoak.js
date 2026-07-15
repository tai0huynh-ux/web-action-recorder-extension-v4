import { runTabSoak } from './containerGate.js';

const result = await runTabSoak({ iterations: 100 });
console.log(JSON.stringify(result, null, 2));
