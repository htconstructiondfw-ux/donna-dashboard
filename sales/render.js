const { chromium } = require('playwright'); const path=require('path');
(async()=>{
  const b=await chromium.launch(); const p=await b.newPage();
  for(const f of process.argv.slice(2)){
    await p.goto('file://'+path.resolve(f),{waitUntil:'load'}); await p.waitForTimeout(300);
    await p.pdf({path:f.replace('.html','.pdf'),format:'Letter',printBackground:true,preferCSSPageSize:true});
    console.log('wrote',f.replace('.html','.pdf'));
  }
  await b.close();
})();
