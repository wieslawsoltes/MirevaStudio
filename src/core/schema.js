import {validateRichText,validateTextOperation} from './richtext.js';
/** Shared, dependency-free validation. Used at every document/network boundary. */
export const FORMAT = 'mireva-studio';
export const VERSION = 1;
export const MAX_RECORDS = 30000;
export const TYPES = ['frame','group','rect','ellipse','text','button','input','image','icon','line','path','hotspot'];
const NUMBERS = new Set(['x','y','w','h','rotation','opacity','radius','strokeWidth','fontSize','fontWeight','lineHeight','letterSpacing','order','gap','padding','delay','duration','createdAt','updatedAt','pathW','pathH','miterLimit']);
const BOOLS = new Set(['deleted','hidden','locked','clip','shadow','italic','underline','resolved','component','checked','layoutWrap']);
const STRINGS = new Set(['entity','type','name','parent','fill','fill2','stroke','color','text','fontFamily','align','verticalAlign','gradient','src','icon','path','layout','layoutAlign','constraintX','constraintY','componentId','description','author','authorId','thread','frame','target','trigger','transition','action','url','theme','device','startFrame','token','category','fillRule','strokeCap','strokeJoin','strokeDash','sourceId','instanceKey','layoutJustify','sizeX','sizeY']);
const ENUMS = {align:['left','center','right'],verticalAlign:['top','middle','bottom'],gradient:['none','horizontal','vertical'],layout:['none','row','column'],layoutAlign:['start','center','end','stretch'],layoutJustify:['start','center','end','space-between'],constraintX:['left','center','right','stretch','scale'],constraintY:['top','center','bottom','stretch','scale'],fillRule:['nonzero','evenodd'],strokeCap:['butt','round','square'],strokeJoin:['miter','round','bevel'],sizeX:['fixed','fill','hug'],sizeY:['fixed','fill','hug']};
const RANGES={fontSize:[1,2048],fontWeight:[1,1000],lineHeight:[.1,20],letterSpacing:[-1000,1000],strokeWidth:[0,2000],radius:[0,20000],pathW:[.000001,1000000],pathH:[.000001,1000000],miterLimit:[1,1000],padding:[0,20000],gap:[-20000,20000],duration:[0,600000],delay:[0,86400000]};
export const FIELDS = new Set([...NUMBERS,...BOOLS,...STRINGS,'richText','transform','gradientStops','overrides','maskPath']);
export const uid = (prefix='n') => `${prefix}_${globalThis.crypto?.randomUUID?.().replaceAll('-','') || Math.random().toString(36).slice(2)+Date.now().toString(36)}`;
export const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
export const compareStamp = (a,b) => !b ? 1 : a[0]-b[0] || (a[1]<b[1] ? -1 : a[1]>b[1] ? 1 : 0);
export const sameStamp = (a,b) => !!a && !!b && a[0]===b[0] && a[1]===b[1];
export function validId(id) { return typeof id==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id) && !['__proto__','constructor','prototype'].includes(id); }
export function validateValues(values) {
  if (!values || Array.isArray(values) || typeof values!=='object') throw Error('Fields must be an object');
  if (Object.keys(values).length>100) throw Error('Too many fields');
  for (const [k,v] of Object.entries(values)) {
    if (!FIELDS.has(k)) throw Error(`Unknown field: ${k}`);
    if (v===null) continue;
    if(ENUMS[k]&&!ENUMS[k].includes(v))throw Error('Invalid style: '+k);
    if(RANGES[k]&&(v<RANGES[k][0]||v>RANGES[k][1]))throw Error('Style value exceeds limits: '+k);
    if(k==='strokeDash'&&(typeof v!=='string'||v.length>1000||v.trim()&&!/^(?:\d+(?:\.\d+)?|\.\d+)(?:[ ,]+(?:\d+(?:\.\d+)?|\.\d+))*$/.test(v.trim())))throw Error('Invalid stroke dash pattern');
    if(k==='richText')validateRichText(v);
    if(k==='transform'&&(!Array.isArray(v)||v.length!==6||v.some(n=>!Number.isFinite(n)||Math.abs(n)>1e9)))throw Error('Invalid affine transform');
    if(k==='gradientStops'&&(!Array.isArray(v)||v.length<2||v.length>32||v.some(s=>!s||!Number.isFinite(s.offset)||s.offset<0||s.offset>1||!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s.color))))throw Error('Invalid gradient stops');
    if(k==='overrides'&&(!Array.isArray(v)||v.length>100||v.some(s=>typeof s!=='string'||s.length>100)))throw Error('Invalid component overrides');
    if(k==='maskPath'&&(typeof v!=='string'||v.length>200000))throw Error('Invalid mask path');
    if (NUMBERS.has(k) && (typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>(['createdAt','updatedAt','order'].includes(k)?Number.MAX_SAFE_INTEGER:1e12))) throw Error(`Invalid number: ${k}`);
    if (BOOLS.has(k) && typeof v!=='boolean') throw Error(`Invalid boolean: ${k}`);
    if (STRINGS.has(k) && (typeof v!=='string'||v.length>(k==='src'?8_000_000:k==='path'?200_000:20_000))) throw Error(`Invalid text: ${k}`);
    if (['w','h'].includes(k) && (v<0.1||v>20000)) throw Error('Dimensions must be 0.1–20,000');
    if (k==='opacity' && (v<0||v>1)) throw Error('Opacity must be 0–1');
    if (k==='type' && !TYPES.includes(v)) throw Error('Unknown element type');
    if (k==='entity' && !['node','project','comment','style'].includes(v)) throw Error('Unknown entity');
    if (['fill','fill2','stroke','color'].includes(k) && !/^(#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})|transparent|none)$/i.test(v)) throw Error('Use a hex color');
    if (k==='src' && v && !/^data:image\/(png|jpeg|webp|gif);base64,[a-zA-Z0-9+/=]+$/.test(v)) throw Error('Images must be embedded PNG, JPEG, WebP, or GIF');
    if (['parent','thread','frame','componentId','target','startFrame'].includes(k) && v && !validId(v)) throw Error(`Invalid reference: ${k}`);
  }
  return values;
}
export function validateOp(op) {
  if(op?.kind==='text')return validateTextOperation(op);
  if (!op||!validId(op.id)||!Array.isArray(op.stamp)||op.stamp.length!==2||!Number.isSafeInteger(op.stamp[0])||op.stamp[0]<0||!validId(op.stamp[1])) throw Error('Malformed operation');
  validateValues(op.values); return op;
}
export function validateSnapshot(s) {
  if (!s||s.format!==FORMAT||s.version!==VERSION||!s.records||typeof s.records!=='object'||Array.isArray(s.records)) throw Error('Not a supported Mireva document');
  if (Object.keys(s.records).length>MAX_RECORDS) throw Error('Document exceeds 30,000 records');
  for (const [id,r] of Object.entries(s.records)) {
    if (!validId(id)||!r||typeof r!=='object'||Array.isArray(r)) throw Error('Invalid record');
    const {id:rid,_stamps,...v} = r;
    validateValues(v);
    if (rid!==id||!_stamps||typeof _stamps!=='object') throw Error('Invalid record metadata');
    for (const k of Object.keys(v)){const st=_stamps[k];if(!Array.isArray(st)||st.length!==2||!Number.isSafeInteger(st[0])||st[0]<0||!validId(st[1]))throw Error('Invalid field stamp');}
  }
  validateHierarchy(s.records); return s;
}
/** Bound acyclic depth, while retaining the deterministic cycle projection used by the CRDT. */
export function validateHierarchy(records){const done=new Map();for(const id of Object.keys(records)){if(done.has(id))continue;const chain=[],seen=new Set();let cur=id;while(records[cur]?.parent&&records[records[cur].parent]&&!done.has(cur)&&!seen.has(cur)){seen.add(cur);chain.push(cur);if(chain.length>128)throw Error('Document hierarchy exceeds 128 levels');cur=records[cur].parent;}let depth=done.get(cur)||0;for(const n of chain.reverse()){depth++;if(depth>128)throw Error('Document hierarchy exceeds 128 levels');done.set(n,depth);}if(!chain.length)done.set(id,0);}return true;}
export function node(type, values={}) {
  const pathDefaults=type==='path'?{pathW:values.pathW||values.w||160,pathH:values.pathH||values.h||100,fillRule:'nonzero',strokeCap:'round',strokeJoin:'round'}:{};
  return {...pathDefaults,entity:'node',type,name:type==='frame'?'Untitled screen':type[0].toUpperCase()+type.slice(1),parent:'',x:0,y:0,w:160,h:100,rotation:0,opacity:1,radius:0,fill:'#ece8ff',fill2:'#c7bcff',gradient:'none',stroke:'#dad7e4',strokeWidth:0,color:'#252236',text:'',fontFamily:'Inter',fontSize:16,fontWeight:400,lineHeight:1.35,letterSpacing:0,align:'left',verticalAlign:'top',order:Date.now(),hidden:false,locked:false,deleted:false,clip:type==='frame',shadow:false,layout:'none',gap:16,padding:16,constraintX:'left',constraintY:'top',...values};
}
