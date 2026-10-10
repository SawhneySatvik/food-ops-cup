// Gate helper (T-080 gate 7): core-domain's own number grammar (the validator core-api runs) over a JSON array of
// texts on stdin; prints one GrammarResult per text. intel never re-implements the grammar.
//   echo '["text"]' | node services/intel/tests/tools/grammar_check.mts
import { checkGrammar } from "../../../../packages/core-domain/envelope/grammar.ts";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const texts = JSON.parse(input) as string[];
console.log(JSON.stringify(texts.map((t) => checkGrammar(t))));
