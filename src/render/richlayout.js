import {richRuns} from '../core/richtext.js';
const cache = new WeakMap();
export function richFontFamily(value) {
  const families = String(value || 'Inter').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(s => /^[\p{L}\p{N} _-]{1,80}$/u.test(s));
  return (families.length ? families.map(s => ['serif','sans-serif','monospace','cursive','fantasy','system-ui'].includes(s) ? s : '"'+s+'"').join(',') : '"Inter"') + ', ui-sans-serif, system-ui, sans-serif';
}
export function textStyle(node, marks = {}) {
  const size = marks.fontSize || node.fontSize || 16, bold = marks.bold === undefined ? (node.fontWeight || 400) : marks.bold ? 700 : 400;
  return {fontSize:size, fontWeight:bold, fontFamily:marks.fontFamily || node.fontFamily || 'Inter', italic:marks.italic ?? !!node.italic, underline:marks.underline ?? !!node.underline, strike:!!marks.strike, color:marks.color || node.color || '#252236', highlight:marks.highlight || '', link:marks.link || '', font:`${(marks.italic ?? node.italic) ? 'italic ' : ''}${bold} ${size}px ${richFontFamily(marks.fontFamily || node.fontFamily)}`};
}
export function layoutRichText(ctx, node) {
  const key = JSON.stringify([node.text,node.w,node.h,node.type,node.fontSize,node.fontWeight,node.fontFamily,node.italic,node.underline,node.color,node.lineHeight,node.align,node.verticalAlign,node.letterSpacing]);
  const prior = cache.get(node); if (prior?.key === key && prior.state === node.richText) return prior.layout;
  const pad = node.type === 'text' ? 0 : node.type === 'input' ? 15 : 8, max = Math.max(1,node.w-pad*2), lines = [];
  let current = {segments:[],width:0,fontSize:node.fontSize||16};
  const finish = () => { current.height = current.fontSize * (node.lineHeight || 1.35); lines.push(current); current = {segments:[],width:0,fontSize:node.fontSize||16}; };
  const measure = (text,style) => { ctx.font = style.font; if ('letterSpacing' in ctx) ctx.letterSpacing = (node.letterSpacing||0)+'px'; return ctx.measureText(text).width; };
  const append = (text,style,width) => { if (!text) return; const last=current.segments.at(-1); if(last && JSON.stringify(last.style)===JSON.stringify(style)) { last.text+=text; last.width+=width; } else current.segments.push({text,style,width}); current.width+=width;current.fontSize=Math.max(current.fontSize,style.fontSize); };
  for (const run of richRuns(node)) {
    const style = textStyle(node,run.marks), tokens=run.text.replace(/\t/g,'    ').match(/\n|[^\S\n]+|[^\s]+/gu)||[];
    for (const token of tokens) {
      if(token==='\n'){finish();continue;}
      const width=measure(token,style);
      if(current.width+width<=max){append(token,style,width);continue;}
      if(current.width&&token.trim())finish();
      if(width<=max){append(token,style,width);continue;}
      const chars=globalThis.Intl?.Segmenter ? [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(token)].map(s=>s.segment) : [...token];
      for(const char of chars){const w=measure(char,style);if(current.width&&current.width+w>max)finish();append(char,style,w);}
    }
  }
  finish(); const totalHeight=lines.reduce((sum,l)=>sum+l.height,0);
  let y = node.verticalAlign==='middle'||['button','input'].includes(node.type) ? (node.h-totalHeight)/2 : node.verticalAlign==='bottom'?node.h-totalHeight:0;
  for(const line of lines){line.y=y;line.x=node.align==='center'?(node.w-line.width)/2:node.align==='right'?node.w-pad-line.width:pad;let x=line.x;for(const segment of line.segments){segment.x=x;segment.y=y+(line.height-segment.style.fontSize)/2;x+=segment.width;}y+=line.height;}
  const layout={lines,height:totalHeight,pad};cache.set(node,{key,state:node.richText,layout});return layout;
}
export function paintRichText(ctx,node) {
  const layout=layoutRichText(ctx,node);ctx.save();ctx.beginPath();ctx.rect(0,0,node.w,node.h);ctx.clip();ctx.textBaseline='top';ctx.textAlign='left';
  for(const line of layout.lines){if(line.y>node.h||line.y+line.height<0)continue;for(const part of line.segments){const s=part.style;ctx.font=s.font;if('letterSpacing'in ctx)ctx.letterSpacing=(node.letterSpacing||0)+'px';
    if(s.highlight){ctx.fillStyle=s.highlight;ctx.fillRect(part.x,line.y,part.width,line.height);}ctx.fillStyle=s.color;ctx.fillText(part.text,part.x,part.y);
    if(s.underline||s.link)ctx.fillRect(part.x,part.y+s.fontSize+1,part.width,Math.max(1,s.fontSize/16));if(s.strike)ctx.fillRect(part.x,part.y+s.fontSize*.55,part.width,Math.max(1,s.fontSize/16));
  }}ctx.restore();
}
