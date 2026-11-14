// Schema-defined settings registry (DCE-028). Pure and browser-safe: the
// server stores and authorizes versions, the browser uses the same rules to
// show validation errors before a simulation is requested.
export const SETTING_SCOPES=Object.freeze(['platform','product','tenant','document']);
export const PRODUCTS=Object.freeze(['civic','charter']);
export const TENANT_ROLES=Object.freeze(['owner','admin','editor','participant','viewer']);
export const CAPABILITIES=Object.freeze(['read','discuss','vote','propose','edit-documents','create-documents','manage-members','manage-settings']);
export const CONSUMPTION_SOURCES=Object.freeze(['weekly-allowance','grants','credits']);
export const MAX_CHANGES_PER_VERSION=64;

export class SettingsError extends Error {
  constructor(code,key=null,message=code){super(message);this.name='SettingsError';this.code=code;this.key=key;}
}
const fail=(code,key,message)=>{throw new SettingsError(code,key,message);};

/** Rules no administrator can change. Attempts fail closed with the listed code. */
export const HARD_INVARIANTS=Object.freeze([
  {id:'public-anchoring-required',key:'invariants.publicAnchoringRequired',code:'INVARIANT_PUBLIC_ANCHORING_REQUIRED',value:true,
    description:'Public documents are always anchored; anchoring cannot be disabled for them.'},
  {id:'public-input-immutable',key:'invariants.publicInputImmutable',code:'INVARIANT_PUBLIC_INPUT_IMMUTABLE',value:true,
    description:'A public-input source edition is frozen and never adopts changes automatically.'},
  {id:'signed-content-immutable',key:'invariants.signedContentImmutable',code:'INVARIANT_SIGNED_CONTENT_IMMUTABLE',value:true,
    description:'Signed and adopted editions are append-only; new wording requires a new edition.'},
  {id:'frozen-ballots-immutable',key:'invariants.frozenBallotsImmutable',code:'INVARIANT_FROZEN_BALLOTS_IMMUTABLE',value:true,
    description:'An open decision keeps the electorate, policy and wording frozen when it opened.'},
  {id:'crypto-invariants',key:'invariants.cryptoProfile',code:'INVARIANT_CRYPTO_PROFILE',value:'dce-c14n-v0-dev/sha-256/ed25519',
    description:'Canonicalization, digest and signature algorithms cannot be weakened by configuration.'},
].map(Object.freeze));

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value))&&Object.getOwnPropertySymbols(value).length===0&&
  Object.getOwnPropertyNames(value).every(name=>{const d=Object.getOwnPropertyDescriptor(value,name);return d.enumerable&&Object.hasOwn(d,'value');});
const denseArray=value=>Array.isArray(value)&&Object.getOwnPropertySymbols(value).length===0&&
  Object.getOwnPropertyNames(value).length===value.length+1&&value.every((_,i)=>{const d=Object.getOwnPropertyDescriptor(value,String(i));return d&&Object.hasOwn(d,'value');});
const deepFreeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}return value;};
const DECIMAL=/^(0|[1-9][0-9]{0,17})(?:\.([0-9]{1,18}))?$/;
const scaled=(value,scale)=>{const [,whole,fraction='']=DECIMAL.exec(value);return BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0')||'0');};
export function validTimeZone(value){
  if(typeof value!=='string'||value.length<1||value.length>64||!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value))return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:value});return true;}catch{return false;}
}

