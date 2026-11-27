const entities = {customer:'customer',weekly_expenses:'weekly expenses',product:'product'};
export const LAB_SUGGESTIONS = Object.freeze([
  {id:'customer',label:'Look up a customer',kind:'GET',prompt:'Look up customer C-1001 and tell me their status and total spending.'},
  {id:'expenses',label:'Review weekly expenses',kind:'GET',prompt:'What are the weekly expenses? Show the total and category breakdown.'},
  {id:'product',label:'Check product stock',kind:'GET',prompt:'Look up product P-2001 and tell me its stock and price.'},
  {id:'expense-create',label:'Create a test expense',kind:'POST',prompt:'Create an expense named Team Lunch with an amount of 35.50 and date 2027-01-15.'},
  {id:'reservation-missing',label:'Make a reservation',kind:'POST · ask for details',prompt:'I would like to make a reservation.'},
  {id:'reservation-complete',label:'Reserve with all details',kind:'POST',prompt:'Create a reservation for Ana Torres on 2027-01-15.'}
]);
const displayDate = date => new Intl.DateTimeFormat('en-US',{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'}).format(new Date(date+'T00:00:00Z'));
export const EFFECT_MESSAGES = Object.freeze({celebrate:'The page is celebrating.',cry:'Rain is falling on the test page.',sing:'Musical notes are playing on the test page.'});

export function describeLabAction(action) {
  const p = action.params;
  if (action.id === 'toy.create_reservation') return {title:'Create this test reservation?',description:`Create a fictional reservation for “${p.name}” on ${displayDate(p.date)}.`,confirmLabel:'Create reservation'};
  if (action.id === 'toy.create_record') {
    const type = p.type;
    let description = `Create a fictional ${type} named “${p.name}”`;
    if (p.amount !== undefined) description += ` with an amount of ${p.amount.toFixed(2)}`;
    if (p.date) description += `, dated ${displayDate(p.date)}`;
    return {title:`Create this test ${type}?`,description:description+'.',confirmLabel:`Create ${type}`};
  }
  if (action.id === 'toy.read_record') return {title:'Look up a test record',description:`Look up ${entities[p.entity]} in the fictional test database.`};
  if (action.id === 'ui.write_text') return {title:'Write in the text box',description:`Write “${p.text}” in the playground text box.`};
  return {
    'ui.celebrate':{title:'Celebrate',description:'Show a celebration on the test page.'},
    'ui.cry':{title:'Cry',description:'Show rain on the test page.'},
    'ui.sing':{title:'Sing',description:'Show musical notes on the test page.'}
  }[action.id] ?? {title:'Proposed action',description:'Perform the proposed test action.'};
}

export function describeLabResult(action, result) {
  if (result.status === 'cancelled') return 'Action cancelled.';
  if (result.status === 'unknown') return 'The action’s outcome could not be confirmed.';
  if (result.status !== 'success') return 'The action could not be completed.';
  if (action.id === 'toy.create_reservation') return `Created the test reservation for “${action.params.name}” on ${displayDate(action.params.date)}${result.data?.reservationId ? ' (ID '+result.data.reservationId+')' : ''}.`;
  if (action.id === 'ui.write_text') return `Wrote “${result.data?.text ?? action.params.text}” in the playground text box.`;
  if (action.id === 'toy.read_record') return 'Retrieved the '+entities[action.params.entity]+' record from the test database.';
  if (action.id === 'toy.create_record') return `Created the test ${action.params.type} “${action.params.name}”${result.data?.recordId ? ' (ID '+result.data.recordId+')' : ''}.`;
  return EFFECT_MESSAGES[action.id.slice(3)] ?? 'Action completed.';
}
