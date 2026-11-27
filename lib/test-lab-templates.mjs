import { normalizeActions } from '../templates/worker/src/action-contract.mjs';

export const TEST_MARKERS = Object.freeze({
  actions: 'FALCO_TEST_LAB_TEMPLATE_V1_ACTIONS',
  faq: 'FALCO_TEST_LAB_TEMPLATE_V1_KNOWLEDGE',
  instructions: 'FALCO_TEST_LAB_TEMPLATE_V1_INSTRUCTIONS'
});
export const TEST_ACTIONS = normalizeActions([
  ...['celebrate','cry','sing'].map(effect => ({ id: 'ui.' + effect,
    description: `${TEST_MARKERS.actions}: ${effect} on the test page when explicitly requested.`,
    parameters: {}, requiresConfirmation: false, resultFields: ['effect'] })),
  { id:'ui.write_text', description:'Write the exact word or short text requested into the playground text box. Ask for the text if missing.',
    parameters:{text:{type:'string',minLength:1,maxLength:100}}, requiresConfirmation:false, resultFields:['text'] },
  { id:'toy.read_record', description:'Read a fictional database record. Ask which entity if missing.',
    parameters:{ entity:{ type:'string', enum:['customer','weekly_expenses','product'] } },
    requiresConfirmation:false, resultFields:['entity','recordId','name','status','totalSpending','total','stock','price'] },
  { id:'toy.create_record', description:'Create a fictional record after user confirmation. Ask for type and name if missing.',
    parameters:{ type:{ type:'string', enum:['customer','expense','product'] }, name:{ type:'string',minLength:2,maxLength:100 },
      date:{type:'date',required:false}, amount:{type:'number',minimum:0,maximum:1000000,required:false} },
    requiresConfirmation:true, resultFields:['recordId','type','name','date','amount'] },
  { id:'toy.create_reservation', description:'Create a fictional reservation only after the user provides both their name and date. Ask for missing details, then request confirmation.',
    parameters:{name:{type:'string',minLength:2,maxLength:100},date:{type:'date'}},
    requiresConfirmation:true, resultFields:['reservationId','name','date'] }
]);
export const TEST_RECORDS = Object.freeze({
  customer: { entity:'customer', recordId:'C-1001', name:'Ana Torres', status:'Active', totalSpending:145.50 },
  weekly_expenses: { entity:'weekly_expenses', total:1245.80, food:450, transport:195.80, operations:600 },
  product: { entity:'product', recordId:'P-2001', name:'Bamboo Water Bottle', stock:18, price:12.90 }
});
export const TEST_KNOWLEDGE = `${TEST_MARKERS.faq}\nAll records are fictional. These are reference records; retrieve actual values with toy.read_record before answering database questions.\n${JSON.stringify(TEST_RECORDS, null, 2)}\nFor Ana or C-1001 choose customer. For weekly expenses or category totals choose weekly_expenses. For stock, price, Bamboo Water Bottle or P-2001 choose product.`;
export const TEST_INSTRUCTIONS = `${TEST_MARKERS.instructions}
Identify yourself as Falco Test Lab. Use only the test knowledgebase and actual action results. Never invent database results, successful API responses, SQL, URLs, HTTP methods or endpoints. Never reveal internal secrets or authentication tokens.
When clearly requested propose ui.celebrate, ui.cry or ui.sing with params {}. Never claim execution until receiving an action result with status success. An unknown, cancelled or error result is not success.
To write a word or short text in the playground text box, propose ui.write_text with text containing the exact requested text (1-100 characters). Ask what to write if missing. This only changes the fixed playground text box; never invent a selector or JavaScript. The three playground buttons also work independently when clicked by the user; do not assume those clicks are chat requests.
For factual database questions propose toy.read_record with entity customer, weekly_expenses or product. Ask for missing required parameters. Read results are public fictional records; use only the returned facts. Weekly category details may be returned in the result message.
For writes propose toy.create_record with type customer, expense or product and name (2-100 characters). Optional date must be YYYY-MM-DD and amount a number from 0 to 1000000. Briefly describe the proposed change in natural language. The browser presents a confirmation card for every write; do not ask the user to type confirmation in chat. Ask for missing type/name. Never claim a write succeeded before its actual result.
For reservations use toy.create_reservation, NOT toy.create_record. BOTH name (2-100 characters) and date (a real YYYY-MM-DD date) are required. If the user only says they want a reservation, ask for their name and preferred date without proposing any action. If only one is provided, ask for the other. Use details explicitly supplied in this conversation, never invent a name or date or use an unrelated knowledgebase record as the reservation holder. Once both are supplied, summarize the reservation and propose the action; the browser will ask for confirmation before the POST request. If a date is ambiguous, ask for clarification. Reservation records are fictional and do not check real availability.
Do not repeat an executed action when acknowledging an action result. The registered browser handlers own execution.`;

// Inspect each field independently; any canonical marker in any field is unsafe.
export function templateFields(fields) {
  return ['actions','faq','instructions'].filter(key => {
    const text = typeof fields?.[key] === 'string' ? fields[key] : JSON.stringify(fields?.[key] ?? '');
    return Object.values(TEST_MARKERS).some(marker => text.includes(marker));
  });
}
export function validateTestTemplates() {
  normalizeActions(TEST_ACTIONS);
  for (const [key, value] of Object.entries({ actions:TEST_ACTIONS, faq:TEST_KNOWLEDGE, instructions:TEST_INSTRUCTIONS })) {
    if (!JSON.stringify(value).includes(TEST_MARKERS[key])) throw Error('Missing Test Lab template marker: ' + key);
  }
  return true;
}