function normalizeBySpec(spec,value,key,path=key){
  const invalid=message=>fail('INVALID_SETTING_VALUE',key,path+': '+message);
  switch(spec.type){
    case 'boolean':if(typeof value!=='boolean')invalid('expected true or false');return value;
    case 'integer':case 'duration-hours':
      if(!Number.isSafeInteger(value)||Object.is(value,-0))invalid('expected a whole number');
      if(value<spec.min||value>spec.max)invalid('expected '+spec.min+' to '+spec.max);return value;
    case 'decimal':{
      if(typeof value!=='string'||!DECIMAL.test(value))invalid('expected a decimal string such as "0.5"');
      const fraction=DECIMAL.exec(value)[2]??'';if(fraction.length>spec.scale)invalid('at most '+spec.scale+' decimal places');
      const n=scaled(value,spec.scale);
      if(n<scaled(spec.min,spec.scale)||n>scaled(spec.max,spec.scale)||(spec.minExclusive&&n===scaled(spec.min,spec.scale)))
        invalid('expected '+(spec.minExclusive?'more than ':'')+spec.min+' to '+spec.max);
      const trimmed=value.includes('.')?value.replace(/0+$/,'').replace(/\.$/,''):value;return trimmed;
    }
    case 'enum':if(!spec.values.includes(value))invalid('expected one of '+spec.values.join(', '));return value;
    case 'string':
      if(typeof value!=='string'||value.length>spec.maxLength||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))invalid('expected trimmed text up to '+spec.maxLength+' characters');
      if(spec.pattern&&!new RegExp(spec.pattern).test(value))invalid('unsupported format');
      if(spec.format==='time-zone'&&!validTimeZone(value))invalid('expected an IANA time zone such as Europe/Paris');
      return value;
    case 'money':{
      if(!plain(value)||Object.keys(value).sort().join()!=='amountMinor,currency')invalid('expected {currency, amountMinor}');
      if(typeof value.currency!=='string'||!/^[A-Z]{3}$/.test(value.currency))invalid('expected an ISO 4217 currency code');
      if(!Number.isSafeInteger(value.amountMinor)||value.amountMinor<0||value.amountMinor>spec.maxMinor)invalid('expected whole minor units from 0 to '+spec.maxMinor);
      return {currency:value.currency,amountMinor:value.amountMinor};
    }
    case 'list':{
      if(!denseArray(value))invalid('expected a list');
      if(value.length<(spec.minItems??0)||value.length>spec.maxItems)invalid('expected '+(spec.minItems??0)+' to '+spec.maxItems+' items');
      const items=value.map((item,i)=>normalizeBySpec(spec.items,item,key,path+'['+i+']'));
      if(spec.unique){const seen=new Set(items.map(item=>spec.uniqueBy?item[spec.uniqueBy]:JSON.stringify(item)));if(seen.size!==items.length)invalid('items must be unique');}
      return items;
    }
    case 'record':{
      if(!plain(value))invalid('expected an object');
      for(const name of Object.keys(value))if(!Object.hasOwn(spec.fields,name))invalid('unknown field '+name);
      const result={};
      for(const [name,field] of Object.entries(spec.fields)){
        if(!Object.hasOwn(value,name)){if(!field.optional)invalid('missing field '+name);continue;}
        result[name]=normalizeBySpec(field,value[name],key,path+'.'+name);
      }
      const problem=spec.check?.(result);if(problem)invalid(problem);
      return result;
    }
    default:throw Error('Unknown setting type');
  }
}

