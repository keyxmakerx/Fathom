// How much of the window the picture actually gets, at seven viewports.
//
//   node docs/80-review/evidence/2026-08-15-diagram-width-sweep.mjs
//
// THE DEFECT THIS MEASURES. Three caps stacked to leave the canvas 424 CSS px
// wide ON EVERY MONITOR: `--sheet: 1180px` (a text measure, `2 × 72ch` mono),
// the ledger's 62/38 split, and the Outline's fixed 18rem. A 59-object estate
// auto-fitted to 0.34x with 118 labels off, and no amount of zooming fixed it
// because it was a layout problem wearing a renderer problem's clothes.
//
// After: 424 -> 1414 at 2560x1440, and fit-zoom 0.34x -> 1.22x.
//
// REJECTED, AND RECORDED BECAUSE IT LOOKED RIGHT: collapsing the meaning column
// while nothing is selected buys another ~400px, and it means SELECTING A BOX
// RESIZES THE PICTURE. `56` §11 row 6 predicts that cost, and driving it broke
// three checks in the surface suite at once. One stable split; nothing moves.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const URL='file:///home/user/Fathom/target/artifact/fathom-dev.html';
function cfg(n){const L=['set system host-name srx-branch-01'];
 for(let i=0;i<n;i++){L.push(`set interfaces ge-0/0/${i} unit 0 family inet address 10.${i}.0.1/30`);
 L.push(`set security zones security-zone z${i} interfaces ge-0/0/${i}.0`);}
 return L.join('\n')+'\n';}
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const errs=[];
async function at(w,h,label){
  const p=await b.newPage({viewport:{width:w,height:h}});
  p.on('pageerror',e=>errs.push(label+': '+e));
  await p.goto(URL);
  await p.waitForFunction(()=>document.querySelector('#band button')!==null);
  await p.click('#tabPaste');await p.fill('#pta',cfg(12));await p.click('#pRun');
  await p.waitForFunction(()=>document.querySelectorAll('.inv tbody tr').length>0);
  await p.click('[data-view="diagram"]');
  await p.waitForSelector('.dcanvas svg',{state:'attached'});
  await p.waitForTimeout(500);
  // open the picture if this width hides it
  const opened = await p.evaluate(()=>{const b=document.querySelector('[data-dexpand]');
    if(b&&b.getAttribute('aria-expanded')!=='true'){b.click();return true;}return false;});
  if(opened) await p.waitForTimeout(500);
  const m=await p.evaluate(()=>{
    const c=document.querySelector('.dcanvas'), o=document.querySelector('.dout');
    const cr=c?c.getBoundingClientRect():{width:0,height:0};
    const or=o?o.getBoundingClientRect():{width:0,height:0};
    const z=document.querySelector('.dzoom');
    const se=document.scrollingElement;
    const shapes=[...document.querySelectorAll('.dbox rect')];
    const inside=shapes.filter(s=>{const r=s.getBoundingClientRect();
      return r.width>0&&r.left>=cr.left-1&&r.right<=cr.right+1&&r.top>=cr.top-1&&r.bottom<=cr.bottom+1;}).length;
    return {canvas:[Math.round(cr.width),Math.round(cr.height)],
            outline:[Math.round(or.width),Math.round(or.height)],
            zoom:z?z.textContent.trim():'?',
            boxesInCanvas:inside+'/'+document.querySelectorAll('.dbox').length,
            hscroll:se.scrollWidth>se.clientWidth+1};
  });
  console.log(label.padEnd(12)+' canvas '+String(m.canvas[0]+'x'+m.canvas[1]).padEnd(11)+
    ' outline '+String(m.outline[0]+'x'+m.outline[1]).padEnd(11)+
    ' zoom '+m.zoom.padEnd(7)+' boxes '+m.boxesInCanvas.padEnd(7)+
    (m.hscroll?' HSCROLL':''));
  await p.close();
  return m;
}
console.log('viewport      canvas       outline      zoom     boxes');
for(const [w,h,l] of [[2560,1440,'2560x1440'],[1920,1080,'1920x1080'],[1400,900,'1400x900'],
                      [1100,800,'1100x800'],[430,932,'iPhone 430'],[390,844,'iPhone 390'],[320,800,'320x800']])
  await at(w,h,l);
console.log('\npage errors: '+errs.length+(errs.length?'\n'+errs.join('\n'):''));
await b.close();
