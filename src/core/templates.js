import {node,uid} from './schema.js';
export const THEMES=[
 {name:'Lavender haze',primary:'#7560d5',secondary:'#ece7fb',ink:'#2c2546',paper:'#fdfcfa',muted:'#938ba3'},
 {name:'Forest journal',primary:'#376d58',secondary:'#e5eee7',ink:'#203b32',paper:'#fbfcf7',muted:'#7e9487'},
 {name:'Coastal blue',primary:'#3274c7',secondary:'#e6f0fc',ink:'#18304e',paper:'#fafcfe',muted:'#8297b0'},
 {name:'Peach & paper',primary:'#cf7154',secondary:'#f8e8e0',ink:'#493027',paper:'#fffcf7',muted:'#ad9083'},
 {name:'Midnight',primary:'#b2a1fc',secondary:'#353045',ink:'#f3edf9',paper:'#211d2c',muted:'#b3a6c7'},
 {name:'Electric violet',primary:'#7452ff',secondary:'#efebff',ink:'#241b42',paper:'#ffffff',muted:'#9085ab'}
];
function builder(store){let order=0;return(type,parent,x,y,w,h,values={})=>store.add(node(type,{parent,x,y,w,h,order:++order,...values}));}
export function seedProject(store){
 let frames=[];
 store.transact('Create sample project',()=>{
 store.add({entity:'project',name:'Serein · Wellness app',description:'A little space for yourself. Three editable screens, one calm experience.',theme:'Lavender haze',device:'mobile',deleted:false},'project');
 const a=builder(store),t=THEMES[0],W=360,H=744;
 const f=(name,x,bg=t.paper)=>{const id=a('frame','',x,0,W,H,{name,fill:bg,radius:18,clip:true});frames.push(id);return id;};
 const txt=(p,x,y,w,h,text,size=16,values={})=>a('text',p,x,y,w,h,{text,fontSize:size,fill:'transparent',color:t.ink,...values});
 const ic=(p,x,y,name,size=22,color=t.ink)=>a('icon',p,x,y,size,size,{icon:name,color,fill:'transparent'});
 const box=(p,x,y,w,h,fill,radius=16,values={})=>a('rect',p,x,y,w,h,{fill,radius,...values});
 const status=p=>{txt(p,26,15,55,20,'9:41',12,{fontWeight:600});ic(p,277,17,'wifi',15);ic(p,300,15,'battery',20);};
 const nav=(p,active)=>{box(p,0,674,360,70,t.paper,0);box(p,22,674,316,1,'#ede9f1',0);[['home','Today'],['grid','Explore'],['user','You']].forEach(([i,n],j)=>{ic(p,56+j*111,690,i,22,j===active?t.primary:t.muted);txt(p,33+j*111,717,68,17,n,10,{align:'center',color:j===active?t.primary:t.muted});});};
 const home=f('01 · A calmer everyday',0);status(home);
 txt(home,24,60,215,38,'serein',29,{fontFamily:'Georgia',fontWeight:400});box(home,298,62,38,38,'#f0edf4',19);ic(home,307,71,'bell',20);
 txt(home,24,108,300,23,'Good morning, Alex',14,{color:t.muted});
 box(home,22,148,316,247,t.secondary,22);
 txt(home,43,170,260,16,'A LITTLE SPACE FOR YOURSELF',9,{fontWeight:600,letterSpacing:1.1,color:t.primary});
 txt(home,43,201,266,85,'Make room for\na calmer you.',31,{fontFamily:'Georgia',lineHeight:1.18});
 a('ellipse',home,247,207,42,42,{fill:'#f5cf86'});
 a('path',home,23,271,314,125,{path:'M 0 95 Q 55 12 121 63 Q 180 108 249 25 Q 285 -5 314 25 L 314 125 L 0 125 Z',fill:'#d4c9f0'});
 a('path',home,23,292,314,103,{path:'M 0 57 Q 90 97 158 32 Q 222 -6 314 59 L 314 103 L 0 103 Z',fill:'#aa99d5'});
 a('path',home,23,335,314,61,{path:'M 0 30 Q 73 -15 150 40 Q 221 77 314 18 L 314 61 L 0 61 Z',fill:'#7967a7'});
 box(home,42,341,104,31,'#ffffff',16);ic(home,52,348,'play',15,t.primary);txt(home,74,349,66,17,'3 min reset',10,{color:t.primary,fontWeight:500});
 txt(home,24,421,230,28,'Find your moment',19,{fontWeight:600});txt(home,280,427,58,20,'View all',11,{color:t.primary});
 box(home,22,465,151,133,'#ecf0e8',17);ic(home,40,481,'leaf',26,'#64845c');txt(home,40,527,115,28,'Find focus',16,{fontWeight:600});txt(home,40,554,115,20,'Be here, now',11,{color:'#7a8c74'});
 box(home,187,465,151,133,'#f7eee1',17);ic(home,205,481,'moon',26,'#b28b55');txt(home,205,527,115,28,'Sleep better',16,{fontWeight:600});txt(home,205,554,115,20,'Rest comes first',11,{color:'#a0896b'});
 const start=a('button',home,22,620,316,44,{text:'Begin a moment     →',fill:t.primary,color:'#ffffff',radius:12,fontSize:13,fontWeight:500,align:'center',verticalAlign:'middle',name:'Begin a moment'});nav(home,0);
 const explore=f('02 · Find your moment',426);status(explore);
 txt(explore,24,66,290,43,'Your kind of calm.',28,{fontFamily:'Georgia'});txt(explore,24,113,310,26,'Small moments. A meaningful difference.',12,{color:t.muted});
 a('input',explore,22,157,316,43,{text:'Search sessions, sounds…',color:'#9e96ac',fill:'#f2eff6',radius:12,fontSize:12});
 [['For you',80,true],['Meditation',95,false],['Sleep',66,false]].forEach(([s,w,active],i)=>a('button',explore,[22,112,217][i],219,w,33,{text:s,fill:active?t.primary:'#efebf5',color:active?'#ffffff':t.muted,radius:17,fontSize:11,align:'center',verticalAlign:'middle'}));
 box(explore,22,275,316,194,'#eae5f6',19);a('ellipse',explore,203,302,97,97,{fill:'#d2c7e9'});a('ellipse',explore,216,315,71,71,{fill:'#b8a7d5'});a('ellipse',explore,231,330,41,41,{fill:'#8e79b3'});
 txt(explore,42,298,150,22,'FEATURED SESSION',9,{letterSpacing:1.2,color:t.primary,fontWeight:600});txt(explore,42,333,158,60,'A softer\nstart.',27,{fontFamily:'Georgia',lineHeight:1.15});txt(explore,42,418,176,22,'Breathwork  ·  5 min',11,{color:'#8e80a6'});ic(explore,286,418,'play',23,t.primary);
 txt(explore,24,496,280,29,'Made for your day',18,{fontWeight:600});
 const rows=[['sun','Morning clarity','8 min · Meditation','#f6ead5','#b29154'],['headphones','Deep focus','20 min · Soundscape','#e5ebe3','#74876d']];
 rows.forEach(([i,s,sub,fill,color],j)=>{const y=539+j*64;box(explore,22,y,48,48,fill,12);ic(explore,34,y+12,i,24,color);txt(explore,83,y+3,200,24,s,13,{fontWeight:600});txt(explore,83,y+26,200,20,sub,11,{color:t.muted});ic(explore,310,y+17,'chevron',16,t.muted);});nav(explore,1);
 const session=f('03 · Take a breath',852,'#eee9f7');status(session);ic(session,24,70,'back',22);txt(session,103,72,154,23,'YOUR DAILY PAUSE',10,{align:'center',letterSpacing:1.4,color:'#8e7ea7'});ic(session,310,70,'more',23);
 txt(session,30,141,300,48,'Come back to you.',28,{fontFamily:'Georgia',align:'center'});txt(session,30,194,300,26,'Let the outside world wait a little.',12,{align:'center',color:'#9b8faf'});
 for(let i=0;i<6;i++)a('ellipse',session,139,269,82,162,{fill:['#d5c8ef','#cabbE8','#bfaadd','#b19bce','#c4b2df','#ddcff0'][i],rotation:i*60,opacity:.83});
 a('ellipse',session,144,312,72,72,{fill:'#f8f5fc'});txt(session,132,336,96,25,'breathe in',12,{align:'center',color:'#8c75ab'});
 txt(session,30,486,300,24,'A softer start',18,{fontWeight:500,align:'center'});txt(session,30,520,300,22,'with Jamie Ellis',11,{color:'#9b8faf',align:'center'});
 box(session,40,573,280,3,'#dcd2e9',2);box(session,40,573,104,3,'#9f87c0',2);txt(session,40,588,80,20,'1:42',10,{color:'#9682ae'});txt(session,240,588,80,20,'5:00',10,{color:'#9682ae',align:'right'});
 const play=a('button',session,149,624,62,62,{text:'▶',fill:'#84709f',color:'#ffffff',radius:31,fontSize:19,align:'center',verticalAlign:'middle',action:'toggle',name:'Play / pause'});ic(session,81,644,'back',21,'#a18daf');ic(session,258,644,'arrow',21,'#a18daf');txt(session,30,706,300,18,'One breath at a time.',10,{align:'center',color:'#a598b6'});
 store.set(start,{action:'navigate',target:session,trigger:'click',transition:'fade',duration:250});
 a('hotspot',home,277,418,64,29,{name:'Explore all sessions',fill:'transparent',action:'navigate',target:explore});
 a('hotspot',home,132,678,94,65,{name:'Explore tab',fill:'transparent',action:'navigate',target:explore});
 a('hotspot',explore,22,275,316,194,{name:'Open featured session',fill:'transparent',action:'navigate',target:session,transition:'slide'});
 a('hotspot',explore,18,678,98,65,{name:'Today tab',fill:'transparent',action:'navigate',target:home});
 a('hotspot',session,16,61,42,42,{name:'Back to explore',fill:'transparent',action:'navigate',target:explore,transition:'fade'});
 store.set('project',{startFrame:home});
 });store.undoStack=[];return frames;
}
export function insertComponent(store,kind,parent='',x=40,y=40,theme=THEMES[0]){
 let root;store.transact('Insert '+kind,()=>{const a=builder(store),t=theme;const tx=(p,x,y,w,h,text,fontSize=14,extra={})=>a('text',p,x,y,w,h,{text,fontSize,fill:'transparent',color:t.ink,...extra});
 if(kind==='button')root=a('button',parent,x,y,210,48,{text:'Get started',fill:t.primary,color:'#ffffff',radius:12,align:'center',verticalAlign:'middle',fontSize:14,fontWeight:600});
 else if(kind==='input')root=a('input',parent,x,y,270,48,{text:'Enter your email',fill:'#ffffff',color:'#948e9f',stroke:'#dad6e3',strokeWidth:1,radius:10,fontSize:13});
 else if(kind==='text')root=tx(parent,x,y,270,50,'A new perspective.',25,{fontWeight:600});
 else if(kind==='badge')root=a('button',parent,x,y,100,30,{text:'New release',fill:t.secondary,color:t.primary,radius:15,fontSize:11,align:'center',verticalAlign:'middle'});
 else if(kind==='card'){root=a('group',parent,x,y,280,184,{name:'Feature card',fill:'transparent'});a('rect',root,0,0,280,184,{fill:t.secondary,radius:18});a('icon',root,22,20,30,30,{icon:'sparkle',fill:'transparent',color:t.primary});tx(root,22,74,236,30,'Something wonderful',18,{fontWeight:600});tx(root,22,112,234,45,'Make space for your next big idea.\nEvery detail is yours to change.',12,{color:t.muted});}
 else if(kind==='toggle'){root=a('group',parent,x,y,220,42,{name:'Toggle setting',fill:'transparent'});tx(root,0,10,160,26,'Notifications',14);a('rect',root,168,6,48,28,{fill:t.primary,radius:14});a('ellipse',root,191,9,22,22,{fill:'#ffffff'});}
 else if(kind==='avatar'){root=a('ellipse',parent,x,y,56,56,{name:'Avatar',fill:t.secondary});a('icon',root,15,15,26,26,{icon:'user',fill:'transparent',color:t.primary});}
 else if(kind==='navigation'){root=a('group',parent,x,y,316,65,{name:'Bottom navigation',fill:'transparent'});a('rect',root,0,0,316,65,{fill:'#ffffff',radius:12,stroke:'#eeeaf3',strokeWidth:1});[['home','Home'],['grid','Discover'],['user','Profile']].forEach(([i,s],j)=>{a('icon',root,42+j*108,10,22,22,{icon:i,fill:'transparent',color:j===0?t.primary:t.muted});tx(root,17+j*108,39,76,20,s,10,{align:'center',color:t.muted});});}
 else if(kind==='chart'){root=a('group',parent,x,y,280,170,{name:'Activity chart',fill:'transparent'});a('rect',root,0,0,280,170,{fill:'#ffffff',stroke:'#ede9f3',strokeWidth:1,radius:16});tx(root,18,15,240,26,'Weekly activity',15,{fontWeight:600});[58,78,40,93,70,105,85].forEach((h,i)=>a('rect',root,24+i*34,145-h,18,h,{fill:i===5?t.primary:t.secondary,radius:5}));}
 else if(kind==='checkbox'){root=a('group',parent,x,y,230,32,{name:'Checkbox',fill:'transparent'});a('rect',root,0,4,22,22,{fill:t.primary,radius:5});a('icon',root,3,7,16,16,{icon:'check',fill:'transparent',color:'#ffffff'});tx(root,34,4,194,26,'I agree to the terms',13);}
 else if(kind==='modal'){root=a('group',parent,x,y,300,210,{name:'Confirmation dialog',fill:'transparent'});a('rect',root,0,0,300,210,{fill:'#ffffff',stroke:'#e6e0f0',strokeWidth:1,radius:20,shadow:true});tx(root,24,24,252,32,'Ready to begin?',21,{fontWeight:600});tx(root,24,72,250,55,'Your next chapter is one small\nstep away.',14,{color:t.muted});a('button',root,24,149,252,40,{text:'Let’s do this',fill:t.primary,color:'#ffffff',radius:10,fontSize:13,align:'center',verticalAlign:'middle'});}
 else root=a('rect',parent,x,y,160,100,{fill:t.secondary,radius:12});
 });return root;
}
export function blankFrame(store,device='mobile',x=0,y=0){const[w,h]=device==='desktop'?[1440,900]:device==='tablet'?[834,1112]:[360,744];return store.add(node('frame',{x,y,w,h,name:device[0].toUpperCase()+device.slice(1)+' screen',fill:'#ffffff',radius:device==='mobile'?18:0}));}
/** Local, deterministic layout composer. Explicitly not a learned model. */
export function composeScreens(store,prompt,{device='mobile',theme=THEMES[0],count=3,x=0}={}){
 const p=prompt.toLowerCase(),kind=/shop|store|commerce|product/.test(p)?'shop':/finance|bank|money|budget/.test(p)?'finance':/travel|hotel|trip/.test(p)?'travel':/task|project|dashboard|saas/.test(p)?'work':/food|recipe|restaurant/.test(p)?'food':'wellness';
 const content={shop:['The everyday edit.','Thoughtfully made, just for you.','New arrivals','Your collection','View collection'],finance:['Your money, in balance.','A clearer picture of your everyday.','Total balance','Recent activity','View insights'],travel:['Somewhere new awaits.','Find your next favorite place.','Featured escapes','Explore places','Plan a journey'],work:['Make good work happen.','Everything you need, in one place.','Your workspace','This week','Create a project'],food:['A little taste of happy.','Fresh inspiration for every day.','Today’s favorites','Good things cooking','Explore recipes'],wellness:['A softer kind of day.','More space for what matters.','Your daily pause','Find your moment','Take a moment']}[kind];
 const frames=[];store.transact('Compose screens',()=>{const a=builder(store),t=theme;for(let i=0;i<count;i++){const id=blankFrame(store,device,x+i*(device==='desktop'?1520:device==='tablet'?914:430),0);frames.push(id);store.set(id,{name:['Welcome','Discover','Details'][i%3]+' · '+kind,fill:t.paper});const f=store.get(id),pad=device==='mobile'?24:48,cw=f.w-pad*2;
 a('text',id,pad,40,cw,34,{text:(prompt.trim().split(/\s+/).slice(0,3).join(' ')||'New idea').slice(0,28),fontSize:18,fontWeight:600,fill:'transparent',color:t.primary});
 a('text',id,pad,106,cw,100,{text:i===0?content[0]:content[i+2],fontSize:device==='mobile'?33:48,fontFamily:'Georgia',fill:'transparent',color:t.ink});
 a('text',id,pad,218,cw,45,{text:content[1],fontSize:14,fill:'transparent',color:t.muted});
 a('rect',id,pad,281,cw,190,{fill:t.secondary,radius:20});a('ellipse',id,f.w/2-53,314,106,106,{fill:t.primary,opacity:.18});a('icon',id,f.w/2-23,344,46,46,{icon:{shop:'star',finance:'bolt',travel:'sun',work:'layout',food:'leaf',wellness:'heart'}[kind],color:t.primary,fill:'transparent'});
 a('text',id,pad,497,cw,35,{text:content[3],fontSize:20,fontWeight:600,fill:'transparent',color:t.ink});
 a('text',id,pad,542,cw,42,{text:'Discover something made for you.\nThoughtful details, a better everyday.',fontSize:13,fill:'transparent',color:t.muted});
 a('button',id,pad,f.h-99,cw,48,{name:content[4],text:content[4]+'   →',fill:t.primary,color:t.paper,fontSize:14,fontWeight:600,radius:12,align:'center',verticalAlign:'middle',action:'navigate'});
 }
 for(let i=0;i<frames.length;i++){const btn=store.children(frames[i]).find(n=>n.type==='button');store.set(btn.id,{target:frames[(i+1)%frames.length],transition:'slide',trigger:'click'});}
 });return frames;
}