const ALL=SETTING_SCOPES,ABOVE_DOCUMENT=['platform','product','tenant'],PLATFORM=['platform','product'];
const roleList={type:'list',items:{type:'enum',values:CAPABILITIES},minItems:1,maxItems:CAPABILITIES.length,unique:true};
const catalogItem={type:'record',fields:{
  id:{type:'string',maxLength:40,pattern:'^[a-z0-9][a-z0-9-]{0,39}$'},
  kind:{type:'enum',values:['subscription','credit-pack','single-document']},
  label:{type:'string',maxLength:80,pattern:'^\\S'},
  price:{type:'money',maxMinor:100000000},
  quantity:{type:'integer',min:1,max:100000,optional:true},
  unlimited:{type:'boolean',optional:true},
  interval:{type:'enum',values:['month','year'],optional:true},
  subject:{type:'enum',values:['account','tenant','either'],optional:true},
},check:item=>{
  if(item.price.amountMinor<1)return 'a catalog price must be positive';
  if(item.kind==='subscription')return item.interval?(item.unlimited===true)===(item.quantity===undefined)?null:'a subscription has either a per-period quantity or unlimited: true':'a subscription needs an interval';
  if(item.interval!==undefined||item.unlimited!==undefined)return 'only subscriptions have an interval or unlimited quantity';
  if(item.kind==='single-document'&&item.quantity!==undefined&&item.quantity!==1)return 'a single-document purchase grants exactly one document';
  return item.kind==='credit-pack'&&item.quantity===undefined?'a credit pack needs a quantity':null;
}};
const definitions=[
  {key:'documents.modesAllowed',group:'Governance',label:'Document modes allowed',type:'list',items:{type:'enum',values:['collaboration','public-input']},minItems:1,maxItems:2,unique:true,
    default:['collaboration','public-input'],scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'votes.quorumFraction',group:'Default vote rules',label:'Quorum (fraction of frozen electorate)',type:'decimal',min:'0',max:'1',minExclusive:true,scale:4,
    default:'0.5',scopes:ALL,mutability:'locked-while-vote-active',consumer:'consumer-integration'},
  {key:'votes.approvalFraction',group:'Default vote rules',label:'Approval threshold (fraction of yes/no votes)',type:'decimal',min:'0',max:'1',minExclusive:true,scale:4,
    default:'0.5',scopes:ALL,mutability:'locked-while-vote-active',consumer:'consumer-integration'},
  {key:'votes.approvalComparison',group:'Default vote rules',label:'Approval comparison',type:'enum',values:['gt','gte'],
    default:'gt',scopes:ALL,mutability:'locked-while-vote-active',consumer:'consumer-integration'},
  {key:'votes.deliberationHours',group:'Default vote rules',label:'Minimum deliberation',type:'duration-hours',min:0,max:720,
    default:0,scopes:ALL,mutability:'locked-while-vote-active',consumer:'consumer-integration'},
  {key:'votes.challengeHours',group:'Default vote rules',label:'Challenge window',type:'duration-hours',min:0,max:720,
    default:48,scopes:ALL,mutability:'locked-while-vote-active',consumer:'consumer-integration'},
  {key:'trust.tiersAllowed',group:'Governance',label:'Trust tiers allowed to vote',type:'list',items:{type:'enum',values:['primary','multifactor','hardware-bound']},minItems:1,maxItems:3,unique:true,
    default:['primary','multifactor','hardware-bound'],scopes:ALL,mutability:'locked-while-vote-active',consumer:'consumer-integration'},
  {key:'points.rankingProfile',group:'Governance',label:'Point-ranking profile',type:'enum',values:['wilson-lower-bound','net-votes','chronological'],
    default:'wilson-lower-bound',scopes:ALL,consumer:'consumer-integration'},
  {key:'abuse.pointsPerHour',group:'Anti-abuse budgets',label:'Points per account per hour',type:'integer',min:1,max:1000,default:30,scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'abuse.proposalsPerDay',group:'Anti-abuse budgets',label:'Proposals per account per day',type:'integer',min:1,max:1000,default:20,scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'abuse.requestsPerMinute',group:'Anti-abuse budgets',label:'Requests per peer per minute',type:'integer',min:10,max:10000,default:120,scopes:PLATFORM,consumer:'consumer-integration'},
  {key:'organization.privacyDefault',group:'Organization',label:'Default visibility for new organization documents',type:'enum',values:['private','public'],
    default:'private',scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'anchoring.enabled',group:'Anchoring',label:'Anchor organization (non-public) documents',type:'boolean',default:false,scopes:ALL,
    invariant:'public-anchoring-required',consumer:'settings'},
  {key:'anchoring.cadenceMinutes',group:'Anchoring',label:'Anchoring cadence (minutes)',type:'integer',min:5,max:10080,default:60,scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'export.fontsAllowed',group:'Signing and export',label:'Fonts allowed in exports',type:'list',items:{type:'string',maxLength:60,pattern:'^[A-Za-z0-9][A-Za-z0-9 -]*$'},minItems:1,maxItems:16,unique:true,
    default:['Source Serif 4','Inter'],scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'export.watermark',group:'Signing and export',label:'Watermark',type:'enum',values:['none','unadopted-drafts','always'],default:'unadopted-drafts',scopes:ALL,consumer:'consumer-integration'},
  {key:'billing.catalog',group:'Prices and quotas',label:'Price catalog',type:'list',items:catalogItem,maxItems:32,unique:true,uniqueBy:'id',
    default:[],scopes:PLATFORM,consumer:'billing'},
  {key:'quotas.weeklyFreeDocuments',group:'Prices and quotas',label:'Free documents per account per week',type:'integer',min:0,max:1000,default:1,scopes:PLATFORM,consumer:'entitlements'},
  {key:'quotas.weekTimeZone',group:'Prices and quotas',label:'Time zone for weekly and monthly boundaries',type:'string',maxLength:64,format:'time-zone',default:'UTC',scopes:PLATFORM,consumer:'entitlements'},
  {key:'quotas.storageBytes',group:'Prices and quotas',label:'Stored bytes per workspace',type:'integer',min:1000000,max:1000000000,default:30000000,scopes:PLATFORM,consumer:'consumer-integration'},
  {key:'entitlements.consumptionOrder',group:'Prices and quotas',label:'Order in which document creation consumes entitlements',type:'list',items:{type:'enum',values:CONSUMPTION_SOURCES},
    minItems:3,maxItems:3,unique:true,default:[...CONSUMPTION_SOURCES],scopes:PLATFORM,consumer:'entitlements'},
  {key:'officials.grantPolicy',group:'Elected officials',label:'Verified official grant policy',type:'record',fields:{
      mode:{type:'enum',values:['unlimited','monthly-cap']},monthlyCap:{type:'integer',min:1,max:100000,optional:true}},
    check:v=>v.mode==='monthly-cap'?(v.monthlyCap===undefined?'a monthly cap is required':null):(v.monthlyCap!==undefined?'unlimited grants have no cap':null),
    default:{mode:'unlimited'},scopes:PLATFORM,consumer:'entitlements'},
  {key:'officials.heavyUseMonthlyThreshold',group:'Elected officials',label:'Monthly documents before a paid offer is shown',type:'integer',min:1,max:100000,default:200,scopes:PLATFORM,consumer:'entitlements'},
  {key:'roles.capabilities',group:'Roles',label:'Role capabilities',type:'record',fields:Object.fromEntries(TENANT_ROLES.map(role=>[role,roleList])),
    check:v=>!v.owner.includes('manage-settings')?'owners must keep manage-settings':TENANT_ROLES.some(role=>!v[role].includes('read'))?'every role keeps read access':null,
    default:{owner:[...CAPABILITIES],admin:[...CAPABILITIES],editor:['read','discuss','vote','propose','edit-documents','create-documents'],participant:['read','discuss','vote','propose'],viewer:['read']},
    scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'notifications.defaults',group:'Notifications',label:'Notification defaults',type:'record',fields:{
      proposals:{type:'boolean'},decisions:{type:'boolean'},discussion:{type:'boolean'},digest:{type:'enum',values:['none','daily','weekly']}},
    default:{proposals:true,decisions:true,discussion:false,digest:'weekly'},scopes:ALL,consumer:'consumer-integration'},
  {key:'retention.auditDays',group:'Retention',label:'Audit retention (days)',type:'integer',min:2555,max:36500,default:2555,scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  {key:'retention.draftCacheDays',group:'Retention',label:'Local draft cache retention (days)',type:'integer',min:1,max:365,default:30,scopes:ABOVE_DOCUMENT,consumer:'consumer-integration'},
  ...HARD_INVARIANTS.map(rule=>({key:rule.key,group:'Invariants',label:rule.description,type:typeof rule.value==='boolean'?'boolean':'string',maxLength:64,
    default:rule.value,scopes:[],mutability:'invariant',invariant:rule.id,consumer:'invariant'})),
];
export const SETTINGS_REGISTRY=deepFreeze(definitions.map(d=>{
  const definition={mutability:'mutable',invariant:null,...d};
  definition.default=deepFreeze(normalizeBySpec(definition,structuredClone(definition.default),definition.key));
  return definition;
}));
const byKey=new Map(SETTINGS_REGISTRY.map(d=>[d.key,d]));
export const settingDefinition=key=>byKey.get(key)??null;

/** Validates one value against its definition and returns a frozen normalized copy. */
export function normalizeSettingValue(key,value){
  const definition=byKey.get(key);
  if(!definition)fail('UNKNOWN_SETTING',key,'Unknown setting '+String(key).slice(0,80));
  return deepFreeze(normalizeBySpec(definition,value,key));
}

/**
 * Checks a proposed change set for one scope. `changes` maps keys to a new
 * value, or to null to remove the override and inherit again. Context:
 * visibility of the document (document scope) and whether a vote is active.
 */
export function validateSettingsChange({scope,changes,context={}}){
  if(!SETTING_SCOPES.includes(scope))fail('INVALID_SETTINGS_SCOPE');
  if(!plain(changes))fail('INVALID_SETTINGS_CHANGE',null,'Changes must be an object of setting keys');
  const keys=Object.keys(changes);
  if(keys.length<1||keys.length>MAX_CHANGES_PER_VERSION)fail('INVALID_SETTINGS_CHANGE',null,'Change 1 to '+MAX_CHANGES_PER_VERSION+' settings at once');
  const errors=[],normalized={};
  for(const key of keys.sort()){
    try{
      const definition=byKey.get(key);
      if(!definition)fail('UNKNOWN_SETTING',key,'Unknown setting');
      if(definition.mutability==='invariant')fail(HARD_INVARIANTS.find(rule=>rule.key===key).code,key,definition.label);
      if(!definition.scopes.includes(scope))fail('SETTING_SCOPE_NOT_ALLOWED',key,definition.label+' cannot be set at '+scope+' scope');
      if(scope==='document'&&context.activeVote&&definition.mutability==='locked-while-vote-active')
        fail('SETTING_LOCKED_ACTIVE_VOTE',key,definition.label+' is locked while a vote is open on this document');
      const value=changes[key]===null?null:normalizeSettingValue(key,changes[key]);
      if(definition.invariant==='public-anchoring-required'&&value===false&&scope==='document'&&context.visibility==='public')
        fail('INVARIANT_PUBLIC_ANCHORING_REQUIRED',key,'Public documents are always anchored');
      normalized[key]=value;
    }catch(error){
      if(!(error instanceof SettingsError))throw error;
      errors.push({key:error.key??key,code:error.code,message:error.message});
    }
  }
  return {valid:errors.length===0,errors,normalized:deepFreeze(normalized)};
}

export function applySettingsChanges(overrides,normalized){
  const next={...overrides};
  for(const [key,value] of Object.entries(normalized))if(value===null)delete next[key];else next[key]=value;
  return deepFreeze(Object.fromEntries(Object.keys(next).sort().map(key=>[key,next[key]])));
}
/** The delta that turns `from` into `to`, as a change set. */
export function settingsDelta(from,to){
  const delta={};
  for(const key of new Set([...Object.keys(from),...Object.keys(to)]))
    if(JSON.stringify(from[key]??null)!==JSON.stringify(to[key]??null))delta[key]=Object.hasOwn(to,key)?to[key]:null;
  return delta;
}

/**
 * Effective value of every setting, resolved platform → product → tenant →
 * document. Each entry names its source. Stored overrides that no longer
 * validate (for example after a registry change) are ignored and reported.
 */
export function resolveEffectiveSettings(layers={},{product='civic',visibility='public'}={}){
  if(!PRODUCTS.includes(product))fail('INVALID_PRODUCT');
  const effective={},ignored=[];
  for(const definition of SETTINGS_REGISTRY){
    let entry={value:definition.default,source:definition.mutability==='invariant'?'invariant':'default',locked:definition.mutability==='invariant'};
    if(definition.mutability!=='invariant')for(const scope of SETTING_SCOPES){
      const layer=layers[scope];
      if(!layer||!Object.hasOwn(layer,definition.key))continue;
      if(!definition.scopes.includes(scope)){ignored.push({scope,key:definition.key});continue;}
      try{entry={value:normalizeSettingValue(definition.key,layer[definition.key]),source:scope==='product'?'product:'+product:scope,locked:false};}
      catch{ignored.push({scope,key:definition.key});}
    }
    if(definition.invariant==='public-anchoring-required'&&definition.mutability!=='invariant'&&visibility==='public')
      entry={value:true,source:'invariant',locked:true};
    effective[definition.key]=Object.freeze(entry);
  }
  return Object.freeze({values:Object.freeze(effective),ignored:Object.freeze(ignored)});
}
export function diffEffectiveSettings(before,after){
  const diff=[];
  for(const definition of SETTINGS_REGISTRY){
    const a=before[definition.key],b=after[definition.key];
    if(JSON.stringify(a.value)!==JSON.stringify(b.value)||a.source!==b.source)
      diff.push(Object.freeze({key:definition.key,label:definition.label,before:a,after:b,valueChanged:JSON.stringify(a.value)!==JSON.stringify(b.value)}));
  }
  return Object.freeze(diff);
}

const zoneParts=(ms,timeZone)=>{
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',weekday:'short'})
    .formatToParts(new Date(ms)).map(p=>[p.type,p.value]));
  return {year:+parts.year,month:+parts.month,day:+parts.day,hour:+parts.hour,minute:+parts.minute,second:+parts.second,
    weekday:['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(parts.weekday)};
};
const offsetAt=(ms,timeZone)=>{const p=zoneParts(ms,timeZone);return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-Math.floor(ms/1000)*1000;};
/** UTC instant of local midnight on a calendar date, DST-aware (two-pass offset correction). */
function localMidnight(year,month,day,timeZone){
  const wall=Date.UTC(year,month-1,day);
  let instant=wall-offsetAt(wall,timeZone);
  instant=wall-offsetAt(instant,timeZone);
  return instant;
}
/**
 * Calendar period containing `ms` in `timeZone`: weeks start Monday 00:00
 * local time, months on the 1st, years on 1 January. Returns UTC instants.
 */
export function periodWindow(ms,period,timeZone='UTC'){
  if(!Number.isSafeInteger(ms)||!validTimeZone(timeZone)||!['week','month','year'].includes(period))throw new SettingsError('INVALID_PERIOD');
  const p=zoneParts(ms,timeZone);
  let start,end;
  if(period==='week'){
    const back=(p.weekday+6)%7,first=new Date(Date.UTC(p.year,p.month-1,p.day-back)),next=new Date(Date.UTC(p.year,p.month-1,p.day-back+7));
    start=localMidnight(first.getUTCFullYear(),first.getUTCMonth()+1,first.getUTCDate(),timeZone);
    end=localMidnight(next.getUTCFullYear(),next.getUTCMonth()+1,next.getUTCDate(),timeZone);
  }else if(period==='month'){
    start=localMidnight(p.year,p.month,1,timeZone);
    end=p.month===12?localMidnight(p.year+1,1,1,timeZone):localMidnight(p.year,p.month+1,1,timeZone);
  }else{start=localMidnight(p.year,1,1,timeZone);end=localMidnight(p.year+1,1,1,timeZone);}
  return Object.freeze({start,end});
}
