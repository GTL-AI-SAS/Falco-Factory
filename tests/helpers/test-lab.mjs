import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { generate } from '../../lib/generate.mjs';
import { normalizeConfig } from '../../lib/args.mjs';
import { readProject } from '../../lib/projects.mjs';
import { createTestLab } from '../../lib/test-lab.mjs';
import { createPreviewAdapter } from '../../lib/preview-deploy.mjs';

export async function labFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'falco-lab-test-'));
  t?.after(() => fs.rm(root,{recursive:true,force:true}));
  const accountId = 'a'.repeat(32), authProfile = options.authProfile ?? 'lab-account';
  const config = normalizeConfig({name:'falco-lab-fixture',business:'Original Business',provider:options.provider ?? 'gemini',
    output:'.generated/falco-lab-fixture','account-id':accountId,'auth-profile':authProfile},root);
  config.faq = 'Production knowledge';config.instructions='Production instructions';
  await generate(config);
  const project = await readProject(root,config.name);
  const production = {fingerprint:'unchanged-production',detail:{deployment:randomUUID(),versions:[{id:randomUUID(),percentage:100}]}};
  const commands = [], cloud = new Map(), messages = [];
  const flags = {failCreate:false,failDelete:false,malformed:false,missingUrl:false,unexpectedSecret:false,drift:false,...options.flags};
  let lastSecretFile, lastToken, latest = 0;
  const wrangler = async (args,opts) => {
    if (args[0] !== 'preview' || args.some(arg => ['deploy','versions'].includes(arg))) throw Error('Forbidden production command');
    commands.push({args:[...args],opts});
    const name=args[args.indexOf('--name')+1], worker=args[args.indexOf('--worker-name')+1];
    if (!opts.accountId || opts.authProfile !== authProfile) throw Error('Lost authentication context');
    if (args[1] === 'delete') {
      if(flags.failDelete) return {code:1,stdout:'',stderr:'failure'};
      if (!flags.lingerDelete) cloud.delete(name);return {code:0,stdout:'Preview deleted successfully.',stderr:''};
    }
    if (args[1] === 'secret' && args[2] === 'bulk') {
      lastSecretFile=args[3];
      const value=JSON.parse(await fs.readFile(lastSecretFile,'utf8'));
      lastToken=value.FALCO_TEST_TOKEN;
      cloud.get(name).secrets=value;latest++;
      return {code:0,stdout:'Secrets uploaded',stderr:''};
    }
    if (args[1] === 'secret' && args[2] === 'list') return {code:0,stdout:JSON.stringify([
      ...Object.keys(cloud.get(name).secrets).map(name=>({name,type:'secret_text'})),
      ...(flags.unexpectedSecret ? [{name:'PRODUCTION_SECRET',type:'secret_text'}] : [])]),stderr:''};
    const preview={id:randomUUID(),name,slug:name,urls:[`https://${name}-${worker}.demo.workers.dev`]};
    cloud.set(name,{preview,secrets:{}});
    if(flags.failCreate) return {code:1,stdout:'',stderr:'provider-key-must-never-be-exposed'};
    return {code:0,stdout:flags.malformed ? 'not json' : JSON.stringify({preview:{...preview,...(flags.missingUrl ? {urls:[]} : {})},deployment:{id:randomUUID()}}),stderr:''};
  };
  const get = async (session,endpoint) => {
    if(session.accountId !== accountId) throw Error('Wrong account');
    if (endpoint === '/workers/scripts/' + project.name + '/subdomain') return {found:true,result:{enabled:true,previews_enabled:!flags.previewUrlsDisabled}};
    const parts=endpoint.split('/'), name=decodeURIComponent(parts[5]);
    const item=cloud.get(name);
    if(!item) return {found:false};
    if(parts[6] === 'deployments') return {found:true,result:{id:'latest-' + latest}};
    return {found:true,result:item.preview};
  };
  const sessionReader = async () => ({accountId,authProfile,token:'cloudflare-management-secret'});
  const remoteReader = async () => ({...production,fingerprint:flags.drift ? 'changed' : production.fingerprint});
  const fetcher = async (url,opts) => {
    if(opts.headers.Authorization !== 'Bearer ' + lastToken) throw Error('Missing Preview token');
    if(new URL(url).pathname === '/health') return Response.json({status:'ok',service:'falco',business:'Falco Test Lab'});
    const payload=JSON.parse(opts.body);messages.push(payload);
    if(options.chat) return options.chat(payload,opts);
    return Response.json({reply:'Falco Test Lab ready.'},{headers:{'X-Falco-Request-Id':randomUUID()}});
  };
  const preview = createPreviewAdapter({wrangler,get,env:{}});
  const dependencies = {root,sessionReader,remoteReader,preview,fetcher,env:{}};
  const lab = createTestLab(dependencies);
  return {root,project,accountId,authProfile,production,commands,cloud,messages,flags,lab,dependencies,wrangler,get,fetcher,sessionReader,remoteReader,
    input:{folder:project.folder,revision:project.revision,provider:'gemini',model:project.model,apiKey:'dedicated-provider-key'},
    get secretFile(){return lastSecretFile;},get token(){return lastToken;}};
}
