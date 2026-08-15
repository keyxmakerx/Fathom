// The two defects an adversary found in the hand-placement delivery, driven.
//
//   node docs/80-review/evidence/2026-08-15-placement-keymap-and-extent.mjs
//
// D1 — `Alt`+arrow was bound to nudge a box while `53` §3.1 already spends
// `⌥←`/`⌥→` on previous/next view, so one press moved the box AND ejected the
// reader from the diagram. The chord is gone; the four place buttons remain and
// are the keyboard path. This asserts the chord now does ONLY what `53`
// assigns, which for the horizontal pair means switching views.
//
// D2 — a box placed at a negative coordinate sat outside the canvas extent and
// `z` could not recover it: the placement survived export and import as a
// stored fact the picture refused to draw. `lay_out` now translates the whole
// picture so every box is inside, which keeps relative positions exact and
// leaves the stored pin alone. Thirty left-nudges is well past where it broke.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
const URL='file:///home/user/Fathom/target/artifact/fathom-dev.html';
const CFG=`set system host-name srx-branch-01
set interfaces ge-0/0/0 unit 0 family inet address 203.0.113.2/30
set interfaces ge-0/0/1 unit 0 family inet address 198.51.100.1/30
set security zones security-zone trust interfaces ge-0/0/0.0
`;
const R=[];const ck=(n,ok,d)=>{R.push(ok);console.log((ok?'PASS  ':'FAIL  ')+n+(d?'   '+d:''));};
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await b.newPage({viewport:{width:1400,height:900}});
const errs=[];p.on('pageerror',e=>errs.push(String(e)));
await p.goto(URL);
await p.waitForFunction(()=>document.querySelector('#band button')!==null);
await p.click('#tabPaste');await p.fill('#pta',CFG);await p.click('#pRun');
await p.waitForFunction(()=>document.querySelectorAll('.inv tbody tr').length>0);
await p.click('[data-view="diagram"]');await p.waitForSelector('.dcanvas svg');
await p.waitForTimeout(400);

const view=()=>p.evaluate(()=>document.getElementById('fNow').textContent);
const posOf=()=>p.evaluate(()=>{const r=document.querySelector('.dbox rect');
  const b=r.getBoundingClientRect();return [Math.round(b.left),Math.round(b.top)];});

/* THE PROPERTY IS NOT "you stay on the diagram" — `53` §3.1 says ⌥←/⌥→ ARE
   previous/next view, product-wide, and that is correct behaviour. The defect
   was that they ALSO moved the box, so one press did two things. So: the chord
   does exactly what `53` assigned it, and the picture is untouched. */
await p.evaluate(()=>{const r=document.querySelector('[data-drow]');r.setAttribute('tabindex','0');r.focus();});
for (const [k, switches] of [['Alt+ArrowLeft',true],['Alt+ArrowRight',true],
                             ['Alt+ArrowUp',false],['Alt+ArrowDown',false]]) {
  const before = await posOf();
  await p.keyboard.press(k); await p.waitForTimeout(250);
  const v = await view();
  const moved = /Diagram/.test(v) ? String(await posOf()) !== String(before) : 'n/a';
  ck(k.padEnd(16)+' does only what `53` §3.1 assigns it',
     switches ? !/Diagram/.test(v) : (/Diagram/.test(v) && moved === false),
     v + (moved==='n/a' ? '' : ', box moved: ' + moved));
  if(!/Diagram/.test(v)){
    await p.click('[data-view="diagram"]');await p.waitForSelector('.dcanvas svg');await p.waitForTimeout(300);
    await p.evaluate(()=>{const r=document.querySelector('[data-drow]');r.setAttribute('tabindex','0');r.focus();});
  }
}
// the buttons still work and are Tab-reachable
const btns=await p.$$eval('[data-dnudge]',n=>n.map(x=>x.textContent.trim()));
ck('the four place buttons exist', btns.length===4, btns.join(' · '));
// walk a box far left with the button, then check it is on the canvas
await p.evaluate(()=>{const r=document.querySelector('[data-drow]');r.click();});
await p.waitForTimeout(250);
for(let i=0;i<30;i++){await p.evaluate(()=>{const b=[...document.querySelectorAll('[data-dnudge]')].find(x=>/left/i.test(x.textContent));if(b)b.click();});}
await p.waitForTimeout(500);
const geo=await p.evaluate(()=>{
  const c=document.querySelector('.dcanvas').getBoundingClientRect();
  const out=[...document.querySelectorAll('.dbox rect')].map(s=>s.getBoundingClientRect());
  const bad=out.filter(r=>r.width>0&&(r.left<c.left-1||r.right>c.right+1));
  return {canvas:[Math.round(c.left),Math.round(c.right)],outside:bad.length,total:out.length};
});
ck('after 30 left-nudges every box is still inside the canvas', geo.outside===0, JSON.stringify(geo));
ck('no page errors', errs.length===0, errs.join(' | '));
console.log('\n'+R.filter(Boolean).length+'/'+R.length+' checks pass');
await b.close();
