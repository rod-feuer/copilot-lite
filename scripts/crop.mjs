import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({ executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless:"new", args:["--no-sandbox","--force-color-profile=srgb"] });
const p = await b.newPage();
await p.setViewport({ width:1280, height:1100, deviceScaleFactor:2 });
await p.goto("http://localhost:3939/transactions", { waitUntil:"networkidle0" });
// select May and filter to show transfers (excluded) near top by searching "payment"
await p.evaluate(()=>{ const s=[...document.querySelectorAll('select')].find(s=>[...s.options].some(o=>o.value==='2026-05')); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set; set.call(s,'2026-05'); s.dispatchEvent(new Event('change',{bubbles:true})); });
await new Promise(r=>setTimeout(r,900));
await p.evaluate(()=>{ const i=document.querySelector('input[placeholder="Search merchant…"]'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(i,'payment'); i.dispatchEvent(new Event('input',{bubbles:true})); });
await new Promise(r=>setTimeout(r,700));
await p.screenshot({ path:"screenshots/transactions-detail.png" }); // viewport only
console.log("saved screenshots/transactions-detail.png");
await b.close();
