export { MAX_ACTION_BYTES, normalizeActions as normalizeClientActions } from '../templates/worker/src/action-contract.mjs';
export const GALLINAS_ACTIONS = [{ id:'demo.open', description:'Abrir una de las tres opciones visuales del sitio Gallinas y Valientes cuando el visitante lo solicite.', parameters:{ option:{type:'string',enum:['01','02','03']} } }];
